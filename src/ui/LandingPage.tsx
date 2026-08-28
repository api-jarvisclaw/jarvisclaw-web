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
import { landingPath, pathForView } from '../lib/route-path'
import { DEFAULT_LOCALE, localePath, type Locale } from '../lib/i18n'
import { LocaleToggle } from './LocaleToggle'
import { useT } from './LocaleContext'

/** The lookup, passed into the copy tables below so they are evaluated per render rather than at
 * module load — a module-level array captures whatever locale existed at import time, which for a
 * lazily-loaded chunk is whichever page happened to mount first. */
type T = (key: string, vars?: Record<string, string | number>) => string

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
  locale = DEFAULT_LOCALE,
  onLocale,
}: {
  /**
   * Into the console. `path` chooses which pane — a nav item for the gallery should arrive at the
   * gallery, not at the chat with the gallery a click away.
   */
  onEnter: (prompt?: string, path?: string) => void
  /** The locale in the URL. Every path this page writes carries it. */
  locale?: Locale
  /** Change language, staying on this page. Absent when nothing owns the URL. */
  onLocale?: (next: Locale) => void
}) {
  const t = useT()
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
        <div className="page-nav-inner">
          {/* The product is JarvisClaw. "ducat" was the wordmark here and it should not have been: it is
              the subdomain this happens to be served from, and the console's own top bar — one click
              away — says JarvisClaw. A visitor who reads one then the other has to work out whether
              they are the same product, which is a question no landing page should raise about itself.
              The mark and the name now match the bar, the tab icon and the main site. */}
          <a className="page-brand" href={landingPath(locale)} aria-label={t('JarvisClaw home')}>
            <img className="page-mark" src="/jc.png" alt="" width={26} height={26} />
            <span className="page-brand-name">JarvisClaw</span>
          </a>

          {/* The same list the console's bar renders, from lib/nav.ts. Two hand-kept navs drift, and an
              item present on one bar and missing from the other reads as a link that breaks on some
              pages. */}
          <nav aria-label={t('Sections')}>
            {navFor('landing').map((item) =>
              item.kind === 'anchor' ? (
                // Classed so the narrow-screen rule can drop the anchors and keep the destinations. The
                // breakpoint used to hide this whole nav, which was right when every item was an in-page
                // jump — and became wrong the moment real links joined it, leaving a phone visitor no way
                // to reach the marketplace or the docs at all.
                <a key={item.label} className="page-nav-anchor" href={item.to}>
                  {t(item.label)}
                </a>
              ) : item.kind === 'view' ? (
                // A real href into the console pane, so it can be copied or middle-clicked; the click
                // handler keeps an ordinary click client-side. Modified clicks are left alone —
                // swallowing cmd-click would turn "open in a new tab" into an in-place navigation.
                <a
                  key={item.label}
                  href={pathForView(locale, item.view)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                    e.preventDefault()
                    onEnter(undefined, pathForView(locale, item.view))
                  }}
                >
                  {t(item.label)}
                </a>
              ) : (
                <a key={item.label} href={item.href} target="_blank" rel="noopener noreferrer">
                  {t(item.label)}
                </a>
              ),
            )}
          </nav>

          {/* Before the CTA, not after: the switcher is a setting for reading the page, and putting
              it past the primary action makes it the last thing found on the widest screens and the
              first thing wrapped on the narrowest. */}
          {onLocale && (
            <LocaleToggle
              locale={locale}
              onLocale={onLocale}
              hrefFor={(l) => localePath(l, '/')}
            />
          )}

          {/* The label is wrapped so the narrowest phones can shorten it to "Open" in CSS. `aria-label`
              carries the full wording either way, so what a screen reader announces does not change with
              the viewport — the visual abbreviation is for space, not a different action. */}
          <button
            className="page-cta-sm"
            onClick={() => onEnter()}
            aria-label={t('Open the console')}
          >
            <span className="page-cta-label">{t('Open the console')}</span>
            <ArrowRightIcon size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="page-hero">
        <span className="eyebrow">{t('The browser agent with a wallet')}</span>
        <h1>
          {t('Ask for anything.')} <em>{t('It pays per call.')}</em>
        </h1>
        <p className="page-lede">
          Other chat sites give you one model and a monthly bill. This one holds a wallet: it reaches{' '}
          {num(counts.models)} models and {num(counts.apis)} callable APIs, pays for each one as it
          goes, and shows you the price before it does. Start with no account, no key and no card.
        </p>

        {/* A live input on the landing page, and it is the whole argument for this product: the
            thing being sold is "you can just type", so the hero demonstrates it rather than
            describing it. Submitting navigates to the console and sends the prompt, so the first
            thing a visitor does is the real thing and not a preview of it. */}
        <HeroPrompt onEnter={onEnter} />

        <div className="page-hero-chips">
          {[t('No sign-up'), t('No card'), t('Price before every charge')].map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>

        {/* A proof strip, in the same position Franklin puts its wallet card and terminal transcript.
            Ours is the live catalogue instead of a mock session: it is the claim this page rests on,
            and unlike a screenshot it cannot go stale. Anything still loading shows a dash. */}
        <dl className="page-figures">
          <div>
            <dt>{num(counts.models)}</dt>
            <dd>{t('models, one chat box')}</dd>
          </div>
          <div>
            <dt>{num(counts.free)}</dt>
            <dd>{t('free right now, no credential')}</dd>
          </div>
          <div>
            <dt>{num(counts.apis)}</dt>
            <dd>{t('callable APIs, priced per call')}</dd>
          </div>
          <div>
            <dt>{num(counts.categories)}</dt>
            <dd>{t('categories to browse')}</dd>
          </div>
        </dl>
      </section>

      <section className="page-band" id="how">
        <h2>{t('How it works')}</h2>
        <div className="page-steps">
          {stepsRows(t).map((s, i) => (
            <div key={s.title} className="page-step">
              <span className="page-step-n">{String(i + 1).padStart(2, '0')}</span>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="page-band page-band-alt" id="pay">
        <h2>{t('Three ways to pay, and one of them is free')}</h2>
        <p className="page-band-lede">
          {t('Which one you use is a choice you make when you need to, not a decision at the door.')}
        </p>
        <div className="page-cards">
          <article className="page-card">
            <CircleDollarSignIcon size={18} aria-hidden="true" />
            <h3>{t('Free, right now')}</h3>
            <p>
              {counts.free !== null && counts.free > 0
                ? `${counts.free} models`
                : 'A pool of models'}{' '}
              answer with no credential at all. Nothing to connect, nothing to sign.
            </p>
          </article>
          <article className="page-card">
            <WalletIcon size={18} aria-hidden="true" />
            <h3>{t('A wallet, per call')}</h3>
            <p>
              Connect a wallet to reach paid models and every callable API. Each charge is signed by
              you, in your wallet, showing the exact amount before it happens.
            </p>
          </article>
          <article className="page-card">
            <KeyRoundIcon size={18} aria-hidden="true" />
            <h3>{t('An account you already have')}</h3>
            <p>
              {t('Sign in on the platform and spend the quota on it. Your existing key works here the same way it works everywhere else.')}
            </p>
          </article>
        </div>

        {/* The terminal path, in the position Franklin numbers its install steps. Worth a place on this
            page rather than only in the docs: someone who wants an agent in their own shell is not
            served by "open the console", and burying the CLI makes the browser look like the only
            product. The package name is real and published — checked, not assumed. */}
        <div className="page-steps page-steps-tight">
          <div className="page-step">
            <span className="page-step-n">01</span>
            <h3>{t('Or run it in your terminal')}</h3>
            <p>
              {t('One npm install, Node 20+. The same gateway, the same per-call pricing, no browser.')}
            </p>
            <code className="page-code">npm i -g jarvisclaw</code>
          </div>
          <div className="page-step">
            <span className="page-step-n">02</span>
            <h3>{t('Start free')}</h3>
            <p>
              {t('The free models need no wallet and no key, in the terminal exactly as they do here.')}
            </p>
            <code className="page-code">jarvisclaw</code>
          </div>
          <div className="page-step">
            <span className="page-step-n">03</span>
            <h3>{t('Fund it when you need more')}</h3>
            <p>
              Send USDC to a wallet it generates for you. The balance is the cap — when it is empty,
              it stops rather than billing you.
            </p>
            <a
              className="page-step-link"
              href="https://docs.jarvisclaw.ai"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('Read the CLI docs')}
              <ArrowRightIcon size={12} aria-hidden="true" />
            </a>
          </div>
        </div>
      </section>

      <section className="page-band" id="what">
        <h2>{t('What is actually here')}</h2>
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
            <h3>{t('Prompts that already worked')}</h3>
            <p>
              A curated image gallery and over a hundred published video prompts, each with the
              frame it produced. Read a real one, edit it, run it — rather than guessing at an empty
              box.
            </p>
          </article>
          <article className="page-card">
            <TerminalIcon size={18} aria-hidden="true" />
            <h3>{t('The same API from your own code')}</h3>
            <p>
              {t('This console is one client of a public HTTP API. Anything you can do here works from the CLI or an SDK against the same gateway, at the same per-call price.')}
            </p>
          </article>
        </div>
      </section>

      {/* The comparison, in a table. Franklin's equivalent is the strongest thing on its page, and the
          reason is that it answers the question a visitor actually has — "why not just use the chat
          site I already pay for" — instead of listing features.
          Every cell here is a fact about this gateway, not a jab: the subscription column describes
          what a subscription is, and the row that matters most to us ("What it can reach") is the one
          where the difference is structural rather than a matter of degree. */}
      <section className="page-band" id="compare">
        <h2>{t('The same question, three ways to answer it')}</h2>
        <p className="page-band-lede">
          You want a five-second video, a gas-price lookup and a long chat. Here is what each kind of
          product does with that.
        </p>
        <div className="page-table-wrap">
          <table className="page-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="page-table-corner">&nbsp;</span>
                </th>
                <th scope="col">{t('A chat subscription')}</th>
                <th scope="col">{t('Raw API keys')}</th>
                <th scope="col" className="page-table-ours">
                  {t('This console')}
                </th>
              </tr>
            </thead>
            <tbody>
              {compareRows(t).map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td>{row.subscription}</td>
                  <td>{row.keys}</td>
                  <td className="page-table-ours">{row.ours}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* What you own, in Franklin's "The Commons" position. Ours is a shorter and more honest claim
          than theirs: their agent runs on your machine, so they can say the vendor disappearing changes
          nothing. This is a hosted gateway, so the truthful version is narrower — your keys never
          leave your wallet, your transcript never leaves your browser, and the same API is callable
          without this page. Overclaiming here would be the easiest lie on the page to tell. */}
      <section className="page-band" id="own">
        <h2>{t('What stays yours')}</h2>
        <div className="page-cards">
          {ownershipRows(t).map((o) => (
            <article className="page-card" key={o.title}>
              <h3>{o.title}</h3>
              <p>{o.desc}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="page-band page-band-alt" id="faq">
        <h2>{t('Questions people actually ask')}</h2>
        <div className="page-faq">
          {faqRows(t).map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="page-close">
        <h2>{t('Type something and see what it costs.')}</h2>
        <p>{t('The free models need nothing from you.')}</p>
        <button className="page-cta" onClick={() => onEnter()}>
          {t('Open the console')}
          <ArrowRightIcon size={15} aria-hidden="true" />
        </button>
      </section>

      <footer className="page-foot">
        {/* An inner wrapper, so the rule spans the window while the text lines up with the six sections
            above it. Padding alone left this against the window edge on a wide monitor. */}
        <div className="page-foot-inner">
          <span className="page-foot-brand">
            <img src="/jc.png" alt="" width={18} height={18} />
            JarvisClaw
          </span>
          <nav>
            <a href="https://docs.jarvisclaw.ai" target="_blank" rel="noopener noreferrer">
              Docs
            </a>
            {/* jarvisclaw.ai, not the API host. DEFAULT_BASE_URL is api.jarvisclaw.ai — a gateway, not a
                page — so "Platform" pointed a human at a machine endpoint. */}
            <a href="https://jarvisclaw.ai" target="_blank" rel="noopener noreferrer">
              Platform
            </a>
            <a href="https://blog.jarvisclaw.ai" target="_blank" rel="noopener noreferrer">
              Blog
            </a>
          </nav>
        </div>
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
  const t = useT()
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
        aria-label={t('What should it do?')}
      />
      <button type="submit">
        {t('Start')}
        <ArrowRightIcon size={14} aria-hidden="true" />
      </button>
    </form>
  )
}

/**
 * The comparison rows.
 *
 * Written as descriptions rather than as digs — a table whose middle columns are strawmen is a table
 * nobody believes, including about its own column. So "a chat subscription" gets credit for being
 * simple, and "raw API keys" gets credit for being the cheapest per token, because both are true and
 * the interesting difference is elsewhere.
 *
 * `ours` claims nothing this gateway does not do. In particular the price row says "quoted before it
 * runs", not "cheapest" — we resell some upstreams at their own price and cannot honestly claim to
 * undercut a direct key.
 */
const compareRows = (t: T) => [
  {
    label: t('What it can reach'),
    subscription: t('The models that vendor hosts. A video or an on-chain lookup is a different product.'),
    keys: t('Whatever you have signed up for, one account and one key at a time.'),
    ours: t('Every model and every callable API behind one box — chat, image, video, music, speech, data.'),
  },
  {
    label: t('What you pay'),
    subscription: t('A monthly fee, whether you used it or not.'),
    keys: t('Per token, per provider, on a card that has to clear first.'),
    ours: t('Per call, quoted before it runs, and you approve that exact amount.'),
  },
  {
    label: t('To start'),
    subscription: t('Email, password, card.'),
    keys: t('An account and a key per provider, each with its own billing.'),
    ours: t('Nothing. The free models answer with no credential at all.'),
  },
  {
    label: t('When you run out'),
    subscription: t('Rate limits, usually when you need it most.'),
    keys: t('A failed call and an email about your card.'),
    ours: t('It stops. The wallet balance and your session budget are the only caps.'),
  },
  {
    label: t('What it knows about you'),
    subscription: t('An account, a history, and a payment profile.'),
    keys: t('One account per provider.'),
    ours: t('Nothing, if you use it anonymously. Conversations stay in this browser.'),
  },
]

/**
 * What stays with the user.
 *
 * Deliberately narrower than Franklin's equivalent. Theirs runs on your machine, so it can say the
 * vendor vanishing changes nothing; this is a hosted gateway, and the same claim would be false.
 * What IS true is stated exactly: keys never leave the wallet, the transcript never leaves the
 * browser, and the API is callable without this page.
 */
const ownershipRows = (t: T) => [
  {
    title: t('Your keys'),
    desc: t('Private keys never leave your wallet. This page asks it to sign each payment and never sees one. An API key, if you use one, is held in that tab only and never stored.'),
  },
  {
    title: t('Your conversations'),
    desc: t('The transcript lives in this browser, not in an account. That cuts both ways and the FAQ says so: nothing to leak, and nothing that follows you to another device.'),
  },
  {
    title: t('Your way out'),
    desc: t('This console is one client of a public HTTP API. The CLI, an SDK or plain curl reach the same gateway at the same per-call price, so nothing here is the only door.'),
  },
]

const stepsRows = (t: T) => [
  {
    title: t('Ask for what you want'),
    desc: t('Plain language. The agent picks the model or the API — you do not have to know which one exists.'),
  },
  {
    title: t('See the price first'),
    desc: t('Anything that costs money is quoted before it runs, and you approve that exact amount. Nothing is charged on a guess.'),
  },
  {
    title: t('Keep what it makes'),
    desc: t('Images, video, music and speech are collected in your gallery with what each one cost, and every row says how long that file lasts.'),
  },
]

/**
 * Answers to the things that stop someone using this, not a feature list.
 *
 * Two of these are uncomfortable and are here for that reason: media retention has real limits, and
 * the history lives in one browser because there is no account. Someone who finds that out from the
 * FAQ can plan around it. Someone who finds it out by losing a file cannot.
 */
const faqRows = (t: T) => [
  {
    q: t('Do I need an account?'),
    a: t('No. The free models answer with no credential at all — no key, no wallet, no card. An account or a wallet is only needed to reach paid models and the callable APIs.'),
  },
  {
    q: t('How do I know what something costs before I pay?'),
    a: t('Every paid call is quoted first and you approve that exact amount. Per-token models show their rate in the picker; per-call ones cannot be known from a rate card, so the gateway returns a quote for your specific request and the dialog shows it.'),
  },
  {
    q: t('Where does my generated media go?'),
    a: t('Most of it is copied to our own CDN and kept with no expiry. Some cannot be — an archive can fail, and speech arrives as raw bytes with no URL to copy from — so every row in the gallery says which case it is and warns you when a file is on a clock. Download the ones that are.'),
  },
  {
    q: t('Is my conversation history saved?'),
    a: t('In this browser. There is no account to attach it to, so clearing site data loses the list and it does not follow you to another device. Media that reached the CDN survives either way; the transcript does not.'),
  },
  {
    q: t('What happens to my wallet keys?'),
    a: t('They never leave your wallet. This page asks it to sign each payment and never sees a private key. An API key, if you use one, is held in that tab only and never stored.'),
  },
  {
    q: t('Can I use this from my own code?'),
    a: t('Yes — this console is one client of a public HTTP API. Anything you can do here you can do from the CLI or an SDK against the same gateway, with the same per-call pricing.'),
  },
]
