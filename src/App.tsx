import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { runAgent, type AgentEvent } from './lib/agent'
import { listApis, listCatalogue, type CatalogueModel } from './lib/catalogue'
import {
  deriveTitle,
  loadConversations,
  newId,
  remove,
  saveConversations,
  upsert,
  type Conversation,
} from './lib/conversations'
import {
  addToGallery,
  archive,
  loadGallery,
  removeFromGallery,
  saveGallery,
  type GalleryItem,
} from './lib/gallery'
import { putMedia, pruneMedia } from './lib/blobstore'
import { DEFAULT_BASE_URL, FREE_MODEL, type ChatMessage, type Credential } from './lib/gateway'
import type { Account } from './lib/account'
import {
  awaitJob,
  challengeGeneration,
  DEFAULT_OPTIONS,
  GENERATIONS,
  generate,
  mediaMimeType,
  modeForModel,
  type AsyncJob,
  type GenerationKind,
  type GenerationOptions as GenOptions,
  type GenerationResult,
} from './lib/modality'
import { ModelRouter } from './lib/route'
import {
  loadSettings,
  normalizeSettings,
  saveSettings,
  type Settings,
} from './lib/settings'
import { SpendTracker, TYPICAL_AGENT_STEPS } from './lib/spend'
import { applyTheme, loadTheme, saveTheme, type Theme } from './lib/theme'
import { ChatList, type RailView } from './ui/ChatList'
import { Composer } from './ui/Composer'
import { ConsentDialog, type PendingSpend } from './ui/ConsentDialog'
import { Gallery, type GalleryTab } from './ui/Gallery'
import { Landing } from './ui/Landing'
import { Marketplace } from './ui/Marketplace'
import { PaneResizer } from './ui/PaneResizer'
import { TopNav } from './ui/TopNav'
import { clampPane, loadPanes, savePanes, type Pane, type PaneWidths } from './lib/panes'
import { DEFAULT_LOCALE, type Locale } from './lib/i18n'
import { pathForView, replacePath } from './lib/route-path'
import {
  isUserRejection,
  selectEvmRequirement,
  signPayment,
  type Challenge,
  type WalletAccount,
} from './lib/wallet'
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
export function App({
  initialPrompt,
  initialView,
  onHome,
  locale = DEFAULT_LOCALE,
  onLocale,
}: {
  /** A prompt typed into the landing page's hero, to run once on arrival. */
  initialPrompt?: string
  /** Which pane the URL asked for — `/gallery` opens the gallery rather than the chat. */
  initialView?: RailView
  /** Back to the landing page. */
  onHome?: () => void
  /**
   * The locale in the URL, needed for every path this console writes.
   *
   * Defaulted so the tests can render the console with no routing owner, matching `onHome`. It is
   * NOT defaulted in route-path's helpers, deliberately: there a default would let a caller emit an
   * unprefixed href that appears to work while costing a redirect and a locale reset.
   */
  locale?: Locale
  /** Change language, keeping the reader on the same pane. Absent when nothing owns the URL. */
  onLocale?: (next: Locale) => void
} = {}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  // No API key state. A key pasted into a page is a plaintext bearer credential, and it
  // could not work from a deployed browser anyway — Authorization was blocked by the
  // gateway's CORS policy. Paid calls are signed by the visitor's own wallet.
  const [wallet, setWallet] = useState<WalletAccount | null>(null)
  // Constant, not state: the gateway is not a user preference. Kept as a local so the
  // call sites below read the same in dev (VITE_GATEWAY_URL) and in production.
  const baseUrl = DEFAULT_BASE_URL
  const [pending, setPending] = useState<PendingSpend | null>(null)

  // Loaded once from storage. Persisted because limits that reset on reload are limits nobody
  // can actually change — the user asked not to be prompted repeatedly, and a preference that
  // forgets itself reproduces the nagging every visit.
  const [settings, setSettings] = useState<Settings>(() => loadSettings())

  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations())

  /**
   * Reopens the most recent conversation instead of starting blank.
   *
   * This used to be `null`, and it is the worst of the three state-loss bugs. Conversations
   * were saved correctly and the list was rebuilt on load — but a reload always landed on an
   * empty chat, so the transcript looked deleted. Measured mid-video-wait: reloading gave
   * `turns after reload: []`, with a paid job still running upstream.
   *
   * A four-minute wait is exactly when someone reloads. Losing the transcript at that moment
   * loses the only on-screen record of a charge, which is the one thing this app must never do.
   *
   * `loadConversations` returns newest-first, so index 0 is the one they were last in.
   */
  const [activeId, setActiveId] = useState<string | null>(() => loadConversations()[0]?.id ?? null)
  const [turnsRestored, setTurnsRestored] = useState(false)
  /**
   * Which pane is showing, seeded from the URL.
   *
   * `/gallery` has to arrive with the gallery open, not open the chat and then swap — that swap is
   * visible, and it makes a shared link look like it went to the wrong place.
   */
  const [view, setView] = useState<RailView>(initialView ?? 'chat')

  /**
   * Keeps the address bar naming the pane on screen.
   *
   * `replaceState`, not push. Clicking Marketplace, then Gallery, then back to chat would otherwise
   * bury the landing page three entries deep, so Back — which everywhere else leaves the section —
   * would instead walk backwards through the panes one at a time.
   *
   * Skipped entirely when this console is not the routed page (`onHome` absent means it was rendered
   * directly, as the tests do), so nothing here can rewrite a URL that another owner is managing.
   */
  useEffect(() => {
    if (!onHome) return
    replacePath(pathForView(locale, view))
  }, [onHome, view, locale])
  /**
   * Which gallery tab is showing. Lifted here so it survives leaving the gallery and coming
   * back — a tab that silently resets makes the other pane feel like it was not really there.
   *
   * Defaults to the showcase for a new visitor and to their OWN work once they have any.
   *
   * Showcase-always was the original choice, for a good reason: an empty "your creations" is what
   * every first-time visitor has, and landing on an empty page is what makes someone leave. But it
   * held for everyone, so a person who had just paid for a video opened the gallery onto someone
   * else's examples and had to find a tab to see the thing they bought. Paid work outranks
   * examples whenever it exists.
   *
   * Read once, at mount, from the store rather than from `gallery` state — the state is loaded in
   * the same initialiser pass and reading it here would depend on hook order.
   */
  const [galleryTab, setGalleryTab] = useState<GalleryTab>(() =>
    loadGallery().length > 0 ? 'mine' : 'showcase',
  )
  /**
   * Text pushed INTO the composer from elsewhere — currently a showcase prompt.
   *
   * A counter rides along with the text so that sending the same prompt twice still lands.
   * Without it, setting the identical string is a no-op to React and the second attempt does
   * nothing, which reads as a broken button.
   */
  const [draft, setDraftState] = useState<{ text: string; n: number } | null>(null)
  const setDraft = useCallback(
    (text: string) => setDraftState((d) => ({ text, n: (d?.n ?? 0) + 1 })),
    [],
  )
  const [gallery, setGallery] = useState<GalleryItem[]>(() => loadGallery())
  const [railOpen, setRailOpen] = useState(true)

  /**
   * How wide the two side panes are. Restored from storage, so a width chosen once stays chosen.
   *
   * The widths were `260px` and `320px` in the grid template. Reasonable numbers, and wrong for
   * anyone whose window is not the one they were picked on: at 2560px the rail spends ten percent of
   * the screen on truncated titles, and at 1280px the wallet panel wraps every few words.
   */
  const [panes, setPanes] = useState<PaneWidths>(() => loadPanes())

  /**
   * The live width during a drag, written to CSS rather than to React state.
   *
   * A pointermove fires up to 120 times a second and each one would otherwise rerender the whole
   * console — the transcript, every turn, the marketplace grid. Setting a custom property on the
   * shell moves the grid track directly, on the compositor's own schedule, and React learns the
   * final number once on release.
   *
   * The ref holds what the DOM currently shows so `onCommit` has a value to persist: reading it back
   * out of `getComputedStyle` would work and would also force a layout on mouse-up.
   */
  const shell = useRef<HTMLDivElement | null>(null)
  const dragWidth = useRef<PaneWidths>(panes)

  const setPaneWidth = useCallback((pane: Pane, px: number) => {
    const w = clampPane(pane, px)
    dragWidth.current = { ...dragWidth.current, [pane]: w }
    shell.current?.style.setProperty(`--${pane}-w`, `${w}px`)
  }, [])

  const commitPanes = useCallback(() => {
    const next = { ...dragWidth.current }
    setPanes(next)
    savePanes(next)
  }, [])

  const [models, setModels] = useState<CatalogueModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  /**
   * Marketplace size, for the landing copy. Null until loaded, NOT 0.
   *
   * The distinction is the whole point: "0 callable APIs" on a page still fetching reads as an
   * empty product, on the one screen whose job is a first impression. Null renders as a dash.
   */
  const [marketSize, setMarketSize] = useState<{ total: number; categories: number } | null>(null)
  const [model, setModel] = useState<string>(FREE_MODEL)
  const [mode, setMode] = useState<GenerationKind | 'chat'>('chat')
  // Per-mode, so switching from Image to Video and back does not lose the size you chose. Not
  // persisted: these are per-task choices, unlike the spend limits.
  const [genOptions, setGenOptions] = useState<Record<GenerationKind, GenOptions>>(DEFAULT_OPTIONS)

  // A main-site account, and the API key chosen from it. The key is held HERE and nowhere else:
  // component state for the tab's lifetime, never localStorage. It is a bearer credential that
  // can mint more keys and read the account, so persisting it would leave it behind on a shared
  // machine. See lib/account.ts for why a key works from a browser at all now.
  const [account, setAccount] = useState<Account | null>(null)
  const [apiKey, setApiKey] = useState<{ key: string; name: string } | null>(null)

  // Light by default, matching the console's own DEFAULT_THEME. The class is applied to <html>
  // in an effect below rather than here, because the initial paint is handled by an inline
  // script in index.html — doing it only in React would flash the wrong theme first.
  const [theme, setTheme] = useState<Theme>(() => loadTheme())

  const history = useRef<ChatMessage[]>([])
  // Seeded from the stored settings, so a reload keeps the budget the user chose rather than
  // silently reverting to $1.00 mid-task.
  const tracker = useRef(
    new SpendTracker({ perCallUsd: settings.perCallUsd, sessionUsd: settings.sessionUsd }),
  )
  const abort = useRef<AbortController | null>(null)
  // Held across messages so a model that already proved unservable is not retried first
  // every time. Rebuilt when the gateway or credential changes, since both change which
  // models are reachable.
  const router = useRef<ModelRouter | null>(null)
  // Rerender key for the tracker, which is a mutable object the sidebar reads.
  const [spendVersion, setSpendVersion] = useState(0)

  // Anonymous means "cannot pay": free models and catalogue reads still work, and that is
  // the state a first visit is in.
  // "Cannot pay" — the state a first visit is in. Either an API key or a wallet lifts it, and
  // they are genuinely different payment rails: a key spends the account's quota server-side
  // with no signature, a wallet signs each call on-chain.
  const anonymous = wallet === null && apiKey === null

  useEffect(() => () => abort.current?.abort(), [])

  // Kept in sync with <html>. Both directions matter: applyTheme so a toggle takes effect, and
  // saveTheme so it survives a reload — the console persists its own choice the same way.
  useEffect(() => {
    applyTheme(theme)
    saveTheme(theme)
  }, [theme])

  // Both of these change which models are reachable, so a candidate list learned under
  // the old settings no longer describes anything.
  useEffect(() => {
    router.current = null
  }, [apiKey, wallet, baseUrl])

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

    /**
     * One page of one row, purely for the count.
     *
     * `page_size=1` because only `total` and the category facet are wanted — the facet comes back
     * with every response regardless of page size, so this is the cheapest possible way to ask.
     * Pulling a real page would download 24 endpoint descriptions to render one number.
     *
     * Read live rather than hardcoded because these numbers MOVE: the facet reported 26 categories
     * one afternoon and 18 the next. A number typed into the source is a number that will be wrong
     * on the first screen.
     */
    listApis({ baseUrl, signal: ac.signal, pageSize: 1 })
      .then((page) => setMarketSize({ total: page.total, categories: page.categories.length }))
      .catch(() => undefined)

    return () => ac.abort()
  }, [baseUrl])

  /**
   * Applies new limits: normalised, persisted, and pushed into the live tracker.
   *
   * The tracker is UPDATED rather than replaced. Building a new one would reset the running
   * total, so raising the budget mid-session would also forgive every charge already made and
   * hand back a full allowance — the ledger records real money that left the wallet.
   */
  const applySettings = useCallback((next: Settings) => {
    const clean = normalizeSettings(next)
    setSettings(clean)
    saveSettings(clean)
    tracker.current.setPolicy({ perCallUsd: clean.perCallUsd, sessionUsd: clean.sessionUsd })
    setSpendVersion((v) => v + 1)
  }, [])

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

  /**
   * Pays for one paid chat call: approve the price, then sign it in the wallet.
   *
   * Returns null for either refusal, so the agent reports a cancellation rather than an
   * error — declining to spend is a choice, not a failure.
   */
  const payForChat = useCallback(
    async (challenge: Challenge, chatModel: string): Promise<string | null> => {
      if (wallet === null) return null

      const req = (() => {
        try {
          return selectEvmRequirement(challenge)
        } catch {
          return null
        }
      })()
      if (req === null) {
        setTurns((t) => [
          ...t,
          {
            kind: 'error',
            text: 'The gateway quoted no EVM payment option, so a browser wallet cannot pay for this call.',
          },
        ])
        return null
      }

      const atomic = Number(req.amount ?? req.maxAmountRequired ?? '0')
      const usd = Number.isFinite(atomic) ? atomic / 1_000_000 : NaN
      if (!Number.isFinite(usd) || usd <= 0) {
        setTurns((t) => [
          ...t,
          { kind: 'error', text: 'The gateway quoted an unreadable price for this model.' },
        ])
        return null
      }

      const approved = await confirmSpend({
        tool: chatModel,
        description: 'One chat completion from this model',
        usd,
      })
      if (!approved) return null

      try {
        const signed = await signPayment(
          challenge,
          `${baseUrl}/v1/chat/completions`,
          wallet,
          settings.perSignatureUsd,
        )
        tracker.current.record(chatModel, signed.usd)
        setSpendVersion((v) => v + 1)
        return signed.header
      } catch (err) {
        if (isUserRejection(err)) return null
        setTurns((t) => [
          ...t,
          { kind: 'error', text: err instanceof Error ? err.message : String(err) },
        ])
        return null
      }
    },
    [baseUrl, confirmSpend, settings.perSignatureUsd, wallet],
  )

  /**
   * Rewrites one media turn in place, found by its own id.
   *
   * By id rather than by array index, and that is not tidiness. A minutes-long wait now runs
   * detached, so by the time it lands the user may have sent more messages or opened another
   * conversation. An index into a REPLACED array can still point at a media turn — one
   * belonging to a different conversation — and the guard "is it a media turn" would happily
   * pass. It would then write the video into that turn and persist the wrong conversation's
   * transcript under this conversation's id, destroying both.
   *
   * An id cannot be mistaken for another turn. If it is not found, nothing happens, which is
   * the correct outcome for a conversation the user has since deleted.
   */
  const patchMediaTurn = useCallback(
    (id: string, convId: string, patch: Partial<Extract<Turn, { kind: 'media' }>>) => {
      // An empty id matches nothing. Conversations saved before turns carried ids reload with
      // `id: undefined`, and a bare `turn.id === id` comparison would pair every one of them
      // with the first patch that arrived — writing a new video into an old turn.
      if (id === '') return
      setTurns((t) => {
        const index = t.findIndex((turn) => turn.kind === 'media' && turn.id === id)
        if (index === -1) return t
        const next = [...t]
        next[index] = { ...(t[index] as Extract<Turn, { kind: 'media' }>), ...patch }
        persist(convId, next, history.current)
        return next
      })
    },
    [persist],
  )

  /**
   * Archives finished media and puts it on screen.
   *
   * Shared by both paths — media that arrived inline and media that arrived after a wait —
   * so a video does not miss the gallery just because it took the slow road. That was the
   * original defect's second half: nothing downstream of the receipt ever ran.
   */
  const settleMedia = useCallback(
    async (
      turnId: string,
      kind: GenerationKind,
      media: GenerationResult,
      prompt: string,
      usedModel: string,
      quoted: number,
      convId: string,
    ) => {
      // Archived to R2 first, so the gallery holds a permanent URL rather than the upstream's
      // temporary one — a $1.14 video whose link expires overnight is a receipt for nothing.
      // Returns null on failure and the original URL is used: losing the archive must not
      // lose the media the user just paid for.
      const stored = media.url ? await archive(media.url) : null
      const shownUrl = stored ?? media.url

      if (shownUrl) {
        const item: GalleryItem = {
          id: newId(),
          kind,
          url: shownUrl,
          prompt,
          model: usedModel,
          usd: quoted,
          createdAt: Date.now(),
        }
        setGallery((g) => {
          const next = addToGallery(g, item)
          saveGallery(next)
          return next
        })
      }

      /**
       * Inline bytes go to IndexedDB, so the clip survives a reload.
       *
       * Only when there is no URL to archive. Speech returns base64 rather than a link, and the
       * CDN Worker cannot copy it — it fetches from an allowlisted host and a `data:` URL has no
       * host. So these bytes exist in this browser only.
       *
       * Awaited before patching the turn, so `mediaKey` is set before anything persists. The old
       * code put the base64 straight into the turn, where `saveConversations` wrote it to
       * localStorage: seven 30s clips filled this origin's 4 MB budget, after which every
       * conversation write failed silently and a refresh discarded everything since.
       */
      let mediaKey: string | undefined
      if (!shownUrl && media.b64) {
        mediaKey = (await putMedia(newId(), media.b64, mediaMimeType(kind))) ?? undefined
      }

      patchMediaTurn(turnId, convId, {
        url: shownUrl,
        b64: media.b64,
        mediaKey,
        raw: media.raw,
        job: undefined,
        timedOut: false,
      })
    },
    [patchMediaTurn],
  )

  /**
   * Waits out a queued generation, keeping the turn updated as it goes.
   *
   * Runs after the charge has already happened, which sets the priority: every branch here
   * must leave the user able to reach media they have paid for. So a client-side timeout
   * keeps the job id on screen rather than clearing the turn, and an upstream failure is
   * reported in the provider's own words instead of a generic error.
   */
  const waitForJob = useCallback(
    async (
      turnId: string,
      kind: GenerationKind,
      job: AsyncJob,
      prompt: string,
      usedModel: string,
      quoted: number,
      convId: string,
    ) => {
      // Wrapped because the caller no longer awaits this: an unhandled rejection here would
      // leave the turn spinning forever with the reason only in the console. The turn has to
      // reach a settled state whatever happens, because the user has already been charged.
      try {
        const outcome = await awaitJob(kind, job, {
          baseUrl,
          onTick: (elapsedMs) => patchMediaTurn(turnId, convId, { waitedMs: elapsedMs }),
        })

        if (outcome.state === 'done') {
          await settleMedia(turnId, kind, outcome.media, prompt, usedModel, quoted, convId)
          return
        }
        if (outcome.state === 'failed') {
          patchMediaTurn(turnId, convId, {
            failed: { message: outcome.message, retryable: outcome.retryable },
            job: undefined,
          })
          return
        }
        // Still pending at the deadline. The job is very likely still running — the gateway
        // allows itself 900s upstream — so the turn keeps its id and says so, rather than
        // claiming a failure that has not happened.
        patchMediaTurn(turnId, convId, { timedOut: true })
      } catch (err) {
        // Reported as timed-out rather than failed: whatever broke here happened on OUR side of
        // the wait, and says nothing about the job. It is still very likely to be running, and
        // still retrievable from the same id.
        patchMediaTurn(turnId, convId, { timedOut: true })
        console.error('waiting for the generation failed', err)
      }
    },
    [baseUrl, patchMediaTurn, settleMedia],
  )

  /**
   * Restores the last conversation on load, and picks up any generation still in flight.
   *
   * Three separate gaps closed here, all of them "state lost during a long wait":
   *
   *  1. The transcript came back blank. Conversations were saved and the list rebuilt, but
   *     `activeId` started null, so a reload showed an empty chat and the record of a paid job
   *     looked deleted.
   *  2. Nothing resumed the polling. A page that reloaded mid-wait left the turn frozen at
   *     whatever second it had reached, forever — the media existed and nothing went to get it.
   *     This is the same defect as the original $0.83 video, just reached by reloading.
   *  3. A job that finished while the tab was closed was never collected. The gateway keeps
   *     polling upstream on its own and stores the result, so the media is usually THERE by
   *     the time the page comes back — resuming finds it immediately.
   *
   * Runs once. The restored turns are what a resume reads, so doing this on every render would
   * start a second poll for the same job on every keystroke.
   */
  useEffect(() => {
    if (turnsRestored) return
    setTurnsRestored(true)
    if (activeId === null) return
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv) return

    history.current = [...conv.history]
    setTurns(conv.turns)

    for (const turn of conv.turns) {
      // Only turns that were still waiting. A finished or failed one has no job left, and
      // re-polling a completed job would be a pointless request against a paid endpoint.
      //
      // `mediaKey` is checked alongside `url`, and it has to be: `b64` is deliberately stripped
      // before persisting, so after a reload a FINISHED speech turn has neither url nor b64 and
      // would look unfinished. Testing only those two would re-poll a completed job on every
      // reload — a request against a paid endpoint for media already in hand.
      if (turn.kind !== 'media' || !turn.job || turn.url || turn.b64 || turn.mediaKey) continue
      // Cleared before resuming: the stored `waitedMs` measured the PREVIOUS session's wait, so
      // leaving it would show a counter that jumps backwards the moment the first poll lands.
      // `timedOut` goes too — a wait that has just restarted has not timed out.
      patchMediaTurn(turn.id, conv.id, { waitedMs: undefined, timedOut: false, resumed: true })
      void waitForJob(
        turn.id,
        turn.media,
        turn.job,
        turn.prompt,
        turn.model,
        turn.spentUsd,
        conv.id,
      )
    }

    /**
     * Drops blobs no conversation refers to any more.
     *
     * Deleting a conversation removes its keys from localStorage and leaves the bytes stranded in
     * IndexedDB — invisible, unreachable, and counting against a 6 GB quota. Without this the
     * store only ever grows.
     *
     * Keys are collected from EVERY conversation, not just the active one: pruning against the
     * open conversation alone would delete the audio belonging to all the others.
     */
    const live = new Set<string>()
    for (const c of conversations) {
      for (const t of c.turns) {
        if (t.kind === 'media' && t.mediaKey) live.add(t.mediaKey)
      }
    }
    void pruneMedia(live)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount, by design
  }, [])

  /**
   * Runs a prompt handed over from the landing page's hero, exactly once.
   *
   * Guarded by a ref rather than a dependency list: `send` is a useCallback that changes whenever
   * the model or credential does, so listing it would re-send the same prompt on the next render —
   * a second paid call the user did not ask for. That is the failure this guard exists for, not a
   * lint appeasement.
   *
   * Deliberately NOT awaited or blocked on: `send` opens the consent dialog for anything paid, and
   * the free tier answers without one. Either way the user sees their own words on screen first.
   */
  const handoffSent = useRef(false)
  useEffect(() => {
    if (handoffSent.current) return
    if (!initialPrompt || initialPrompt.trim() === '') return
    handoffSent.current = true
    void send(initialPrompt)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, by design; see above
  }, [initialPrompt])

  /** Generation (image/video/music): quote, ask, then run. */
  const runGeneration = useCallback(
    async (kind: GenerationKind, prompt: string, convId: string) => {
      const spec = GENERATIONS[kind]
      // A model chosen for chat cannot make a video, so the mode's own default is used
      // unless the picked model is of that modality.
      // Compared on the resolved MODE, not the raw modality: `audio` covers both music and
      // speech, and they are different endpoints. Comparing modality alone would send a
      // voice model to /v1/audio/generations, which prices per track and 400s on it.
      const chosen = models.find((m) => m.model === model)
      const chosenMode = chosen ? modeForModel(chosen.model, chosen.modality) : null
      const useModel = chosenMode === kind ? model : spec.defaultModel

      setTurns((t) => [...t, { kind: 'user', text: prompt }])

      // Priced anonymously first. The 402 challenge is what a wallet signs over, so it has
      // to be fetched before any wallet prompt — and it costs nothing, which means an
      // unconnected visitor still learns the price.
      let quote
      try {
        quote = await challengeGeneration(kind, prompt, {
          baseUrl,
          model: useModel,
          // The chosen size/length/voice are part of the QUOTED body, so the price returned is
          // the price for exactly this request — and the same body is what gets sent below.
          options: genOptions[kind],
        })
      } catch (err) {
        setTurns((t) => [
          ...t,
          { kind: 'error', text: err instanceof Error ? err.message : String(err) },
        ])
        return
      }
      const quoted = quote.usd

      if (anonymous) {
        // Told BEFORE any approval prompt: asking someone to approve a charge they have no
        // way to pay is a dialog that can only end in disappointment. Both rails are named,
        // because an existing customer's answer is "sign in", not "install a wallet".
        setTurns((t) => [
          ...t,
          {
            kind: 'notice',
            text: `One ${spec.unit} from ${useModel} costs $${quoted.toFixed(6)}. Sign in with your JarvisClaw account to use its quota, or connect a wallet to pay per call — free models need neither.`,
          },
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

      // Two payment rails, and only one of them signs anything.
      //
      // With an API key the gateway bills the account server-side, so the call carries the key
      // and no signature exists to make. With a wallet, the prompt IS the consent: it shows the
      // amount, recipient and expiry in the wallet's own UI, which no page can fake.
      let cred: Credential
      if (apiKey !== null) {
        cred = { apiKey: apiKey.key }
      } else if (wallet === null) {
        // Unreachable today: `anonymous` is false and apiKey is null, so a wallet exists. Kept
        // as a real branch rather than a non-null assertion, so a future change that lets both
        // rails be absent reports it instead of throwing on a null.
        setTurns((t) => [
          ...t,
          { kind: 'error', text: 'No way to pay for this call — sign in or connect a wallet.' },
        ])
        return
      } else {
        try {
          cred = {
            payment: (
              await signPayment(quote.challenge, quote.url, wallet, settings.perSignatureUsd)
            ).header,
          }
        } catch (err) {
          setTurns((t) => [
            ...t,
            isUserRejection(err)
              ? { kind: 'notice', text: 'Payment cancelled in your wallet — nothing was charged.' }
              : { kind: 'error', text: err instanceof Error ? err.message : String(err) },
          ])
          return
        }
      }

      try {
        const media = await generate(kind, prompt, {
          baseUrl,
          cred,
          model: useModel,
          // The exact URL and body the signature was issued for. Signing one body and
          // spending it on another is a payment the facilitator may settle for a call the
          // gateway never priced.
          url: quote.url,
          body: quote.body,
        })
        tracker.current.record(spec.label, quoted)
        setSpendVersion((v) => v + 1)

        // A media turn is placed on screen immediately, even with nothing to show yet. A
        // queued video takes minutes, and the alternative is a page that looks idle while a
        // paid job runs — which is what makes someone reload and lose the job id.
        const turnId = newId()
        setTurns((t) => {
          const next: Turn[] = [
            ...t,
            {
              kind: 'media',
              id: turnId,
              media: kind,
              prompt,
              model: useModel,
              spentUsd: quoted,
              job: media.job,
              raw: media.job ? undefined : media.raw,
            },
          ]
          persist(convId, next, history.current)
          return next
        })

        // Synchronous result (images, speech): already in hand, nothing to wait for.
        if (!media.job) {
          await settleMedia(turnId, kind, media, prompt, useModel, quoted, convId)
          return
        }

        // NOT awaited, deliberately.
        //
        // Awaiting it held `busy` for the entire poll — up to 5 minutes for music and video —
        // so the composer stayed disabled after a successful payment. Measured: send was still
        // disabled 18 seconds in, on a wait that runs for 300. From the outside that is
        // indistinguishable from a page that took the money and died, which is exactly how it
        // was reported: "I paid and there's no reaction."
        //
        // The payment is what this call is busy with, and the payment is done. The wait updates
        // its own turn by index as it goes, so letting it run detached costs nothing and gives
        // the page back. A second generation started meanwhile appends its own turn and polls
        // its own job.
        void waitForJob(turnId, kind, media.job, prompt, useModel, quoted, convId)
      } catch (err) {
        setTurns((t) => [
          ...t,
          { kind: 'error', text: err instanceof Error ? err.message : String(err) },
        ])
      }
    },
    [
      anonymous,
      apiKey,
      baseUrl,
      confirmSpend,
      genOptions,
      model,
      models,
      persist,
      settleMedia,
      settings.perSignatureUsd,
      waitForJob,
      wallet,
    ],
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

      // Where this message runs. The mode button wins when set, but a picked non-text model
      // routes on its own — WITHOUT this, choosing a voice model only changed the CHAT model,
      // so `auto/tts` went to /v1/chat/completions where it is a paid chat model that answers
      // in words. That cost a real user five signatures and $0.068 for no audio.
      const picked = models.find((m) => m.model === model)
      const target = mode !== 'chat' ? mode : picked ? modeForModel(picked.model, picked.modality) : null

      if (target !== null) {
        try {
          await runGeneration(target, message, convId)
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
          /**
           * A retry is starting over, so clear what the abandoned attempt streamed.
           *
           * Only reachable now that delivery is live. While events were buffered until the response
           * finished, a failed attempt's buffer was simply dropped and the user never saw it. Now
           * the words are on screen, and without this the retry's text appends to them — one turn
           * that reads as a single answer and is really two halves of different ones.
           *
           * Reasoning is cleared too. It belongs to the attempt that was abandoned, and leaving it
           * beside a fresh answer attributes one model's thinking to another's words.
           */
          case 'reset':
            patchAgent((t) => {
              t.text = ''
              t.reasoning = ''
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
            /**
             * A paid API this session could not reach, stated by the page rather than by the model.
             *
             * The agent is already told to report the name, the price and the unlock path. It does not
             * reliably do it: measured on "北京时间是几点", a free-tier model was handed
             * "Timezone Lookup, $0.005750, connect a wallet" and answered with an invented timestamp,
             * mentioning neither. A user who is never told the capability exists cannot choose to
             * unlock it, so the fact is rendered from the event.
             *
             * A notice, not an error: nothing failed. The API is there and has a price.
             */
            if (e.unpayableCall) {
              const { name, priceUsd } = e.unpayableCall
              setTurns((t) => [
                ...t,
                {
                  kind: 'notice',
                  text: `${name} would answer this — $${priceUsd.toFixed(6)} per call. Connect a wallet or sign in with your JarvisClaw account to use it. Anything the answer above says about live data was not retrieved from it.`,
                },
              ])
            }
            patchAgent((t) => {
              for (let i = t.steps.length - 1; i >= 0; i--) {
                if (t.steps[i].tool === e.tool && t.steps[i].running) {
                  t.steps[i] = {
                    tool: t.steps[i].tool,
                    running: false,
                    spentUsd: e.spentUsd ?? 0,
                    declined: e.declined,
                    // Carried through so the row can say "not called" instead of "free". A refused
                    // paid call spends nothing, and without this the row was indistinguishable
                    // from a genuinely free tool having run.
                    unpayable: e.unpayable,
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
          // Both render as a notice, not an error: nothing failed from the user's point of
          // view. A downgrade means the answer is coming from a different model; a notice
          // is something the agent needs to say, such as a paid model's price.
          case 'downgrade':
          case 'notice':
            setTurns((t) => [...t, { kind: 'notice', text: e.text ?? '' }])
            break
          case 'error':
            setTurns((t) => [...t, { kind: 'error', text: e.text ?? 'something went wrong' }])
            break
        }
      }

      // A paid chat model needs one wallet signature PER AGENT STEP, because one x402 `exact`
      // signature authorises exactly one HTTP request and each step is a request. That is a
      // protocol floor, not a UI choice: the facilitator advertises the `upto` scheme only on
      // Base Sepolia, while the gateway quotes `exact` on mainnet.
      //
      // Said before the run rather than discovered during it. A user asked for one thing and
      // got five wallet prompts with no warning, which reads as the page malfunctioning.
      // Only when paying by WALLET. An API key spends the account's quota server-side, so a
      // paid model costs one HTTP request per step and no signatures at all — warning about
      // signature prompts that will not happen is its own kind of wrong.
      if (picked && !picked.free && wallet !== null && apiKey === null) {
        setTurns((t) => [
          ...t,
          {
            kind: 'notice',
            text: `${model} is paid, and an agent run takes a few steps — each one needs its own wallet signature (usually ${TYPICAL_AGENT_STEPS}, sometimes more). Free models need none.`,
          },
        ])
      }

      // The key when there is one; otherwise nothing, and a paid model is signed per call by
      // the wallet. Sending an empty Authorization header instead of none would 401 the free
      // tier, which recognises a request by the ABSENCE of the header (see gateway.authHeaders).
      const cred: Credential = apiKey === null ? {} : { apiKey: apiKey.key }
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
          // Wallet only. With a key there is no 402 to answer — the gateway bills the account
          // and returns the completion — so handing over a signer would be dead code that
          // could only fire if the key were rejected, and re-paying a rejected call on-chain is
          // not a recovery anyone asked for.
          payForChat: wallet === null || apiKey !== null ? undefined : payForChat,
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
    [
      activeId,
      anonymous,
      baseUrl,
      busy,
      apiKey,
      confirmSpend,
      mode,
      model,
      models,
      payForChat,
      persist,
      runGeneration,
      wallet,
    ],
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
    // A fresh budget, but the USER'S limits — not the built-in defaults. Constructing this
    // bare would quietly undo their settings on every "New chat", which is the same nagging
    // they asked to be rid of, arriving one click later.
    tracker.current = new SpendTracker({
      perCallUsd: settings.perCallUsd,
      sessionUsd: settings.sessionUsd,
    })
    setSpendVersion((v) => v + 1)
    setTurns([])
    setActiveId(null)
    setMode('chat')
    setView('chat')
  }, [settings.perCallUsd, settings.sessionUsd, stop])

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
    /**
     * The window: one global bar, then the three panes beneath it.
     *
     * The bar used to be rendered inside `.main` — the grid's middle column — which made it a pane
     * toolbar rather than a global bar: it started after the rail's right border and stopped at the
     * sidebar's left one, with two vertical rules cutting the row into thirds and the brand stranded
     * in the rail beside it.
     *
     * The rows are `auto` then `minmax(0, 1fr)`. The `0` floor is what still allows the panes to be
     * shorter than their content, which is the permission their `overflow-y: auto` needs before it can
     * do anything — the same constraint `.shell` states, moved up a level now that `.shell` is no
     * longer the element capped to the viewport.
     */
    <div className="frame">
      <TopNav
        view={view}
        anonymous={anonymous}
        busy={busy}
        theme={theme}
        railOpen={railOpen}
        hasTurns={turns.length > 0}
        onView={setView}
        onRail={() => setRailOpen((o) => !o)}
        onTheme={setTheme}
        onStop={stop}
        onNew={startNew}
        onHome={onHome}
        locale={locale}
        onLocale={onLocale}
      />

      <div
        ref={shell}
        className={railOpen ? 'shell' : 'shell shell-rail-closed'}
        /**
         * The pane widths as custom properties, which is what lets a drag skip React entirely.
         *
         * The grid template reads them through `clamp()`, so the stylesheet still has the last word on
         * a window too narrow to honour the stored number — and because that clamping happens in CSS,
         * a temporarily-cramped viewport never overwrites the width the user chose.
         */
        style={
          {
            '--rail-w': `${panes.rail}px`,
            '--sidebar-w': `${panes.sidebar}px`,
          } as React.CSSProperties
        }
      >
        {railOpen && (
          <ChatList
            conversations={conversations}
            activeId={activeId}
            view={view}
            galleryCount={gallery.length}
            onNew={startNew}
            onOpen={openConversation}
            onDelete={deleteConversation}
            onView={setView}
          />
        )}
        {/* Between the panes it separates, in DOM order, so focus reaches it where it sits. Only when
            the rail is open: a handle for a hidden pane would resize something invisible. */}
        {railOpen && (
          <PaneResizer
            pane="rail"
            width={panes.rail}
            onWidth={(px) => setPaneWidth('rail', px)}
            onCommit={commitPanes}
          />
        )}

        <div className="main">
          {view === 'gallery' ? (
            <Gallery
              items={gallery}
              tab={galleryTab}
              onTab={setGalleryTab}
              onRemove={(id) =>
                setGallery((g) => {
                  const next = removeFromGallery(g, id)
                  saveGallery(next)
                  return next
                })
              }
              /**
               * Loads a showcase prompt into the composer instead of running it.
               *
               * Deliberately NOT run-on-click. These prompts carry
               * `{argument name="…" default="…"}` markers where their author expected an edit, and
               * a one-click run would charge for a verbatim reproduction of someone else's example
               * before the user had a chance to change the headline. So the prompt lands in the box,
               * in the right mode, and the existing consent dialog still asks before any money moves.
               */
              onUsePrompt={(prompt, promptMode, promptModel) => {
                setView('chat')
                setMode(promptMode)
                /**
                 * The model that produced the example, when the collection publishes one.
                 *
                 * Without this the prompt ran on the modality default: a Seedance 2.0 showcase
                 * item was quoted "One video from bytedance/seedance-2.0-mini costs $0.399554" —
                 * a different model from the one printed on the card, ~2.8x cheaper, with
                 * different parameter ceilings. The price shown was real, so nothing looked
                 * wrong; it was simply the price of something else.
                 *
                 * Only set when the item names a model AND this gateway serves it. A null leaves
                 * the picker alone, which is right for the library collection, whose authors did
                 * not record what they ran.
                 */
                if (promptModel !== null && models.some((m) => m.model === promptModel)) {
                  setModel(promptModel)
                }
                setDraft(prompt)
              }}
            />
          ) : view === 'marketplace' ? (
            <Marketplace
              baseUrl={baseUrl}
              onAsk={(prompt) => {
                setView('chat')
                void send(prompt)
              }}
            />
          ) : (
            <>
              <Transcript
                turns={turns}
                empty={
                  <Landing
                    models={models}
                    marketplaceTotal={marketSize?.total ?? null}
                    onSuggestion={send}
                  />
                }
              />
              <Composer
                busy={busy}
                anonymous={anonymous}
                models={models}
                modelsLoading={modelsLoading}
                model={model}
                mode={mode}
                options={mode === 'chat' ? {} : genOptions[mode]}
                onModel={setModel}
                onMode={setMode}
                onOptions={(o) => {
                  if (mode !== 'chat') setGenOptions((prev) => ({ ...prev, [mode]: o }))
                }}
                onSend={send}
                draft={draft}
              />
            </>
          )}
        </div>

        <PaneResizer
          pane="sidebar"
          width={panes.sidebar}
          onWidth={(px) => setPaneWidth('sidebar', px)}
          onCommit={commitPanes}
        />

        <Sidebar
          wallet={wallet}
          spend={spend}
          settings={settings}
          account={account}
          keyName={apiKey?.name ?? null}
          onSettings={applySettings}
          onAccount={setAccount}
          onKey={setApiKey}
          onWallet={setWallet}
        />
      </div>

      {/* Outside the shell, deliberately. The shell sets `overflow: hidden` to stop a pane growing a
          document scrollbar, and a clipping ancestor clips a fixed descendant too — so a dialog left
          in there could be cut off by the very rule that keeps the composer pinned. This one asks the
          user to approve a charge, which makes "partly off screen" the worst possible outcome. */}
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
