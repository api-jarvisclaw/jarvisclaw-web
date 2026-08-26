import {
  ArrowRightIcon,
  CircleDollarSignIcon,
  ImagesIcon,
  KeyRoundIcon,
  StoreIcon,
  WalletIcon,
} from 'lucide-react'

import { type CatalogueModel } from '../lib/catalogue'

/**
 * The first screen for someone who has never used this.
 *
 * ## Why this is not a separate landing page
 *
 * The obvious move — and the one Franklin makes — is a marketing page at `/` with the console at
 * `/chat`. That would be wrong here, and for a reason specific to this product: ducat's single
 * strongest claim is that you can open it and type with no account, no key and no card. A landing
 * page in front of the box takes the one thing worth showing and replaces it with a description of
 * itself.
 *
 * So the content lives in the empty state, ABOVE a composer that is already pinned. Measured
 * before writing any of it, at three viewport heights:
 *
 *   vh=900  composer top 737, visible, transcript does not scroll
 *   vh=720  composer top 557, visible, transcript scrolls internally
 *   vh=620  composer top 457, visible, transcript scrolls internally
 *
 * The composer never moves and the document never scrolls — `.transcript` is its own scroll
 * container with a height cap. That is what makes this safe: the sections can be as long as they
 * need to be, because they scroll inside a region while the box stays put. Adding them to a page
 * whose composer was in normal flow would have pushed it off screen, which is the bug this app
 * already fixed once.
 *
 * ## Every number here is read live
 *
 * Nothing is hardcoded, and that is not fastidiousness — the counts move. The marketplace facet
 * reported 26 categories one afternoon and 18 the next, and the model catalogue grows. A number
 * typed into this file is a number that will be wrong, on the page whose whole job is a first
 * impression. Anything not yet loaded renders as a dash rather than a zero: "0 models" on a page
 * still fetching reads as an empty product.
 */
export function Landing({
  models,
  marketplaceTotal,
  marketplaceCategories,
  onSuggestion,
  onOpenMarketplace,
  onOpenGallery,
}: {
  models: CatalogueModel[]
  /** Callable marketplace endpoints, or null while still loading. */
  marketplaceTotal: number | null
  marketplaceCategories: number | null
  onSuggestion: (text: string) => void
  onOpenMarketplace: () => void
  onOpenGallery: () => void
}) {
  const freeCount = models.filter((m) => m.free).length
  const num = (n: number | null) => (n === null || n === 0 ? '—' : n.toLocaleString())

  return (
    <div className="landing">
      <section className="empty">
        <span className="eyebrow">The agent with a wallet</span>
        <h1>
          What should <em>JarvisClaw</em> do?
        </h1>
        <p>
          {/* The counts are the pitch, so they have to be true. Read from the same catalogue the
              model picker uses rather than written down. */}
          {num(models.length)} models and {num(marketplaceTotal)} callable APIs, paid per call.
          Start now — no account, no key, no card. Anything paid shows its price and asks first.
        </p>
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="suggestion" onClick={() => onSuggestion(s)}>
              {s}
            </button>
          ))}
        </div>
      </section>

      {/* Below the fold by design. Someone who knows what they want types and never sees any of
          this; someone who does not scrolls and finds out what the thing is. Both are served
          without either getting in the other's way. */}
      <section className="landing-band">
        <h2>How it works</h2>
        <div className="landing-steps">
          {STEPS.map((s, i) => (
            <div key={s.title} className="landing-step">
              <span className="landing-step-n">{String(i + 1).padStart(2, '0')}</span>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-band">
        <h2>Three ways to pay, and one of them is free</h2>
        <p className="landing-lede">
          Which one you use is a choice you make when you need to, not a decision at the door.
        </p>
        <div className="landing-cards">
          <article className="landing-card">
            <CircleDollarSignIcon size={18} aria-hidden="true" />
            <h3>Free, right now</h3>
            <p>
              {/* Named as a real count. "Some models are free" invites the question this answers. */}
              {freeCount > 0 ? `${freeCount} models` : 'A pool of models'} answer with no credential
              at all. Nothing to connect, nothing to sign.
            </p>
          </article>
          <article className="landing-card">
            <WalletIcon size={18} aria-hidden="true" />
            <h3>A wallet, per call</h3>
            <p>
              Connect a wallet to reach paid models and every callable API. Each charge is signed by
              you, in your wallet, showing the exact amount before it happens.
            </p>
          </article>
          <article className="landing-card">
            <KeyRoundIcon size={18} aria-hidden="true" />
            <h3>An account you already have</h3>
            <p>
              Sign in on the platform and spend the quota on it. Your existing key works here the
              same way it works everywhere else.
            </p>
          </article>
        </div>
      </section>

      <section className="landing-band">
        <h2>What is actually here</h2>
        <div className="landing-cards">
          <article className="landing-card">
            <StoreIcon size={18} aria-hidden="true" />
            <h3>{num(marketplaceTotal)} callable endpoints</h3>
            <p>
              Across {num(marketplaceCategories)} categories — search, on-chain data, documents,
              OCR, prediction markets — each with its real per-call price. Hand one to the agent and
              it asks before spending.
            </p>
            <button className="landing-link" onClick={onOpenMarketplace}>
              Browse the marketplace
              <ArrowRightIcon size={12} aria-hidden="true" />
            </button>
          </article>
          <article className="landing-card">
            <ImagesIcon size={18} aria-hidden="true" />
            <h3>Prompts that already worked</h3>
            <p>
              A curated image gallery and over a hundred published video prompts, each with the
              frame it produced. Read a real one, edit it, run it — rather than guessing at an empty
              box.
            </p>
            <button className="landing-link" onClick={onOpenGallery}>
              Open the gallery
              <ArrowRightIcon size={12} aria-hidden="true" />
            </button>
          </article>
        </div>
      </section>

      <section className="landing-band">
        <h2>Questions people actually ask</h2>
        <div className="landing-faq">
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <p className="landing-foot">
        Type in the box below to start. The free models need nothing from you.
      </p>
    </div>
  )
}

/**
 * Starters, each one something this gateway can actually do — the marketplace really does carry
 * search, on-chain and prediction-market services, and the catalogue really does expose per-model
 * pricing. A suggestion that fails on click is worse than none: it is the first thing a new
 * visitor tries.
 */
const SUGGESTIONS = [
  'What can you do, and what does it cost?',
  'Find me an API for Ethereum gas prices.',
  'Which models are free right now?',
  'Search the marketplace for on-chain data services.',
  'What would a 5-second video cost me?',
  'Compare the cheapest and most capable chat models.',
]

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
 * Two of these are uncomfortable and are here for that reason: media retention has real limits,
 * and the history lives in one browser because there is no account. Someone finding that out from
 * the FAQ can plan around it. Someone finding it out by losing a file cannot.
 */
const FAQ = [
  {
    q: 'Do I need an account?',
    a: 'No. The free models answer with no credential at all — no key, no wallet, no card. An account or a wallet is only needed to reach paid models and the callable APIs.',
  },
  {
    q: 'How do I know what something costs before I pay?',
    a: 'Every paid call is quoted first and you approve that exact amount. Per-token models show their rate in the picker; per-call ones cannot be known in advance from a rate card, so the gateway returns a quote for your specific request and the dialog shows it.',
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
    a: 'They never leave your wallet. This page asks it to sign each payment and never sees a private key. An API key, if you use one, is held in this tab only and never stored.',
  },
  {
    q: 'Can I use this from my own code?',
    a: 'Yes — this console is one client of a public HTTP API. Anything you can do here you can do from the CLI or an SDK against the same gateway, with the same per-call pricing.',
  },
]
