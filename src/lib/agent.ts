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
    'You are JarvisClaw, an agent with access to 2,400+ callable APIs and 280+ language models.',
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
     * The biggest single latency win available, and it is not about tool calls at all.
     *
     * Measured against the gateway on "解释一下 GIL": the model emits its first REASONING frame at
     * 1.3-1.8s and its first CONTENT frame at 23-91s, because it writes 3,000-7,500 characters of
     * deliberation first. The stream was never the problem — frames arrive the whole time — the
     * user is waiting on the model to stop thinking.
     *
     * With this rule: reasoning drops to a median of 213 characters and first content to 12.7s,
     * from 3,716 characters and 77s. Same model, same question, three runs each.
     *
     * `reasoning_effort: 'low'` was tried first and is weaker (572 chars / 35.9s) — it is also not
     * honoured uniformly across the free pool, while a system rule reaches every model.
     */
    '- Think briefly. A short plan is enough; do not deliberate at length before answering. Long ' +
      'deliberation is the single largest thing the user waits through, and on a question you can ' +
      'answer directly it buys nothing.',
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
    /**
     * The round trip this used to cost, and why it was avoidable.
     *
     * The previous wording told the model to "call_api ... it will return the API name and its
     * exact cost instead of calling". That works, and it is a whole extra turn to learn a price
     * `search_apis` ALREADY returned on the row (`price=$0.001380/call`). Measured on the live
     * console: the bitcoin question spent search_apis → call_api → answer, and the middle step
     * retrieved nothing the model did not already have.
     *
     * A turn is not cheap here. Time-to-first-token on the free pool has a median around 2.5s and
     * a tail past 30s (measured over the whole pool), so removing one round trip removes a whole
     * draw from that distribution — which is the only lever available, since `auto/free` already
     * routes to the fastest usable free model and pinning a specific one measured worse.
     *
     * So: report the price from the search row, and skip the call that cannot succeed. `call_api`
     * still returns the price if the model calls it anyway — that path is the backstop, not the
     * instruction.
     */
    lines.push(
      '- This session has no wallet and no API key, so it cannot complete a paid call. Do NOT call ' +
        'call_api in this session: it cannot pay, and search_apis already gave you the price on each ' +
        'row. Report that price straight from the search result — tell the user the API exists, what ' +
        'it costs per call, and that connecting a wallet or signing in unlocks it — then answer ' +
        'whatever part of the question you can yourself. Never tell the user a capability does not ' +
        'exist when it is in the catalogue.',
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
  /**
   * For tool-end: nothing was spent because the call was REFUSED for lack of payment.
   *
   * Separate from `spentUsd: 0`, which a genuinely free tool also reports. Without the
   * distinction the UI labelled a refused `call_api` "free" — a green tick claiming a paid API
   * ran at no charge, which is the opposite of what happened.
   */
  unpayable?: boolean
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
 * How much deliberation is allowed before a model is abandoned mid-answer.
 *
 * This is the reported "front-end hang", and it was never a hang. Captured from the live
 * console on "What's the current price of Bitcoin and its 24h change?": `auto/free` resolved
 * to `nemotron-3-nano-omni-30b-a3b-reasoning`, which streamed **229,295 characters** of
 * `reasoning_content` for that one question. Nothing errored and nothing timed out — frames
 * arrived continuously the whole time — so the page sat on "Thinking" for over seven minutes
 * with the stream perfectly healthy. The reasoning showed it inventing tool results rather
 * than calling anything: "Let's assume the first result is an API with id 123".
 *
 * The other eight free models, same prompt, produced 148-191 characters and finished in
 * 1.9-22.3s. So the cap is not a tuning knob balanced against normal behaviour; it is three
 * orders of magnitude above it, and only a model that has genuinely come off the rails can
 * reach it.
 *
 * 40,000 characters — roughly 10k tokens of thinking. Far past the 3,716-character worst case
 * measured before the brevity rule went in, so a model that is merely verbose still finishes
 * its own way; a model emitting a quarter of a million characters is stopped at about a sixth
 * of the way through instead of at the end.
 *
 * A character budget rather than a wall-clock timeout on purpose. A slow model that is making
 * progress should not be killed for being slow — the free pool's honest first-content times run
 * to 20-30s — and a timeout cannot tell "thinking hard" from "looping". Volume can.
 */
const MAX_REASONING_CHARS = 40_000

/**
 * Output ceiling for an answer turn.
 *
 * gateway.streamChat defaults to 1024 and the agent never overrode it, so an answer that needed
 * more simply stopped: a screenshot shows "这个市场的描述是：如果" ending mid-sentence, right after
 * two paid tool calls had already been made. The user paid for the data and got a fragment.
 *
 * Confirmed against the live gateway rather than reasoned about — the same prompt returns
 * `finish_reason: 'length'` at a low ceiling and `'stop'` at a high one, and the truncated reply
 * arrives as an ordinary successful response with no marker of its own.
 *
 * 4096 because a tool-using turn spends its budget twice over: the answer has to restate what the
 * API returned before interpreting it, and a catalogue row plus a JSON payload is most of 1024 on
 * its own. Not unbounded — MAX_REASONING_CHARS exists because a free model already ran to 229k
 * characters once, and a ceiling is the cheap half of that defence.
 */
const ANSWER_MAX_TOKENS = 4096

/**
 * Why an answer stopped, in words, or null when it finished normally.
 *
 * The reasons are not interchangeable and the wording has to differ, because what the user should
 * do next differs: a length cut can be continued, a moderation cut cannot. Getting that wrong is
 * its own defect — telling someone to "ask for the rest" when the upstream will refuse the same
 * material again just wastes another paid turn.
 *
 * The default branch is the load-bearing part. Measured reasons on this gateway are 'stop',
 * 'length', 'tool_calls' and 'sensitive'; upstreams add their own without notice, and an
 * unrecognised one previously fell through as a finished answer. Reporting an unknown reason as an
 * early stop can only ever be over-cautious; the alternative silently presents a fragment.
 */
export function earlyStopNotice(reason: string): string | null {
  switch (reason) {
    // A normal end. '' covers a stream that carried no finish_reason at all, which is not
    // evidence of a problem — some upstreams omit it on the final frame.
    case 'stop':
    case '':
      return null
    // Not an early stop: the model asked for a tool and the loop is about to run it. Reaching
    // here with this reason would be a bug elsewhere, but reporting it to the user would be noise.
    case 'tool_calls':
    case 'function_call':
      return null
    case 'length':
      return 'The answer above was cut off at the length limit — it is incomplete. Ask for the rest, or ask for a shorter version.'
    // GLM's wording is "系统检测到输入或生成内容可能包含不安全或敏感内容". Named for what happened
    // rather than blamed on the user: the material came from an API result they paid for.
    case 'sensitive':
    case 'content_filter':
      return "The answer above stopped early — the model's content filter cut it off mid-sentence, so it is incomplete. Retrying will hit the same filter; try asking about a specific part of the data instead."
    default:
      return `The answer above stopped early (${reason}) and may be incomplete.`
  }
}

/**
 * A model abandoned for deliberating past MAX_REASONING_CHARS.
 *
 * Its own class so the loop can tell it apart from the abort it performs to stop the stream.
 * Without the distinction the guard would surface as "network error" and the model would be
 * retired as unavailable — which is wrong, and would spend the rest of the candidate list on a
 * problem none of them has.
 */
class RunawayReasoning extends Error {
  constructor(
    readonly model: string,
    readonly chars: number,
  ) {
    super(`${model} produced ${chars} characters of reasoning without answering`)
    this.name = 'RunawayReasoning'
  }
}

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
/** Marks the injected notice, so repeated switches replace it instead of stacking. */
const CAPABILITY_MARK = '[session capability change]'

/**
 * Tells the model, in the transcript, that what it said earlier about paying no longer holds.
 *
 * Exported for its test. A system-prompt swap is not enough on its own: the model's own earlier
 * refusals stay in the context and it treats them as fact — measured with a real wallet connected
 * and a paid model answering "当前会话没有连接钱包或 API 密钥" anyway.
 *
 * Written as a `system` turn positioned at the END of the history rather than as an `assistant`
 * one. Putting words in the assistant's mouth would have it explain a change it never observed;
 * a late system turn is an instruction that outranks the earlier text by position.
 */
/**
 * Something already in the transcript claiming this session cannot pay.
 *
 * Matched on the assistant's own words, in both languages it answers in, because that is the only
 * evidence available after a reload. Reported case: `test in use for paid calls`, a wallet on Base,
 * balance $8.09, and the paid `deepseek/deepseek-chat` answering "当前会话没有连接钱包或 API 密钥"
 * and "原因从未改变".
 *
 * Deliberately narrow. It must not match the model merely MENTIONING a wallet ("connect a wallet to
 * unlock it" is correct copy for an anonymous session), so each alternative pairs a negation with
 * the credential.
 */
const CANNOT_PAY_CLAIM =
  /(没有|未|无)(连接)?(钱包|api\s*密钥|API 密钥)|(钱包|密钥).{0,8}(没有|未)连接|无法(完成|执行|发起).{0,12}(付费|调用)|(no|without)\s+(a\s+)?(wallet|api\s+key)|cannot\s+(pay|complete\s+a\s+paid)/i

function claimsItCannotPay(history: ChatMessage[]): boolean {
  return history.some((m) => m.role === 'assistant' && CANNOT_PAY_CLAIM.test(String(m.content)))
}

export function notifyCapabilityChange(
  history: ChatMessage[],
  anonymous: boolean,
  changed: boolean,
): void {
  /**
   * Two ways the context can be wrong, and the first fix only handled one of them.
   *
   * `changed` is the live flip: the prompt this call installed differs from the one that was there,
   * which is what happens when a wallet connects mid-conversation. Needed on its own because
   * without it this fired on every message of an ordinary session — `agent.test.ts` caught that —
   * and announcing a change that never happened is a lie in the context.
   *
   * `claimsItCannotPay` is the RELOAD, which is how the bug was reported the second time. Opening a
   * saved conversation restores both the transcript AND the prompt, so a conversation that was
   * anonymous when those turns were written comes back with the paid prompt already at index 0.
   * Nothing changed on this call, `changed` is false, and the stale refusal sat there uncontested —
   * so the model kept agreeing with itself ("原因从未改变") while the sidebar showed a funded key
   * and a connected wallet.
   *
   * Only checked for a paying session: an anonymous one saying it cannot pay is correct.
   */
  const contradictsTranscript = !anonymous && claimsItCannotPay(history)
  if (!changed && !contradictsTranscript) return

  // Only worth saying if there is prior conversation to contradict. On a fresh history the prompt
  // is already correct and a notice would be noise the model tries to act on.
  const hasPriorTurns = history.some((m) => m.role === 'assistant' || m.role === 'tool')
  if (!hasPriorTurns) return

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'system' && String(history[i].content).startsWith(CAPABILITY_MARK)) {
      history.splice(i, 1)
    }
  }

  const text = anonymous
    ? `${CAPABILITY_MARK} The wallet or API key has been disconnected. This session can no longer ` +
      'complete a paid call. Anything earlier in this conversation about being able to pay is now ' +
      'out of date.'
    : `${CAPABILITY_MARK} A wallet or API key is NOW connected. This session CAN complete paid ` +
      'calls. Anything earlier in this conversation that said there is no wallet or no API key, or ' +
      'that a paid call could not be made, is OUT OF DATE — do not repeat it and do not treat it ' +
      'as still true. If the user asks again for something that needs a paid API, call it.'

  history.push({ role: 'system', content: text })
}

export async function* runAgent(
  history: ChatMessage[],
  userMessage: string,
  opts: AgentOptions,
): AsyncGenerator<AgentEvent> {
  const prompt = systemPrompt({ anonymous: opts.anonymous })
  const promptChanged = history.length > 0 && history[0].content !== prompt
  if (history.length === 0 || history[0].role !== 'system') {
    history.unshift({ role: 'system', content: prompt })
  } else if (promptChanged) {
    /**
     * Replaced when the session's capabilities have changed.
     *
     * Connecting a wallet mid-conversation flips `anonymous`, which changes both the advertised tools
     * and what the prompt says the model may do. Leaving the original in place would tell a
     * now-payment-capable session it cannot call anything — and the tool list would disagree with its
     * own instructions, which is the state models resolve by ignoring the tools.
     */
    history[0] = { role: 'system', content: prompt }
    /**
     * The prompt is not the only thing in the context claiming what this session can pay for.
     *
     * Reported with a screenshot: a wallet WAS connected, the model was the paid
     * `deepseek/deepseek-chat`, and the answer still opened "抱歉，我必须**再次**如实说明"
     * and said "当前会话没有连接钱包或 API 密钥". Nothing was stale about the prompt — the code
     * above had already replaced it. What was stale was the TRANSCRIPT: the earlier anonymous
     * turns were still there, and the model read its own previous refusal and stayed consistent
     * with it. "再次" is the tell; it was agreeing with itself.
     *
     * A system prompt does not outrank the conversation for this. The model treats its own prior
     * turns as established fact, so the correction has to be a turn too — placed after the stale
     * refusals, which is where a contradiction gets resolved in favour of the newer statement.
     */
  }
  /**
   * Called on EVERY message, not only when the prompt just changed — and that distinction was a
   * bug I wrote and the test caught.
   *
   * Scoped to the prompt-changed branch, a session that connected and then disconnected kept the
   * "NOW connected" notice: the second flip returns message[0] to a prompt it already held, so
   * `promptChanged` is false and nothing refreshed. The notice then contradicted reality in the
   * other direction, which is the same defect with the sign flipped.
   *
   * It takes `promptChanged` as an argument instead of sitting inside the branch above, so that the
   * "did anything change" question is answered in one place and the notice logic is testable on its
   * own. Both spellings behave identically — `promptChanged` is recomputed per call and is true on a
   * flip in either direction — so this is a readability choice, not a fix; the bug I actually had
   * was calling it with no `changed` argument at all, which announced a change on every message of
   * an ordinary session.
   *
   * Idempotent: any previous notice is removed and at most one describing the CURRENT state is
   * appended, so a session that connects, disconnects and reconnects carries one accurate line
   * rather than three contradictory ones.
   */
  notifyCapabilityChange(history, opts.anonymous, promptChanged)
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
      /**
       * Characters of deliberation this attempt has produced, against MAX_REASONING_CHARS.
       *
       * Counted here rather than checked after the stream closes, which is the whole point: the
       * runaway case ends normally, with a valid `[DONE]`, after several minutes. By the time the
       * response is complete the wait has already happened, so the only place this can help is
       * while the frames are still arriving.
       */
      let reasoningChars = 0
      let runaway = false
      const abortRunaway = new AbortController()
      // Chained to the caller's signal so a user pressing Stop still aborts: replacing the signal
      // rather than combining them would make the runaway guard override the user's own cancel.
      if (opts.signal) {
        if (opts.signal.aborted) abortRunaway.abort()
        else opts.signal.addEventListener('abort', () => abortRunaway.abort(), { once: true })
      }
      const request = streamChat(
        { messages: history, model, tools: schemas, maxTokens: ANSWER_MAX_TOKENS },
        (delta) => {
          if (attempt > 1 && first && (delta.content || delta.reasoning)) {
            // Emitted on the first real delta rather than before the request, so an attempt that
            // fails before producing anything does not clear text the user is still reading.
            q.push({ type: 'reset' })
          }
          if (delta.content || delta.reasoning) first = false
          if (delta.content) q.push({ type: 'text', text: delta.content })
          if (delta.reasoning) {
            q.push({ type: 'reasoning', text: delta.reasoning })
            reasoningChars += delta.reasoning.length
            /**
             * Aborted at the threshold, and the flag is what distinguishes this from a network
             * failure further down: an aborted fetch rejects, and without the flag the loop would
             * report the abort as an ordinary error and retire the model as "unavailable" — which
             * it is not. It answered; it answered at absurd length.
             */
            if (reasoningChars >= MAX_REASONING_CHARS && !runaway) {
              runaway = true
              abortRunaway.abort()
            }
          }
        },
        { baseUrl: opts.baseUrl, cred, signal: abortRunaway.signal },
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
      /**
       * The runaway case is reported here, before the error path, because the abort we just caused
       * looks exactly like a network failure from the outside.
       *
       * Thrown as a tagged error rather than returned as a value so the caller's existing
       * error handling stays in one shape; the caller checks for the tag and reports it as a
       * notice instead of retiring the model.
       */
      if (runaway) throw new RunawayReasoning(model, reasoningChars)
      if (!outcome.ok) throw outcome.error
      return outcome.value
    }

    for (;;) {
      const model = opts.model ?? (await router!.current())
      if (model === undefined) {
        /**
         * Every candidate is currently retired. Retirements age out (see ModelRouter.RETIRE_MS),
         * so this is "nothing available in this moment", not "nothing will ever work" — and the
         * message says try again shortly for that reason.
         *
         * The screenshot that prompted the expiry work showed this error above an answer
         * `qwen3.6-flash` went on to produce: the session had exhausted the list earlier, the set
         * never emptied, and so a later message reported failure without making a single request.
         */
        yield { type: 'error', text: EXHAUSTED_MESSAGE }
        return
      }

      attempts += 1
      try {
        result = yield* attemptStream(model, opts.cred, attempts)
        break
      } catch (err) {
        /**
         * A model that would not stop thinking. Handled first and separately from every failure
         * below, because nothing failed: the request was fine, the stream was fine, and the model
         * was still producing frames when we stopped listening.
         *
         * Retiring it IS right — for this session it has proven it cannot answer this kind of
         * question in reasonable time, and `markFailed` is bypassed only because
         * `isModelUnavailable` inspects the gateway's message and this error never reached the
         * gateway. So the retirement is done directly and the next candidate is tried, which is
         * the same recovery a genuine unavailability gets.
         */
        if (err instanceof RunawayReasoning) {
          /**
           * A PINNED model is reported, never swapped — the same rule the downgrade path below
           * follows, and for the same reason: the user chose this model.
           *
           * This branch is a fix for my own bug, caught by driving the guard against the live
           * gateway with the cap lowered. `router` is undefined whenever `opts.model` is set, so
           * the shared path fell to `'exhausted'` and announced "Every free model the gateway
           * offers is unavailable" — about a session that had pinned one model and never consulted
           * the pool. The guard worked and the explanation was nonsense.
           */
          if (!router) {
            yield {
              type: 'error',
              text: `${model} kept thinking without producing an answer. Try a different model, or ask something narrower.`,
            }
            return
          }
          yield {
            type: 'notice',
            text: `${model} was thinking for too long without answering — trying another model.`,
          }
          if ((await router.retire(model)) === 'exhausted') {
            yield { type: 'error', text: EXHAUSTED_MESSAGE }
            return
          }
          continue
        }
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
      /**
       * A 200 that answered nothing, which the loop used to end as a success.
       *
       * Measured: `nemotron-3-nano-omni-30b-a3b-reasoning` answered a direct request with HTTP
       * 200, zero content, zero reasoning and zero tool calls, in 21.7 seconds. With no tool
       * calls the loop emitted `done`, the UI stopped its spinner, and the turn rendered as a
       * finished answer that was blank — indistinguishable from the app being broken.
       *
       * The `toolCalls.length === 0` guard above is what makes this safe: an assistant turn
       * carrying only tool calls legitimately has no content, and that is the normal first step
       * of every tool-using turn. Only a turn with neither text nor tool calls is empty.
       *
       * Reported rather than retried. A retry would be another 20+ seconds on a model that just
       * demonstrated it has nothing to say, and the user is better served by being told so and
       * choosing — the next message picks up whatever the pool offers then.
       */
      if (result.content.trim() === '') {
        yield {
          type: 'error',
          text: `${result.model} returned an empty answer. Try again, or pick a different model.`,
        }
        return
      }
      /**
       * An answer that stopped early, said out loud.
       *
       * Any finish reason other than a normal stop means the text on screen is a FRAGMENT, and
       * the stream closes cleanly either way — same `[DONE]`, same 200 — so nothing distinguishes
       * the two unless this is read. A screenshot showed a reply ending
       * "这个市场的描述是：如果中国共产党的总书记", mid-sentence, after two paid tool calls had
       * already spent the user's money fetching the data being described.
       *
       * My first fix here handled only `'length'`, on the assumption that the output ceiling was
       * the cause. Measured afterwards against the live gateway, it was not: the real reason was
       *
       *     finish_reason: 'sensitive'   (37 frames, 64 chars, clean [DONE])
       *
       * GLM's own content moderation cuts generation mid-sentence when the material trips it —
       * here a Polymarket question about Chinese politics, arriving as a tool result the user
       * had paid for. Non-streaming returns a 400 for the same input; streaming returns 200 and
       * simply stops. So checking one reason fixed one cause and left the reported one intact.
       *
       * Hence a default branch rather than a list: an unrecognised reason is reported as an early
       * stop rather than silently accepted, because the failure mode of guessing wrong is a
       * fragment presented as an answer, and there is no way for a reader to tell.
       *
       * A notice rather than an error, because the text IS the model's real partial answer and is
       * worth keeping on screen. Deliberately not an automatic retry: the turn already paid for
       * its tool calls, and re-running it would pay for them again — and for 'sensitive' the
       * retry would be refused the same way.
       */
      const stopped = earlyStopNotice(result.finishReason)
      if (stopped !== null) {
        yield { type: 'notice', text: stopped }
      }
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
    /**
     * The ban on stating the value has to be repeated here, and leaving it out cost a fabrication.
     *
     * Reported from a screenshot: three `call_api` attempts in one turn, and the answer was
     * "北京时间：晚上 10:32（UTC+8）这是刚通过 Timezone Lookup API 查到的实时数据" — a time it
     * invented, presented as retrieved, on a turn where every call was refused.
     *
     * Only the FIRST refusal carried the do-not-state-it instruction; this repeat path said merely
     * "cannot be paid for, do not call it again". The model's most recent tool result is the one it
     * writes its answer against, so the instruction that mattered had scrolled out from under it.
     * Every refusal now carries the ban, not just the first.
     */
    const blockedNotice =
      `${name} STILL NOT CALLED — this session has no wallet and no API key, and that has not ` +
      `changed. You received NO data from it, again. Do not call it again.\n` +
      `1. DO NOT state, guess or estimate the value you were trying to fetch — not even ` +
      `approximately, and do NOT present anything as having come from this API. You have ` +
      `nothing from it.\n` +
      `2. Tell the user what it would cost and that connecting a wallet or signing in unlocks it.`
    answer(blockedNotice)
    /**
     * `unpayable` on the event, not just zero spend.
     *
     * Reported from a screenshot: three `call_api` steps in one turn rendered `free`,
     * `$0.001150`, `free` — two green ticks reading as a paid API called at no charge. The first
     * refusal carried `unpayableCall` and was labelled; this repeat path emitted a bare
     * `spentUsd: 0`, and the UI has no way to tell "spent nothing because it was refused" from
     * "spent nothing because it was free".
     */
    yield {
      type: 'tool-end',
      tool: name,
      // The same text handed to the model, so a log or a debug view shows what it was told. Without
      // it this event carried no `result` at all and the reason for the step was invisible outside
      // the model's own context.
      result: blockedNotice,
      spentUsd: 0,
      unpayable: true,
    }
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
      unpayable: res.unpayable,
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
