import {
  ArrowRightIcon,
  CircleDollarSignIcon,
  ImagesIcon,
  KeyRoundIcon,
  StoreIcon,
  TerminalIcon,
  WalletIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { listApis, listCatalogue } from '../lib/catalogue'
import { DEFAULT_BASE_URL } from '../lib/gateway'
import { navFor } from '../lib/nav'
import { LANDING_PATH, pathForView } from '../lib/route-path'

/**
 * The landing page at `/`.
 *
 * A real page on its own route, not content bolted into the console's empty state. The first
 * attempt did the latter — sections above the pinned composer — and it was the wrong shape: the
 * content was trapped in a 1fr column between two fixed panes, so a landing page rendered at
 * 860px in the middle of a 2560px window with sidebars either side of it. A landing page is
 * full-bleed or it is not a landing page.
 *
 * `/chat` is the console. Anyone who already knows what they want goes straight there, and the URL
 * is shareable — which is the other thing the empty-state version could not do.
 *
 * ## Its own fetches, deliberately
 *
 * The counts here come from this component rather than being passed down from App. That looks like
 * duplication and is the point: App owns the console's state — a model router, a spend tracker, a
 * conversation list — and none of it is needed to render a page of copy. Wiring this to App would
 * mean the landing page cannot render until the console's state is constructed, on the one screen
 * that has to paint fast.
 *
 * Every number is read live. Not fastidiousness: the marketplace facet reported 26 categories one
 * afternoon and 18 the next, and the model catalogue grows. A number typed into this file is a
 * number that will be wrong on the screen whose whole job is a first impression. Anything not yet
 * loaded shows a dash rather than 0 — "0 callable APIs" reads as an empty product.
 */
export function LandingPage({
  onEnter,
}: {
  /**
   * Into the console. `path` chooses which pane — a nav item for the gallery should arrive at the
   * gallery, not at the chat with the gallery a click away.
   */
  onEnter: (prompt?: string, path?: string) => void
}) {
  const [counts, setCounts] = useState<{
    models: number | null
    free: number | null
    apis: number | null
    categories: number | null
  }>({ models: null, free: null, apis: null, categories: null })

  useEffect(() => {
    const ac = new AbortController()
    void listCatalogue({ baseUrl: DEFAULT_BASE_URL, signal: ac.signal })
      .then((rows) =>
        setCounts((c) => ({
          ...c,
          models: rows.length,
          free: rows.filter((m) => m.free).length,
        })),
      )
      .catch(() => undefined)
    // page_size=1: only `total` and the facet are wanted, and the facet comes back with every
    // response regardless of page size. Fetching a real page would download 24 endpoint
    // descriptions to render two numbers.
    void listApis({ baseUrl: DEFAULT_BASE_URL, signal: ac.signal, pageSize: 1 })
      .then((page) =>
        setCounts((c) => ({ ...c, apis: page.total, categories: page.categories.length })),
      )
      .catch(() => undefined)
    return () => ac.abort()
  }, [])

  const num = (n: number | null) => (n === null || n === 0 ? '—' : n.toLocaleString())

  return (
    <div className="page">
      <header className="page-nav">
        <a className="page-brand" href={LANDING_PATH} aria-label="ducat home">
          <img className="page-mark" src="/jc.png" alt="" width={22} height={22} />
          ducat
        </a>

        {/* The same list the console's bar renders, from lib/nav.ts. Two hand-kept navs drift, and an
            item present on one bar and missing from the other reads as a link that breaks on some
            pages. */}
        <nav aria-label="Sections">
          {navFor('landing').map((item) =>
            item.kind === 'anchor' ? (
              // Classed so the narrow-screen rule can drop the anchors and keep the destinations. The
              // breakpoint used to hide this whole nav, which was right when every item was an in-page
              // jump — and became wrong the moment real links joined it, leaving a phone visitor no way
              // to reach the marketplace or the docs at all.
              <a key={item.label} className="page-nav-anchor" href={item.to}>
                {item.label}
              </a>
            ) : item.kind === 'view' ? (
              // A real href into the console pane, so it can be copied or middle-clicked; the click
              // handler keeps an ordinary click client-side. Modified clicks are left alone —
              // swallowing cmd-click would turn "open in a new tab" into an in-place navigation.
              <a
                key={item.label}
                href={pathForView(item.view)}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                  e.preventDefault()
                  onEnter(undefined, pathForView(item.view))
                }}
              >
                {item.label}
              </a>
            ) : (
              <a key={item.label} href={item.href} target="_blank" rel="noopener noreferrer">
                {item.label}
              </a>
            ),
          )}
        </nav>

        <button className="page-cta-sm" onClick={() => onEnter()}>
          Open the console
          <ArrowRightIcon size={13} aria-hidden="true" />
        </button>
      </header>

      <section className="page-hero">
        <span className="eyebrow">The agent with a wallet</span>
        <h1>
          Ask for anything. <em>It pays per call.</em>
        </h1>
        <p className="page-lede">
          {num(counts.models)} models and {num(counts.apis)} callable APIs behind one chat box.
          Start with no account, no key and no card — anything that costs money shows its price and
          asks first.
        </p>

        {/* A live input on the landing page, and it is the whole argument for this product: the
            thing being sold is "you can just type", so the hero demonstrates it rather than
            describing it. Submitting navigates to the console and sends the prompt, so the first
            thing a visitor does is the real thing and not a preview of it. */}
        <HeroPrompt onEnter={onEnter} />

        <div className="page-hero-chips">
          {['No sign-up', 'No card', 'Price before every charge'].map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      </section>

      <section className="page-band" id="how">
        <h2>How it works</h2>
        <div className="page-steps">
          {STEPS.map((s, i) => (
            <div key={s.title} className="page-step">
              <span className="page-step-n">{String(i + 1).padStart(2, '0')}</span>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="page-band page-band-alt" id="pay">
        <h2>Three ways to pay, and one of them is free</h2>
        <p className="page-band-lede">
          Which one you use is a choice you make when you need to, not a decision at the door.
        </p>
        <div className="page-cards">
          <article className="page-card">
            <CircleDollarSignIcon size={18} aria-hidden="true" />
            <h3>Free, right now</h3>
            <p>
              {counts.free !== null && counts.free > 0
                ? `${counts.free} models`
                : 'A pool of models'}{' '}
              answer with no credential at all. Nothing to connect, nothing to sign.
            </p>
          </article>
          <article className="page-card">
            <WalletIcon size={18} aria-hidden="true" />
            <h3>A wallet, per call</h3>
            <p>
              Connect a wallet to reach paid models and every callable API. Each charge is signed by
              you, in your wallet, showing the exact amount before it happens.
            </p>
          </article>
          <article className="page-card">
            <KeyRoundIcon size={18} aria-hidden="true" />
            <h3>An account you already have</h3>
            <p>
              Sign in on the platform and spend the quota on it. Your existing key works here the
              same way it works everywhere else.
            </p>
          </article>
        </div>
      </section>

      <section className="page-band" id="what">
        <h2>What is actually here</h2>
        <div className="page-cards">
          <article className="page-card">
            <StoreIcon size={18} aria-hidden="true" />
            <h3>{num(counts.apis)} callable endpoints</h3>
            <p>
              Across {num(counts.categories)} categories — search, on-chain data, documents, OCR,
              prediction markets — each with its real per-call price. Hand one to the agent and it
              asks before spending.
            </p>
          </article>
          <article className="page-card">
            <ImagesIcon size={18} aria-hidden="true" />
            <h3>Prompts that already worked</h3>
            <p>
              A curated image gallery and over a hundred published video prompts, each with the
              frame it produced. Read a real one, edit it, run it — rather than guessing at an empty
              box.
            </p>
          </article>
          <article className="page-card">
            <TerminalIcon size={18} aria-hidden="true" />
            <h3>The same API from your own code</h3>
            <p>
              This console is one client of a public HTTP API. Anything you can do here works from
              the CLI or an SDK against the same gateway, at the same per-call price.
            </p>
          </article>
        </div>
      </section>

      <section className="page-band page-band-alt" id="faq">
        <h2>Questions people actually ask</h2>
        <div className="page-faq">
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="page-close">
        <h2>Type something and see what it costs.</h2>
        <p>The free models need nothing from you.</p>
        <button className="page-cta" onClick={() => onEnter()}>
          Open the console
          <ArrowRightIcon size={15} aria-hidden="true" />
        </button>
      </section>

      <footer className="page-foot">
        <span>JarvisClaw</span>
        <nav>
          <a href="https://docs.jarvisclaw.ai" target="_blank" rel="noopener noreferrer">
            Docs
          </a>
          <a href={DEFAULT_BASE_URL} target="_blank" rel="noopener noreferrer">
            Platform
          </a>
          <a href="https://blog.jarvisclaw.ai" target="_blank" rel="noopener noreferrer">
            Blog
          </a>
        </nav>
      </footer>
    </div>
  )
}

/**
 * The hero's own input.
 *
 * Its value is handed to the console rather than sent from here. Sending from the landing page
 * would mean this component needs the gateway client, the spend tracker and the consent dialog —
 * all of App's machinery — to service one text box. Navigating with the prompt keeps one place
 * responsible for spending money.
 */
function HeroPrompt({ onEnter }: { onEnter: (prompt?: string) => void }) {
  const [text, setText] = useState('')
  return (
    <form
      className="page-prompt"
      onSubmit={(e) => {
        e.preventDefault()
        onEnter(text.trim() === '' ? undefined : text.trim())
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask for anything — a video, an API, a price comparison…"
        aria-label="What should it do?"
      />
      <button type="submit">
        Start
        <ArrowRightIcon size={14} aria-hidden="true" />
      </button>
    </form>
  )
}

const STEPS = [
  {
    title: 'Ask for what you want',
    desc: 'Plain language. The agent picks the model or the API — you do not have to know which one exists.',
  },
  {
    title: 'See the price first',
    desc: 'Anything that costs money is quoted before it runs, and you approve that exact amount. Nothing is charged on a guess.',
  },
  {
    title: 'Keep what it makes',
    desc: 'Images, video, music and speech are collected in your gallery with what each one cost, and every row says how long that file lasts.',
  },
]

/**
 * Answers to the things that stop someone using this, not a feature list.
 *
 * Two of these are uncomfortable and are here for that reason: media retention has real limits, and
 * the history lives in one browser because there is no account. Someone who finds that out from the
 * FAQ can plan around it. Someone who finds it out by losing a file cannot.
 */
const FAQ = [
  {
    q: 'Do I need an account?',
    a: 'No. The free models answer with no credential at all — no key, no wallet, no card. An account or a wallet is only needed to reach paid models and the callable APIs.',
  },
  {
    q: 'How do I know what something costs before I pay?',
    a: 'Every paid call is quoted first and you approve that exact amount. Per-token models show their rate in the picker; per-call ones cannot be known from a rate card, so the gateway returns a quote for your specific request and the dialog shows it.',
  },
  {
    q: 'Where does my generated media go?',
    a: 'Most of it is copied to our own CDN and kept with no expiry. Some cannot be — an archive can fail, and speech arrives as raw bytes with no URL to copy from — so every row in the gallery says which case it is and warns you when a file is on a clock. Download the ones that are.',
  },
  {
    q: 'Is my conversation history saved?',
    a: 'In this browser. There is no account to attach it to, so clearing site data loses the list and it does not follow you to another device. Media that reached the CDN survives either way; the transcript does not.',
  },
  {
    q: 'What happens to my wallet keys?',
    a: 'They never leave your wallet. This page asks it to sign each payment and never sees a private key. An API key, if you use one, is held in that tab only and never stored.',
  },
  {
    q: 'Can I use this from my own code?',
    a: 'Yes — this console is one client of a public HTTP API. Anything you can do here you can do from the CLI or an SDK against the same gateway, with the same per-call pricing.',
  },
]
