/**
 * The agent loop: one user message in, tool calls and an answer out.
 *
 * The loop's job is to keep going until the model stops asking for tools, while never
 * spending money the user has not approved and never running away with turns.
 */

import { EventQueue } from './eventqueue'
import {
  FREE_MODEL,
  isPaymentRequired,
  paymentChallenge,
  streamChat,
  type ChatMessage,
  type ToolCall,
} from './gateway'
import { ModelRouter } from './route'
import { MODALITY_HINT, tools, toolSchemas, type ToolContext } from './tools'

/**
 * The instruction the model runs under.
 *
 * Two things here are load-bearing rather than stylistic:
 *
 *   - It must NOT say the user will be asked to approve a charge. Telling a model that
 *     a human will confirm makes it narrate the request and stop — it treats "I asked"
 *     as the completed action and never emits the tool call. The confirmation is real,
 *     but it happens outside the model's turn and the model does not need to know.
 *   - It must say to search before concluding an API does not exist. Without that the
 *     model answers from memory about a catalogue it has never seen.
 */
export const SYSTEM_PROMPT = [
  'You are JarvisClaw, an agent with access to 4000+ callable APIs and 80+ language models.',
  '',
  'How to work:',
  '- Use search_apis before saying an API does not exist. The catalogue is large and you have not memorised it.',
  '- Prefer the cheapest API that answers the question.',
  '- Call the tools directly. Do not describe what you are about to do instead of doing it.',
  '- When a tool returns data, answer the question with it. Do not dump raw JSON at the user.',
  '- If a tool result says the user declined a charge, respect it and do not retry that call.',
  // Third bullet-worthy rule, and the one that came from a measured cost: without it, "turn
  // this into speech" burned four paid steps hunting the catalogue and ended in a suggestion
  // to use the browser's own speech API. The page has a Speech button that does it for $0.002.
  `- ${MODALITY_HINT}`,
].join('\n')

export interface AgentEvent {
  type:
    | 'text'
    | 'reasoning'
    | 'tool-start'
    | 'tool-end'
    | 'error'
    | 'done'
    | 'downgrade'
    | 'notice'
    /**
     * Discard whatever text this turn has streamed so far.
     *
     * Needed only because delivery is now live. While events were buffered until the response
     * finished, an attempt that failed mid-stream could simply have its buffer dropped and the
     * user never saw it. Now the words are already on screen, and a retry — a 402 answered with a
     * payment, or a model retired mid-answer — starts the response over from the beginning.
     *
     * Without this the second attempt's text appends to the first's, producing a turn that reads
     * as one answer and is actually two halves of different ones. Silently keeping the first
     * attempt's fragment would be worse: it would look like the model wrote it.
     */
    | 'reset'
  /** For text/reasoning: the increment. For error: the message. */
  text?: string
  /** For tool-start/tool-end. */
  tool?: string
  args?: string
  result?: string
  spentUsd?: number
  declined?: boolean
  /** For done: which concrete model answered, since auto/free resolves per request. */
  model?: string
}

export interface AgentOptions extends ToolContext {
  /** Absent credential means the anonymous free tier — see gateway.authHeaders. */
  anonymous: boolean
  /**
   * Pin one model. Omit to let the router choose and downgrade.
   *
   * A pinned model is never downgraded away from: the user asked for that model, and
   * silently answering from a different one is worse than reporting the failure.
   */
  model?: string
  /**
   * Survives across messages so a model that failed once is not retried first on every
   * subsequent message. Created here if absent, which keeps single-shot callers simple.
   */
  router?: ModelRouter
  /**
   * Pays for one chat call and returns the X-PAYMENT header, or null if the user declined.
   *
   * Injected rather than imported so this module stays free of wallet code: signing needs a
   * browser extension and a user gesture, neither of which belongs in the agent loop. Absent
   * means "cannot pay" — a paid model then reports its price instead of failing.
   */
  payForChat?: (
    challenge: { accepts?: Array<Record<string, unknown>> },
    model: string,
  ) => Promise<string | null>
  /**
   * How many model turns one user message may take.
   *
   * A cap rather than an open loop: a model that keeps calling a failing tool would
   * otherwise burn the free tier's per-IP allowance and, once a wallet exists, real
   * money. Eight is enough for search → detail → call → answer with retries.
   */
  maxTurns?: number
}

const DEFAULT_MAX_TURNS = 8

/**
 * Shown when every free candidate has been tried and none could serve the request.
 *
 * Names the two things the user can actually do. "Something went wrong" would leave them
 * retrying a tier that is genuinely out of capacity.
 */
const EXHAUSTED_MESSAGE =
  'Every free model the gateway offers is unavailable right now. ' +
  'Try again shortly, or add an API key to reach the paid models.'

/**
 * Run one user message to completion, yielding events as they happen.
 *
 * `history` is mutated in place so the caller keeps the full conversation, including
 * the assistant's tool-call turns and their results. Dropping those would make the
 * model re-plan from scratch on the next message and re-run tools it already paid for.
 */
export async function* runAgent(
  history: ChatMessage[],
  userMessage: string,
  opts: AgentOptions,
): AsyncGenerator<AgentEvent> {
  if (history.length === 0 || history[0].role !== 'system') {
    history.unshift({ role: 'system', content: SYSTEM_PROMPT })
  }
  history.push({ role: 'user', content: userMessage })

  const schemas = toolSchemas({ anonymous: opts.anonymous })
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const router =
    opts.model === undefined
      ? (opts.router ?? new ModelRouter({ baseUrl: opts.baseUrl, cred: opts.cred, signal: opts.signal }))
      : undefined

  for (let turn = 0; turn < maxTurns; turn++) {
    /**
     * How many times this turn has called the model.
     *
     * Only used to decide whether an attempt must clear the screen before its first delta. The
     * first attempt has shown nothing yet; a retry — after a 402 paid for, or a model retired
     * mid-answer — has, and its text would otherwise append to the abandoned attempt's.
     */
    let attempts = 0
    let result

    // Downgrade loop. A model that cannot serve the request is retired and the next
    // candidate tried, in place, so one unservable model costs a retry rather than the
    // whole message. Bounded by the candidate list, which is finite and shrinking.
    /**
     * Runs one attempt and forwards its deltas to the caller as they arrive.
     *
     * The generator cannot `yield` from inside `streamChat`'s callback, so the callback pushes into
     * `stream` and this helper drains it — which is what makes the text appear while the request is
     * still open rather than all at once when it closes.
     *
     * The request is NOT awaited before draining. Awaiting it first is the bug this replaces: it
     * completes the whole response before a single token is forwarded. Instead the promise is
     * started, its settlement closes the queue, and the drain finishes when the queue does.
     *
     * `attempt` counts from 1. Anything past the first has already put text on screen, so it emits
     * a `reset` before its own first delta — see AgentEvent['reset'].
     */
    // The return type has no `| undefined`, and that is a guarantee this function must keep: every
    // path either returns the request's value or throws. TypeScript would otherwise force the call
    // sites to handle an absent result that cannot occur, and the natural way to silence that is a
    // non-null assertion — which would then hide a real hole if a future edit added a bare `return`.
    const attemptStream = async function* (
      model: string,
      cred: typeof opts.cred,
      attempt: number,
    ): AsyncGenerator<AgentEvent, Awaited<ReturnType<typeof streamChat>>> {
      const q = new EventQueue<AgentEvent>()
      let first = true
      const request = streamChat(
        { messages: history, model, tools: schemas },
        (delta) => {
          if (attempt > 1 && first && (delta.content || delta.reasoning)) {
            // Emitted on the first real delta rather than before the request, so an attempt that
            // fails before producing anything does not clear text the user is still reading.
            q.push({ type: 'reset' })
          }
          if (delta.content || delta.reasoning) first = false
          if (delta.content) q.push({ type: 'text', text: delta.content })
          if (delta.reasoning) q.push({ type: 'reasoning', text: delta.reasoning })
        },
        { baseUrl: opts.baseUrl, cred, signal: opts.signal },
      )

      /**
       * Settled into a tagged value rather than left to reject.
       *
       * An unhandled rejection here would fire before the drain below reaches it — the promise
       * settles while the consumer is still yielding buffered text — and the browser reports it as
       * an uncaught error even though the code does handle it a few lines later.
       */
      const settled = request.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      // Closing the queue is what ends the drain. `void` because the drain is the thing being
      // awaited; this only needs to run when the request finishes, whichever way it finishes.
      void settled.then((outcome) => (outcome.ok ? q.close() : q.fail(outcome.error)))

      // Errors surface from `settled`, not from here, so a failed stream still delivers the text it
      // produced before dying. Dropping that would take words off the screen the user has read.
      try {
        yield* q.drain()
      } catch {
        // Swallowed deliberately: `q.fail` re-raises the request's own error, and it is handled by
        // the caller through `settled` below with the full context of which attempt failed.
      }

      const outcome = await settled
      if (!outcome.ok) throw outcome.error
      return outcome.value
    }

    for (;;) {
      const model = opts.model ?? (await router!.current())
      if (model === undefined) {
        // Reached when a previous message already exhausted the list, so no attempt is
        // made this time.
        yield { type: 'error', text: EXHAUSTED_MESSAGE }
        return
      }

      attempts += 1
      try {
        result = yield* attemptStream(model, opts.cred, attempts)
        break
      } catch (err) {
        // A 402 is a price, not a failure. Handled before the downgrade logic because a
        // paid model answering 402 is working exactly as intended — retiring it as
        // "unavailable" and falling back to a free model would silently give the user a
        // different model than the one they picked.
        //
        // Without this the raw challenge JSON was rendered into the transcript: a wall of
        // `accepts`, `payTo` and base64 where a price should be. It read as a broken app.
        const challenge = paymentChallenge(err)
        if (challenge !== null) {
          if (opts.payForChat === undefined) {
            yield {
              type: 'notice',
              text: `${model} is a paid model. Connect a wallet to use it, or pick a free one — ${FREE_MODEL} always works without payment.`,
            }
            return
          }
          const paid = await opts.payForChat(challenge, model)
          if (paid === null) {
            yield { type: 'notice', text: 'Payment cancelled — nothing was charged.' }
            return
          }
          // Retried once with the signature, on the same model. Not looped: a second 402
          // means the payment was refused, and re-signing would ask the user to authorise
          // another transfer for a call that already failed to settle.
          try {
            attempts += 1
            result = yield* attemptStream(model, { ...opts.cred, payment: paid }, attempts)
            break
          } catch (payErr) {
            yield {
              type: 'error',
              text: isPaymentRequired(payErr)
                ? 'The gateway did not accept the payment. Check the wallet has USDC on Base.'
                : payErr instanceof Error
                  ? payErr.message
                  : String(payErr),
            }
            return
          }
        }

        // A pinned model is reported, never swapped: the user chose it.
        const outcome = router ? await router.markFailed(model, err) : 'not-a-model-problem'

        if (outcome === 'not-a-model-problem') {
          // A rate limit, a network failure or a bad credential. Reported verbatim,
          // because the gateway's own words are more useful than anything paraphrased
          // here — and none of it says the model is gone.
          yield { type: 'error', text: err instanceof Error ? err.message : String(err) }
          return
        }

        // Surfaced rather than silent. A downgrade changes which model answered, and
        // hiding that makes an unexplained quality drop look like the model got worse.
        yield { type: 'downgrade', text: `${model} is unavailable — trying another free model.` }

        if (outcome === 'exhausted') {
          yield { type: 'error', text: EXHAUSTED_MESSAGE }
          return
        }
      }
    }
    // No `yield* pending` here any more. The text was forwarded by `attemptStream` while the
    // request was open, which is the whole point of this shape.

    history.push({
      role: 'assistant',
      content: result.content,
      ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
    })

    if (result.toolCalls.length === 0) {
      yield { type: 'done', model: result.model }
      return
    }

    for (const call of result.toolCalls) {
      yield* runOneTool(call, history, opts)
    }
  }

  // Out of turns with the model still asking for tools. Reported rather than silently
  // ending, because a truncated run looks identical to a finished one otherwise.
  yield {
    type: 'error',
    text: `Stopped after ${maxTurns} steps without reaching an answer. Try a narrower question.`,
  }
}

async function* runOneTool(
  call: ToolCall,
  history: ChatMessage[],
  opts: AgentOptions,
): AsyncGenerator<AgentEvent> {
  const name = call.function.name
  const tool = tools[name]

  yield { type: 'tool-start', tool: name, args: call.function.arguments }

  // Every branch below must push a tool message with this call's id. An assistant turn
  // carrying tool_calls whose ids are not all answered is rejected by the API on the
  // next request, so an unanswered call breaks the whole conversation rather than just
  // that step.
  const answer = (output: string) => {
    history.push({ role: 'tool', tool_call_id: call.id, name, content: output })
  }

  if (!tool) {
    const output = `No tool named "${name}" exists. Available: ${Object.keys(tools).join(', ')}.`
    answer(output)
    yield { type: 'tool-end', tool: name, result: output, spentUsd: 0 }
    return
  }

  let args: Record<string, unknown> = {}
  if (call.function.arguments.trim() !== '') {
    try {
      const parsed = JSON.parse(call.function.arguments)
      if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>
    } catch {
      // Told to the model rather than thrown: a malformed argument string is something
      // it can fix on the next turn, and failing the run would waste the whole message.
      const output = `The arguments for ${name} were not valid JSON. Send them again as a JSON object.`
      answer(output)
      yield { type: 'tool-end', tool: name, result: output, spentUsd: 0 }
      return
    }
  }

  try {
    const res = await tool.run(args, opts)
    answer(res.output)
    yield {
      type: 'tool-end',
      tool: name,
      result: res.output,
      spentUsd: res.spentUsd,
      declined: res.declined,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const output = `${name} failed: ${message}`
    answer(output)
    yield { type: 'tool-end', tool: name, result: output, spentUsd: 0 }
  }
}
