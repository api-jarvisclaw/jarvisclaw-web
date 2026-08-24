import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { runAgent, type AgentEvent } from './lib/agent'
import { listCatalogue, type CatalogueModel } from './lib/catalogue'
import {
  deriveTitle,
  loadConversations,
  newId,
  remove,
  saveConversations,
  upsert,
  type Conversation,
} from './lib/conversations'
import { DEFAULT_BASE_URL, FREE_MODEL, type ChatMessage } from './lib/gateway'
import { GENERATIONS, generate, quoteGeneration, type GenerationKind } from './lib/modality'
import { ModelRouter } from './lib/route'
import { SpendTracker } from './lib/spend'
import { ChatList } from './ui/ChatList'
import { Composer } from './ui/Composer'
import { ConsentDialog, type PendingSpend } from './ui/ConsentDialog'
import { Marketplace } from './ui/Marketplace'
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
 * enough to mint more keys and read the account. Conversations ARE persisted — see
 * lib/conversations.ts for what is and is not written.
 */
export function App() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [pending, setPending] = useState<PendingSpend | null>(null)

  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'marketplace'>('chat')
  const [railOpen, setRailOpen] = useState(true)

  const [models, setModels] = useState<CatalogueModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [model, setModel] = useState<string>(FREE_MODEL)
  const [mode, setMode] = useState<GenerationKind | 'chat'>('chat')

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

  useEffect(() => {
    const ac = new AbortController()
    setModelsLoading(true)
    listCatalogue({ baseUrl, signal: ac.signal })
      .then((rows) => setModels(rows))
      // A failed catalogue is not worth an error turn: the picker degrades to the free
      // default, which is what an anonymous visitor would have used anyway.
      .catch(() => undefined)
      .finally(() => {
        if (!ac.signal.aborted) setModelsLoading(false)
      })
    return () => ac.abort()
  }, [baseUrl])

  /** Writes the current transcript into the conversation list. */
  const persist = useCallback((id: string, nextTurns: Turn[], nextHistory: ChatMessage[]) => {
    if (nextTurns.length === 0) return
    setConversations((prev) => {
      const conv: Conversation = {
        id,
        title: deriveTitle(nextTurns),
        updatedAt: Date.now(),
        turns: nextTurns,
        history: nextHistory,
      }
      const next = upsert(prev, conv)
      saveConversations(next)
      return next
    })
  }, [])

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
        setTurns((t) => [...t, { kind: 'error', text: `Refused: ${decision.reason}.` }])
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

  /** Generation (image/video/music): quote, ask, then run. */
  const runGeneration = useCallback(
    async (kind: GenerationKind, prompt: string, convId: string) => {
      const spec = GENERATIONS[kind]
      // A model chosen for chat cannot make a video, so the mode's own default is used
      // unless the picked model is of that modality.
      const chosen = models.find((m) => m.model === model)
      const useModel = chosen?.modality === kind ? model : spec.defaultModel

      setTurns((t) => [...t, { kind: 'user', text: prompt }])

      let quoted: number
      try {
        quoted = await quoteGeneration(kind, prompt, {
          baseUrl,
          cred: anonymous ? {} : { apiKey },
          model: useModel,
        })
      } catch (err) {
        setTurns((t) => [
          ...t,
          { kind: 'error', text: err instanceof Error ? err.message : String(err) },
        ])
        return
      }

      const approved = await confirmSpend({
        tool: `${spec.label} · ${useModel}`,
        description: `Generate one ${spec.unit} from your prompt`,
        usd: quoted,
      })
      if (!approved) {
        setTurns((t) => [...t, { kind: 'notice', text: `${spec.label} generation declined.` }])
        return
      }

      if (anonymous) {
        // Reached only after approval, so the user is not told "needs a key" for something
        // they never agreed to pay for.
        setTurns((t) => [
          ...t,
          {
            kind: 'error',
            text: `Paying for a ${spec.unit} needs an API key — the free tier covers text models only. Paste a key in the panel on the right.`,
          },
        ])
        return
      }

      try {
        const media = await generate(kind, prompt, {
          baseUrl,
          cred: { apiKey },
          model: useModel,
        })
        tracker.current.record(spec.label, quoted)
        setSpendVersion((v) => v + 1)
        setTurns((t) => {
          const next: Turn[] = [
            ...t,
            {
              kind: 'media',
              media: kind,
              url: media.url,
              b64: media.b64,
              raw: media.raw,
              prompt,
              model: useModel,
              spentUsd: quoted,
            },
          ]
          persist(convId, next, history.current)
          return next
        })
      } catch (err) {
        setTurns((t) => [
          ...t,
          { kind: 'error', text: err instanceof Error ? err.message : String(err) },
        ])
      }
    },
    [anonymous, apiKey, baseUrl, confirmSpend, model, models, persist],
  )

  const send = useCallback(
    async (text: string) => {
      const message = text.trim()
      if (message === '' || busy) return

      // A conversation id is minted on the first message rather than on mount, so an
      // opened-and-abandoned tab does not leave an empty row in the list.
      const convId = activeId ?? newId()
      if (activeId === null) setActiveId(convId)
      setView('chat')
      setBusy(true)

      if (mode !== 'chat') {
        try {
          await runGeneration(mode, message, convId)
        } finally {
          setBusy(false)
        }
        return
      }

      setTurns((t) => [
        ...t,
        { kind: 'user', text: message },
        { kind: 'agent', text: '', reasoning: '', steps: [] },
      ])

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
          // An explicitly chosen model overrides the router's own pick; auto/free means
          // "let the router decide", which is what it was doing before the picker existed.
          model: model === FREE_MODEL ? undefined : model,
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
        // Read through a state setter: `turns` in this closure is the value from before
        // the run, so persisting it directly would save an empty transcript.
        setTurns((t) => {
          persist(convId, t, history.current)
          return t
        })
      }
    },
    [activeId, anonymous, apiKey, baseUrl, busy, confirmSpend, mode, model, persist, runGeneration],
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

  const startNew = useCallback(() => {
    stop()
    history.current = []
    // A fresh router too: "new chat" should give the free tier another chance rather
    // than inheriting a candidate list this session had already used up.
    router.current = null
    tracker.current = new SpendTracker()
    setSpendVersion((v) => v + 1)
    setTurns([])
    setActiveId(null)
    setMode('chat')
    setView('chat')
  }, [stop])

  const openConversation = useCallback(
    (id: string) => {
      stop()
      const conv = conversations.find((c) => c.id === id)
      if (!conv) return
      // Restores BOTH sides: the visible turns and the model's own history. Restoring only
      // the transcript would look resumed while the model re-planned from nothing.
      history.current = [...conv.history]
      router.current = null
      setTurns(conv.turns)
      setActiveId(id)
      setView('chat')
      setMode('chat')
    },
    [conversations, stop],
  )

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const next = remove(prev, id)
        saveConversations(next)
        return next
      })
      if (id === activeId) startNew()
    },
    [activeId, startNew],
  )

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
    <div className={railOpen ? 'shell' : 'shell shell-rail-closed'}>
      {railOpen && (
        <ChatList
          conversations={conversations}
          activeId={activeId}
          view={view}
          onNew={startNew}
          onOpen={openConversation}
          onDelete={deleteConversation}
          onView={setView}
        />
      )}

      <div className="main">
        <header className="topbar">
          <button
            className="rail-toggle"
            onClick={() => setRailOpen((o) => !o)}
            aria-label={railOpen ? 'Hide conversations' : 'Show conversations'}
            aria-expanded={railOpen}
          >
            ▤
          </button>
          <span className={anonymous ? 'tag tag-free' : 'tag'}>
            {anonymous ? 'free · no sign-in' : 'signed in'}
          </span>
          <span className="spacer" />
          {busy && (
            <button className="ghost-btn" onClick={stop}>
              Stop
            </button>
          )}
          <button className="ghost-btn" onClick={startNew} disabled={turns.length === 0}>
            New chat
          </button>
        </header>

        {view === 'marketplace' ? (
          <Marketplace
            baseUrl={baseUrl}
            onAsk={(prompt) => {
              setView('chat')
              void send(prompt)
            }}
          />
        ) : (
          <>
            <Transcript turns={turns} onSuggestion={send} />
            <Composer
              busy={busy}
              anonymous={anonymous}
              models={models}
              modelsLoading={modelsLoading}
              model={model}
              mode={mode}
              onModel={setModel}
              onMode={setMode}
              onSend={send}
            />
          </>
        )}
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
