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
/**
 * The instruction the model runs under.
 *
 * `anonymous` changes it materially rather than cosmetically, and that is the point: an anonymous
 * session is not offered `call_api` at all (see tools.toolSchemas), so it can search the catalogue
 * and never invoke anything in it. Telling such a session to "search before saying an API does not
 * exist" sends it hunting for a capability it has no way to use.
 *
 * Measured, on "北京时间是几点？然后用英文怎么说？": five `search_apis` calls, one `list_models`,
 * a long reasoning block, and then a wrong answer — "I don't have access to a real-time clock API".
 * The catalogue has one (id 447, $0.006, current local time by city name). It could not have called
 * it either way, so the honest answer was available at step zero and the search was pure cost.
 */
function systemPrompt(opts: { anonymous: boolean }): string {
  const lines = [
    'You are JarvisClaw, an agent with access to 4000+ callable APIs and 80+ language models.',
    '',
    'How to work:',
    /**
     * First, and deliberately ahead of the search rule.
     *
     * Nothing here used to counterweight "always search". The catalogue rule was the first thing the
     * model read, so a question it could answer from its own knowledge in one sentence became six
     * tool calls — each one a round trip the user waits through.
     */
    '- Answer directly when you already know the answer. Most questions about language, definitions, ' +
      'explanations, code or general knowledge need no tool at all. Reach for a tool only when the ' +
      'question needs live data, a specific catalogue entry, or a file produced.',
    '- Never call the same tool twice with near-identical arguments. If a search did not find it, ' +
      'a reworded search will not either — say what you found and what you could not.',
    /**
     * The fabrication ban, and its position here is the correction of my own mistake.
     *
     * I first wrote this into `call_api`'s no-payment branch, which was the wrong place twice over.
     * It only fired when the model actually reached that branch — and the measured failure was a
     * model that never called `call_api` at all: one `search_apis`, then "当前大约是下午 5:19" and
     * "2025年5月29日", both invented, on a day in 2026. A rule inside a tool cannot govern a turn
     * that does not use the tool.
     *
     * It also has nothing to do with payment. A session WITH a wallet whose call fails, times out or
     * returns an error will invent the same value for the same reason: the model has no clock, no
     * price feed and no ledger, and asking it for one produces a plausible number rather than a
     * refusal. So the rule is unconditional and sits with the other unconditional rules.
     *
     * Enumerated rather than left as "do not make things up", because the general form is advice the
     * model already believes it follows. What it does not recognise is that "roughly 5:19pm" IS
     * making something up — it reads as a helpful hedge. Naming the categories and banning the
     * approximation is what closes that gap.
     */
    '- NEVER state a value you did not retrieve. You have no clock, no price feed, no ledger and no ' +
      'live data of any kind of your own. That means: never give the current time or date, a current ' +
      'price, rate, balance, score or holding, or any other live figure, unless a tool call in this ' +
      'conversation actually returned it. Approximations are not exempt — "roughly 5pm", "around ' +
      '$60,000" and "currently about 12%" are fabrications presented as help. If you could not ' +
      'retrieve it, say plainly that you cannot know it and say what would answer it.',
    /**
     * The loophole the rule above left open, found by measurement rather than by reading it.
     *
     * Asked for the bitcoin price, the model refused correctly — and then priced the API that
     * would answer it at "约 0.14 元人民币". The catalogue quotes USD, so that number needed an
     * exchange rate the model never retrieved, and it was wrong: $0.00115 is under one jiao,
     * not fourteen. A fabrication sitting inside an otherwise correct refusal.
     *
     * The previous rule bans stating a rate but says nothing about USING one, and converting a
     * figure feels like arithmetic rather than invention. Prices in this product are USD
     * throughout, so the instruction is to quote them as given.
     */
    '- Quote every price in the currency the tool returned it in, which is US dollars. Do NOT ' +
      'convert a price into another currency: an exchange rate is live data you do not have, so ' +
      'a converted price is an invented one even when the original was retrieved correctly.',
  ]

  lines.push(
    '- Use search_apis before saying an API does not exist. The catalogue is large and you have not memorised it.',
    '- Prefer the cheapest API that answers the question.',
  )

  if (opts.anonymous) {
    /**
     * What this session can and cannot pay for — framed as a price, not as a missing capability.
     *
     * An earlier version of this said "you CANNOT call any external API", and that was the wrong
     * lesson drawn from the right measurement. Hiding the capability made the model tell the user
     * the product could not do things it can do.
     *
     * Franklin's framing, verified against its live gateway: a walletless request to a paid endpoint
     * gets a 402 carrying the price, not a refusal — so the agent's job is to REPORT the price. That
     * is a useful answer; "I don't have access to a real-time clock API" is a false one.
     */
    lines.push(
      '- This session has no wallet and no API key, so it cannot complete a paid call. You can still ' +
        'look an API up and price it: call_api will return the API name and its exact cost instead of ' +
        'calling. When that happens, tell the user the API exists, what it costs, and that connecting ' +
        'a wallet or signing in unlocks it — then answer whatever part of the question you can ' +
        'yourself. Never tell the user a capability does not exist when it is in the catalogue.',
    )
  }

  lines.push(
    '- Call the tools directly. Do not describe what you are about to do instead of doing it.',
    '- When a tool returns data, answer the question with it. Do not dump raw JSON at the user.',
    '- If a tool result says the user declined a charge, respect it and do not retry that call.',
    // The rule that came from a measured cost: without it, "turn this into speech" burned four paid
    // steps hunting the catalogue and ended in a suggestion to use the browser's own speech API. The
    // page has a Speech button that does it for $0.002.
    `- ${MODALITY_HINT}`,
  )

  return lines.join('\n')
}

/**
 * The non-anonymous prompt, exported for tests and for callers that predate the split.
 *
 * Kept as a constant because it is referenced by name in the test suite; the loop itself uses
 * `systemPrompt(opts)` so the anonymous variant is actually reachable.
 */
export const SYSTEM_PROMPT = systemPrompt({ anonymous: false })

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
  /**
   * For tool-end: a paid call this session had no way to make, with what it would have cost.
   *
   * Surfaced to the UI so the price and the unlock path are stated whether or not the model repeats
   * them. It did not, once: given a price and told to report it, a free-tier model answered with a
   * fabricated timestamp and mentioned neither. The instruction stays, and this is the backstop.
   */
  unpayableCall?: { name: string; id: number; priceUsd: number }
  /** For done: which concrete model answered, since auto/free resolves per request. */
  model?: string
}

export interface AgentOptions extends ToolContext {
  /**
   * Absent credential means the anonymous free tier — see gateway.authHeaders.
   *
   * Reaches the tools too, because `AgentOptions extends ToolContext` and `opts` is passed straight
   * to `tool.run`. That is what lets `call_api` price an API and report the cost rather than being
   * hidden from the session — see the note on tools.toolSchemas.
   */
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
  const prompt = systemPrompt({ anonymous: opts.anonymous })
  if (history.length === 0 || history[0].role !== 'system') {
    history.unshift({ role: 'system', content: prompt })
  } else if (history[0].content !== prompt) {
    /**
     * Replaced when the session's capabilities have changed.
     *
     * Connecting a wallet mid-conversation flips `anonymous`, which changes both the advertised tools
     * and what the prompt says the model may do. Leaving the original in place would tell a
     * now-payment-capable session it cannot call anything — and the tool list would disagree with its
     * own instructions, which is the state models resolve by ignoring the tools.
     */
    history[0] = { role: 'system', content: prompt }
  }
  history.push({ role: 'user', content: userMessage })

  const schemas = toolSchemas({ anonymous: opts.anonymous })
  /**
   * Tool calls already made this message, so a repeat can be answered rather than run.
   *
   * A prompt rule is not enough on its own — measured: five `search_apis` calls for one question,
   * with the instruction to search sitting at the top of the prompt. The model rewords a failed
   * search and tries again, which is reasonable behaviour and produces the same empty result at the
   * cost of another round trip the user waits through.
   *
   * Keyed on the tool plus its normalised arguments, so "current time" and "Current  Time" count as
   * one. Scoped to a single user message: the same search in a later message is a fresh question and
   * the catalogue may genuinely have changed.
   */
  const seen = new Map<string, string>()
  /**
   * Tools this session has proven it cannot pay for.
   *
   * Separate from `seen`, which keys on the arguments: an unpayable tool is unpayable for EVERY set
   * of arguments, so pricing a second API would otherwise be another round trip to the same answer.
   * One priced refusal is informative; five is the behaviour this whole change is fixing.
   */
  const blocked = new Set<string>()
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
      yield* runOneTool(call, history, opts, seen, blocked)
    }
  }

  // Out of turns with the model still asking for tools. Reported rather than silently
  // ending, because a truncated run looks identical to a finished one otherwise.
  yield {
    type: 'error',
    text: `Stopped after ${maxTurns} steps without reaching an answer. Try a narrower question.`,
  }
}

/**
 * A stable key for "this tool, called with these arguments".
 *
 * Arguments arrive as a JSON string assembled from stream fragments, so the same call can differ in
 * key order and whitespace between attempts. Parsing and re-serialising with sorted keys makes those
 * identical; unparseable JSON falls back to the trimmed, lowercased string, which is still a better
 * key than nothing.
 */
function callKey(name: string, rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs || '{}') as Record<string, unknown>
    const norm = Object.keys(parsed)
      .sort()
      .map((k) => {
        const v = parsed[k]
        // Values lowercased and space-collapsed too: a reworded search differs from its predecessor
        // by capitalisation as often as by content, and re-running it returns the same rows.
        return `${k}=${typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : JSON.stringify(v)}`
      })
      .join('&')
    return `${name}(${norm})`
  } catch {
    return `${name}(${rawArgs.trim().toLowerCase()})`
  }
}

async function* runOneTool(
  call: ToolCall,
  history: ChatMessage[],
  opts: AgentOptions,
  seen: Map<string, string>,
  blocked: Set<string>,
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

  /**
   * A repeat is answered from the first result instead of run again.
   *
   * Returning the cached output rather than an error, and that distinction matters: an error invites
   * the model to try a third wording, while the same result plus an explicit note is the information
   * it needs to stop. Measured before this: five searches for one question.
   *
   * The tool-end event reports zero spend because nothing was spent — a paid tool called twice with
   * the same arguments now costs once, which is a correctness property and not only a speed one.
   */
  /**
   * Already established as unpayable this message, whatever the arguments.
   *
   * Answered without a network round trip: the session has no wallet and no key, which is not a fact
   * about the API being asked for, so pricing a second one reaches the same conclusion more slowly.
   */
  if (blocked.has(name)) {
    answer(
      `${name} still cannot be paid for — this session has no wallet and no API key, and that has ` +
        `not changed. Do not call it again. Tell the user what it would cost and that connecting a ` +
        `wallet or signing in unlocks it.`,
    )
    yield { type: 'tool-end', tool: name, spentUsd: 0 }
    return
  }

  const key = callKey(name, call.function.arguments)
  const cached = seen.get(key)
  if (cached !== undefined) {
    answer(
      `${cached}\n\n[This is the identical call you already made this turn — the result has not ` +
        `changed. Do not call ${name} with these arguments again; answer the user with what you have.]`,
    )
    yield { type: 'tool-end', tool: name, spentUsd: 0 }
    return
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
    /**
     * Recorded so an identical repeat is served from here.
     *
     * A DECLINED call is deliberately not recorded. Declining is the user's decision about this
     * moment, not a property of the call — they may approve the same thing a minute later, and
     * caching the refusal would make that impossible without starting a new message.
     */
    if (!res.declined) seen.set(key, res.output)
    // Unpayable is a property of the session, not of these arguments, so it blocks the tool outright
    // rather than only this call. Recorded AFTER the result is answered, so the priced report — the
    // useful part — still reaches the model once.
    if (res.unpayable) blocked.add(name)
    yield {
      type: 'tool-end',
      tool: name,
      result: res.output,
      spentUsd: res.spentUsd,
      declined: res.declined,
      unpayableCall: res.unpayableCall,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const output = `${name} failed: ${message}`
    answer(output)
    // Failures are recorded too. A tool that just failed with these arguments will fail the same way
    // on an immediate retry, and the retry costs the user another wait for the same message.
    seen.set(key, output)
    yield { type: 'tool-end', tool: name, result: output, spentUsd: 0 }
  }
}
