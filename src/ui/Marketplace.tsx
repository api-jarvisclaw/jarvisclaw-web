import { useEffect, useMemo, useRef, useState } from 'react'

import {
  categoryLabel,
  listApis,
  listMarketplace,
  type MarketplaceApi,
  type MarketplaceCategory,
  type MarketplaceService,
} from '../lib/catalogue'
import { useT } from './LocaleContext'

/**
 * The marketplace browser.
 *
 * Reads the gateway's own catalogue. Nothing here is a hand-kept list: a catalogue transcribed
 * into the frontend goes stale the first time a service is added, and then the page lies about
 * what the gateway can do.
 *
 * ## Why categories
 *
 * The page used to render one card per SERVICE, which sounds reasonable until you count what is
 * behind them: of 2,767 advertised endpoints, **2,721 sit under a single service named `api`**.
 * So the page showed one card labelled "api / 2721 endpoints" beside seventeen cards holding one
 * endpoint each. Everything worth finding was behind the least informative label on the page, and
 * the only way in was to already know what to type in the search box — which is precisely the
 * problem a newcomer has.
 *
 * Categories come from the gateway's own `categories` facet with server-side `category=`
 * filtering, so each heading's count is true across all 2,720 rows rather than true of whatever
 * happened to be downloaded. See the note in catalogue.ts for why the upstream labels are used
 * as-is instead of being re-derived here — briefly: I measured them as 46% accurate, that
 * measurement was wrong, and they are consistent once you know they key on lookup mechanism.
 */

/** Fewer rows than this and the count line adds nothing a glance does not already give. */
const PAGE_SIZE = 24

/**
 * The line under the heading, describing the tier that is actually on screen.
 *
 * Exported so it can be tested directly. It has to get three separate things right and each one
 * was wrong at some point:
 *
 *   - WHICH TIER. Saying "2,720 callable endpoints" over a curated few hundred makes the raw size
 *     the headline and the selection look like a broken filter, which is the thing the report
 *     said not to lead with.
 *   - THAT TIER'S SIZE. The first version summed the per-category facet. That is right for the
 *     complete listing and wrong for the curated one, whose facet is capped per category — a
 *     browser probe caught it reading "12 picks" for a 186-row tier.
 *   - PLURALISATION. "1 categories" was on screen until a probe printed the header verbatim.
 */
export function marketHeadline(
  opts: {
    curated: boolean
    curatedTotal: number
    completeTotal: number
    /** Sum of the category facet, used only when the gateway reports no tier sizes. */
    facetTotal: number
    categoryCount: number
  },
  /**
   * The lookup, optional so the existing tests can call this without a provider.
   *
   * Defaulting to identity is not a shortcut here: this function's whole job is assembling a
   * sentence, and the assembly rules differ by language. English needs category/categories;
   * Chinese needs neither, which is precisely why the plural choice happens on the ENGLISH side of
   * the interpolation and the whole clause is one key.
   */
  t: (key: string, vars?: Record<string, string | number>) => string = (k, v) => {
    let out = k
    for (const [key, val] of Object.entries(v ?? {})) out = out.split(`{${key}}`).join(String(val))
    return out
  },
): string {
  const size = opts.curated ? opts.curatedTotal : opts.completeTotal
  // The facet sum is the fallback for a gateway that does not report tier sizes — an older one,
  // or one where the fields were dropped. Zero would print "0 picks" over a full grid of results.
  const n = size > 0 ? size : opts.facetTotal
  if (n <= 0) return ''
  // Pluralised in English, then interpolated. Chinese has no plural form, so a translation of
  // "category"/"categories" separately would produce the same word twice and read as a bug in the
  // catalogue rather than a property of the language.
  const cats = t(opts.categoryCount === 1 ? '{n} category' : '{n} categories', {
    n: opts.categoryCount,
  })
  const what = opts.curated
    ? t('{n} picks across {cats}, chosen for a first look.', { n: n.toLocaleString(), cats })
    : t('{n} callable endpoints across {cats}.', { n: n.toLocaleString(), cats })
  return `${what} ${t('Paid per call — the agent asks before it spends.')}`
}

export function Marketplace({
  baseUrl,
  onAsk,
}: {
  baseUrl: string
  onAsk: (prompt: string) => void
}) {
  const t = useT()
  const [services, setServices] = useState<MarketplaceService[]>([])
  const [categories, setCategories] = useState<MarketplaceCategory[]>([])
  const [apis, setApis] = useState<MarketplaceApi[]>([])
  const [total, setTotal] = useState(0)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  /**
   * Curated by default, and this is the fix for the reported problem rather than a preference.
   *
   * The raw listing is 2,720 rows assembled from 70 upstreams, and a first visit met it head
   * on. Reported: duplicate entries on page one and endpoints filed under categories that make
   * no sense — the marks of auto-generated bulk. A developer who reads the hero API's docs and
   * then browses that is being shown the least trustworthy view we have.
   *
   * The complete listing stays one click away, labelled with its real size. Hiding it would be
   * worse than showing it first: the breadth is real, and someone looking for a specific
   * endpoint needs all of it.
   */
  const [curated, setCurated] = useState(true)
  const [tiers, setTiers] = useState({ curated: 0, complete: 0 })
  const [servedCurated, setServedCurated] = useState(true)

  // The services list is the small, stable half: 18 rows that do not depend on the filter, so it
  // is fetched once rather than on every category click.
  useEffect(() => {
    const abort = new AbortController()
    listMarketplace({ baseUrl, signal: abort.signal })
      .then(setServices)
      .catch(() => {
        // Not surfaced. The services strip is supplementary — the categories below are the real
        // navigation, and failing the whole page because a secondary list did not load would hide
        // a working marketplace.
      })
    return () => abort.abort()
  }, [baseUrl])

  /**
   * Debounced, and that matters for a reason beyond politeness: without it every keystroke fires
   * a request against a 2,720-row catalogue and the responses can land out of order, so the list
   * ends up showing results for a prefix of what is in the box. The abort below is what actually
   * prevents that; the delay is what stops us sending twelve requests to type one word.
   */
  const debounced = useDebounced(query, 250)

  useEffect(() => {
    const abort = new AbortController()
    setState((s) => (s === 'ready' ? 'ready' : 'loading'))
    listApis({
      baseUrl,
      signal: abort.signal,
      page,
      pageSize: PAGE_SIZE,
      category: category ?? undefined,
      query: debounced || undefined,
      curated,
    })
      .then((res) => {
        setApis(res.items)
        setTotal(res.total)
        // The facet comes back with every response and is unfiltered, so it is safe to take from
        // any of them. Taken from the latest rather than cached from the first, so a category
        // added upstream shows up without a reload.
        if (res.categories.length > 0) setCategories(res.categories)
        setTiers({ curated: res.curatedTotal, complete: res.completeTotal })
        // What the gateway SERVED, not what was requested: it falls back to the complete
        // listing rather than present an empty marketplace, and the label has to follow.
        setServedCurated(res.curated)
        setState('ready')
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
        setState('failed')
      })
    return () => abort.abort()
  }, [baseUrl, page, category, debounced, curated])

  // Changing the filter must reset the page, or picking a 9-row category while on page 4 shows an
  // empty grid — which reads as "this category is empty" rather than "you are past the end".
  //
  // `curated` belongs here for a sharper version of the same reason: the curated tier is a few
  // hundred rows and the complete one is thousands, so switching from page 6 of everything to
  // the curated tier would land past its end and show nothing at all.
  useEffect(() => {
    setPage(1)
  }, [category, debounced, curated])

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const catTotal = useMemo(() => categories.reduce((n, c) => n + c.count, 0), [categories])

  /**
   * The header line, describing the tier actually on screen.
   *
   * Built here rather than inline because it has to get three things right at once: which tier,
   * that tier's real size, and singular-vs-plural. The nested ternary it replaces got the size
   * wrong (it summed the per-category facet, which the curated tier caps) and always said
   * "categories", so a one-category listing read "1 categories".
   */
  const headline = useMemo(
    () =>
      marketHeadline(
        {
          curated: servedCurated,
          curatedTotal: tiers.curated,
          completeTotal: tiers.complete,
          facetTotal: catTotal,
          categoryCount: categories.length,
        },
        t,
      ),
    // `t` in the deps: it changes identity when the locale changes, and without it the headline
    // would stay in the previous language until one of the counts happened to move.
    [servedCurated, tiers, catTotal, categories.length, t],
  )

  return (
    <div className="market">
      <header className="market-head">
        <h1>{t('Marketplace')}</h1>
        {/* The subtitle describes the tier being shown, not the catalogue as a whole. Leading
            with "2,720 endpoints" while displaying a curated few hundred would make the number
            the headline and the selection look like a broken filter — and the size of the raw
            listing is exactly what the report said not to lead with.

            The count comes from the served tier's own total, not from summing the facet. They
            agree on an unfiltered page, but the facet is capped per category in the curated
            tier, so summing it understated the tier — a probe caught it reading "12 picks" for
            a 186-row listing. */}
        <p>
          {headline !== '' ? headline : 'Live from the gateway’s own catalogue.'}
        </p>
        <input
          className="market-search"
          type="search"
          value={query}
          placeholder={t('search endpoints')}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* The way out of the curated tier, and into it.

            Rendered only when the two tiers actually differ: on a gateway that does not curate
            (or one old enough not to know the flag) both counts are the same number, and a
            toggle between two identical listings is a control that appears broken. */}
        {tiers.complete > tiers.curated && (
          <button
            className="market-tier"
            onClick={() => setCurated((c) => !c)}
            aria-pressed={!curated}
          >
            {servedCurated
              ? `Show all ${tiers.complete.toLocaleString()} endpoints`
              : `Show the ${tiers.curated.toLocaleString()} curated picks`}
          </button>
        )}
      </header>

      {/* Categories first, above the results. A newcomer's problem is not filtering a list they
          can already see — it is not knowing what is on offer, so the choices have to be visible
          before the results are. */}
      {categories.length > 0 && (
        <nav className="market-cats" aria-label={t('Categories')}>
          <button
            className={category === null ? 'market-cat is-on' : 'market-cat'}
            onClick={() => setCategory(null)}
          >
            {t('All')}
            <span className="market-cat-n">{catTotal.toLocaleString()}</span>
          </button>
          {categories.map((c) => (
            <button
              key={c.category}
              className={category === c.category ? 'market-cat is-on' : 'market-cat'}
              onClick={() =>
                // Clicking the active category clears it. A filter with no visible way out is a
                // dead end, and the "All" button is easy to miss once the list has scrolled.
                setCategory((cur) => (cur === c.category ? null : c.category))
              }
            >
              {c.label}
              <span className="market-cat-n">{c.count.toLocaleString()}</span>
            </button>
          ))}
        </nav>
      )}

      {state === 'loading' && <p className="market-note">{t('Loading the catalogue…')}</p>}

      {state === 'failed' && (
        // Named as a gateway failure rather than an empty marketplace: "no services"
        // and "could not reach the gateway" are different facts, and showing the first
        // when the second happened is how a working marketplace looks broken.
        <p className="market-note market-note-error">
          Could not load the catalogue from the gateway: {error}
        </p>
      )}

      {state === 'ready' && (
        <>
          <p className="market-count-line">
            {total.toLocaleString()} {total === 1 ? 'endpoint' : 'endpoints'}
            {category !== null && ` in ${categoryLabel(category)}`}
            {debounced !== '' && ` matching “${debounced}”`}
            {pages > 1 && ` · page ${page} of ${pages}`}
          </p>

          {apis.length === 0 && (
            /**
             * "Nothing matches" is a false statement while the curated tier is on: the endpoint
             * probably exists and is simply not among the picks. Searching a few hundred rows and
             * being told the platform has nothing is how a real capability gets missed, so the
             * empty state offers the whole catalogue instead of asking the user to guess.
             */
            <p className="market-note">
              {servedCurated && tiers.complete > tiers.curated ? (
                <>
                  Nothing in the curated picks matches.{' '}
                  <button className="link-btn" onClick={() => setCurated(false)}>
                    Search all {tiers.complete.toLocaleString()} endpoints
                  </button>
                  .
                </>
              ) : (
                'Nothing here matches. Try a different category, or clear the search.'
              )}
            </p>
          )}

          <div className="market-grid">
            {apis.map((a) => (
              <article key={a.resourceId} className="market-card">
                <h2>{a.name}</h2>
                <p className="market-count">
                  {/* The real per-call price, not a range. Federation endpoints are flat-priced,
                      so this is the number that will be charged — unlike the models, whose cost
                      only exists in a 402 quote for a specific request. */}
                  ${a.priceUsd.toFixed(4)} per call
                  {a.category !== '' && ` · ${categoryLabel(a.category)}`}
                </p>
                {a.description !== '' && <p className="market-desc">{a.description}</p>}
                {/* Hands the endpoint to the agent rather than calling it directly: choosing the
                    parameters is the agent's job, and a form here would need to know all 2,720
                    shapes. The resource id is included because that is how the endpoint is
                    addressed, and without it the agent has to search for the name again. */}
                <button
                  className="market-ask"
                  onClick={() =>
                    onAsk(
                      `Use the "${a.name}" marketplace endpoint (resource ${a.resourceId}, $${a.priceUsd.toFixed(4)} per call). What does it need from me?`,
                    )
                  }
                >
                  {t('Ask the agent')}
                </button>
              </article>
            ))}
          </div>

          {pages > 1 && (
            <div className="market-pager">
              <button
                className="market-page-btn"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                {t('Previous')}
              </button>
              <span className="market-page-at">
                {page} / {pages}
              </span>
              <button
                className="market-page-btn"
                disabled={page >= pages}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
              >
                {t('Next')}
              </button>
            </div>
          )}
        </>
      )}

      {/* The named services, kept but demoted. These are whole provider surfaces rather than
          single endpoints, so they belong on the page — just not as the primary navigation they
          used to be, where "api / 2721 endpoints" sat beside seventeen one-endpoint cards. */}
      {services.length > 0 && (
        <section className="market-services">
          <h2>{t('Named services')}</h2>
          <p className="market-note">
            Whole provider surfaces, callable directly under <code>/v1/marketplace/</code>.
          </p>
          <div className="market-chips">
            {services
              // `api` is the federated catalogue itself — the thing the whole page above already
              // shows. Listing it here as a peer of `exa` would send someone who clicks it into a
              // conversation about a container rather than a capability.
              .filter((s) => s.service !== 'api')
              .map((s) => (
                <button
                  key={s.service}
                  className="market-chip"
                  onClick={() => onAsk(`What can the ${s.service} service do, and what does it cost?`)}
                >
                  {s.service}
                </button>
              ))}
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * A value that settles before it is used.
 *
 * Its own hook because the search box needs it and nothing else here does. The timer is cleared on
 * every change, so a fast typist sends exactly one request.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSettled(value), ms)
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [value, ms])
  return settled
}
