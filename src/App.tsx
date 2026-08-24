import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { runAgent, type AgentEvent } from './lib/agent'
import { DEFAULT_BASE_URL, type ChatMessage } from './lib/gateway'
import { ModelRouter } from './lib/route'
import { SpendTracker } from './lib/spend'
import { Composer } from './ui/Composer'
import { ConsentDialog, type PendingSpend } from './ui/ConsentDialog'
import { Sidebar } from './ui/Sidebar'
import { Transcript, type Turn } from './ui/Transcript'

/**
 * The console.
 *
 * `history` is the model's conversation and `turns` is what the human sees. They are
 * deliberately separate: the model's copy has to keep every tool-call turn and result
 * verbatim or it re-plans from scratch and re-runs tools that were already paid for,
 * while the display collapses those into one readable line per step.
 *
 * The API key lives in component state and nothing else. Not localStorage: a key
 * persisted by this page would outlive the session on a shared machine, and a key is
 * enough to mint more keys and read the account.
 */
export function App() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [pending, setPending] = useState<PendingSpend | null>(null)

  const history = useRef<ChatMessage[]>([])
  const tracker = useRef(new SpendTracker())
  const abort = useRef<AbortController | null>(null)
  // Held across messages so a model that already proved unservable is not retried first
  // every time. Rebuilt when the gateway or credential changes, since both change which
  // models are reachable.
  const router = useRef<ModelRouter | null>(null)
  // Rerender key for the tracker, which is a mutable object the sidebar reads.
  const [spendVersion, setSpendVersion] = useState(0)

  const anonymous = apiKey.trim() === ''

  useEffect(() => () => abort.current?.abort(), [])

  // Both of these change which models are reachable, so a candidate list learned under
  // the old settings no longer describes anything.
  useEffect(() => {
    router.current = null
  }, [apiKey, baseUrl])

  /**
   * Asks the user about one charge and resolves with their answer.
   *
   * The promise is held open by storing its resolver, which is what lets the agent loop
   * await a human decision without the tool layer knowing anything about React.
   */
  const confirmSpend = useCallback(
    (req: { tool: string; description: string; usd: number }) => {
      const decision = tracker.current.decide(req.usd)
      if (decision.kind === 'allow') return Promise.resolve(true)
      if (decision.kind === 'refuse') {
        // Not shown as a prompt: the session budget is a stop, not a question. Prompting
        // here would let a spent-out session talk its way past its own budget.
        setTurns((t) => [
          ...t,
          { kind: 'error', text: `Refused: ${decision.reason}.` },
        ])
        return Promise.resolve(false)
      }
      return new Promise<boolean>((resolve) => {
        setPending({
          tool: req.tool,
          description: req.description,
          usd: req.usd,
          remainingUsd: decision.remainingUsd,
          resolve,
        })
      })
    },
    [],
  )

  const send = useCallback(
    async (text: string) => {
      const message = text.trim()
      if (message === '' || busy) return

      setBusy(true)
      setTurns((t) => [...t, { kind: 'user', text: message }, { kind: 'agent', text: '', reasoning: '', steps: [] }])

      const controller = new AbortController()
      abort.current = controller

      // Mutates the last turn in place so streamed text does not append a new bubble
      // per token.
      const patchAgent = (fn: (turn: Extract<Turn, { kind: 'agent' }>) => void) => {
        setTurns((prev) => {
          const next = [...prev]
          for (let i = next.length - 1; i >= 0; i--) {
            const turn = next[i]
            if (turn.kind === 'agent') {
              const copy = { ...turn, steps: [...turn.steps] }
              fn(copy)
              next[i] = copy
              break
            }
          }
          return next
        })
      }

      const apply = (e: AgentEvent) => {
        switch (e.type) {
          case 'text':
            patchAgent((t) => {
              t.text += e.text ?? ''
            })
            break
          case 'reasoning':
            patchAgent((t) => {
              t.reasoning += e.text ?? ''
            })
            break
          case 'tool-start':
            patchAgent((t) => {
              t.steps.push({ tool: e.tool ?? '', running: true })
            })
            break
          case 'tool-end':
            if (e.spentUsd && e.spentUsd > 0) {
              tracker.current.record(e.tool ?? 'call', e.spentUsd)
              setSpendVersion((v) => v + 1)
            }
            patchAgent((t) => {
              for (let i = t.steps.length - 1; i >= 0; i--) {
                if (t.steps[i].tool === e.tool && t.steps[i].running) {
                  t.steps[i] = {
                    tool: t.steps[i].tool,
                    running: false,
                    spentUsd: e.spentUsd ?? 0,
                    declined: e.declined,
                  }
                  break
                }
              }
            })
            break
          case 'done':
            patchAgent((t) => {
              t.model = e.model
            })
            break
          case 'downgrade':
            // Its own turn kind, not an error: nothing failed from the user's point of
            // view, the answer is just coming from a different model.
            setTurns((t) => [...t, { kind: 'notice', text: e.text ?? '' }])
            break
          case 'error':
            setTurns((t) => [...t, { kind: 'error', text: e.text ?? 'something went wrong' }])
            break
        }
      }

      const cred = anonymous ? {} : { apiKey }
      if (!router.current) {
        router.current = new ModelRouter({ baseUrl, cred })
      }

      try {
        for await (const event of runAgent(history.current, message, {
          baseUrl,
          cred,
          anonymous,
          router: router.current,
          confirmSpend,
          signal: controller.signal,
        })) {
          apply(event)
        }
      } catch (err) {
        // An abort is the user's own stop, not a failure to report.
        if (!controller.signal.aborted) {
          setTurns((t) => [
            ...t,
            { kind: 'error', text: err instanceof Error ? err.message : String(err) },
          ])
        }
      } finally {
        setBusy(false)
        abort.current = null
      }
    },
    [anonymous, apiKey, baseUrl, busy, confirmSpend],
  )

  const stop = useCallback(() => {
    abort.current?.abort()
    // A pending consent prompt must not survive the stop, or the next message inherits
    // a dialog asking about a call that was cancelled.
    setPending((p) => {
      p?.resolve(false)
      return null
    })
  }, [])

  const reset = useCallback(() => {
    stop()
    history.current = []
    // A fresh router too: "new chat" should give the free tier another chance rather
    // than inheriting a candidate list this session had already used up.
    router.current = null
    tracker.current = new SpendTracker()
    setSpendVersion((v) => v + 1)
    setTurns([])
  }, [stop])

  const spend = useMemo(
    () => ({
      spentUsd: tracker.current.spentUsd,
      remainingUsd: tracker.current.remainingUsd,
      history: [...tracker.current.history],
      policy: tracker.current.policy,
    }),
    // tracker is mutable, so the version counter is what marks it changed.
    [spendVersion],
  )

  return (
    <div className="shell">
      <div className="main">
        <header className="topbar">
          <span className="brand">
            {/* Decorative: the word "JarvisClaw" beside it already names the product, so
                announcing the chip again would just repeat it to a screen reader. */}
            <span className="brand-mark" aria-hidden="true" />
            JarvisClaw
          </span>
          <span className={anonymous ? 'tag tag-free' : 'tag'}>
            {anonymous ? 'free · no sign-in' : 'signed in'}
          </span>
          <span className="spacer" />
          {busy && (
            <button className="ghost-btn" onClick={stop}>
              Stop
            </button>
          )}
          <button className="ghost-btn" onClick={reset} disabled={turns.length === 0}>
            New chat
          </button>
        </header>

        <Transcript turns={turns} onSuggestion={send} />
        <Composer busy={busy} anonymous={anonymous} onSend={send} />
      </div>

      <Sidebar
        anonymous={anonymous}
        apiKey={apiKey}
        baseUrl={baseUrl}
        spend={spend}
        onApiKey={setApiKey}
        onBaseUrl={setBaseUrl}
      />

      {pending && (
        <ConsentDialog
          pending={pending}
          onDecide={(ok) => {
            pending.resolve(ok)
            setPending(null)
          }}
        />
      )}
    </div>
  )
}
