import { getJson, type RequestOptions } from './gateway'

/**
 * The gateway's public catalogue: what models exist, what they cost, and what the
 * marketplace can do.
 *
 * Both endpoints used here are anonymous — no credential, no account. That is what lets
 * the picker and the marketplace browser work on a first visit, which is the entire point
 * of this page. `/v1/models` needs a credential and is deliberately NOT used.
 */

export interface CatalogueModel {
  model: string
  inputPerMTokenUsd: number
  outputPerMTokenUsd: number
  pricingType: string
  free: boolean
  /** Set for `auto/*`: the gateway resolves these per request. */
  virtual: boolean
  modality: Modality
}

export type Modality = 'text' | 'image' | 'video' | 'audio' | 'embedding' | 'other'

interface RawModel {
  model?: string
  input_per_m_token_usd?: number
  output_per_m_token_usd?: number
  pricing_type?: string
  free?: boolean
}

/**
 * Modality is inferred from the name, because the catalogue does not carry the field.
 *
 * Checked against all 334 models the gateway currently advertises: **no name matches more
 * than one of these patterns**, so the order of the branches below decides nothing today.
 * Worth stating, because the arrangement looks like a precedence rule — and asking someone
 * to preserve an order that carries no meaning is its own trap. A test pins the property
 * that actually matters (no double match), not an ordering that does not exist.
 *
 * `auto/*` is the real hazard and is handled separately: the gateway resolves those itself,
 * and their names carry no usable keyword — `auto/video` would fall through to text, and
 * `auto/tts` names no modality at all. They come from an exact table.
 */
const EXACT_VIRTUAL: Record<string, Modality> = {
  'auto/free': 'text',
  'auto/eco': 'text',
  'auto/premium': 'text',
  'auto/search': 'text',
  'auto/image': 'image',
  'auto/video': 'video',
  'auto/music': 'audio',
  'auto/tts': 'audio',
}

/**
 * Exported so the test reads these patterns rather than its own copies of them.
 *
 * That distinction mattered: my first version of the no-double-match test inlined the
 * regexes, so broadening one in this file left the test green while the property it claimed
 * to protect was broken. A test that duplicates the thing it checks is checking the
 * duplicate.
 */
export const MODALITY_PATTERNS: Array<[Modality, RegExp]> = [
  ['embedding', /embed|rerank/],
  ['audio', /music|audio|tts|speech|voice|elevenlabs|whisper|suno/],
  ['video', /video|seedance|veo|sora|kling|wan-?\d|imagine-video/],
  ['image', /image|flux|dall|sd3|seedream|midjourney/],
]

export function inferModality(model: string): Modality {
  const m = model.toLowerCase()
  if (m in EXACT_VIRTUAL) return EXACT_VIRTUAL[m]
  for (const [modality, pattern] of MODALITY_PATTERNS) {
    if (pattern.test(m)) return modality
  }
  return 'text'
}

/** Price to show in a picker: the output rate, which dominates any real conversation. */
export function displayPrice(m: CatalogueModel): string {
  if (m.free) return 'free'
  // per-call models report 0/0 here: the real number only exists in the 402 quote for a
  // specific request, so promising a figure would be inventing one.
  if (m.outputPerMTokenUsd === 0 && m.inputPerMTokenUsd === 0) return 'quoted per call'
  return `$${m.outputPerMTokenUsd.toFixed(2)}/M out`
}

export async function listCatalogue(opts: RequestOptions = {}): Promise<CatalogueModel[]> {
  const res = await getJson<{ data?: RawModel[] }>('/api/discovery/models', opts)
  const rows = Array.isArray(res?.data) ? res.data : []
  return rows
    .filter((r): r is RawModel & { model: string } => typeof r.model === 'string' && r.model !== '')
    .map((r) => ({
      model: r.model,
      inputPerMTokenUsd: Number(r.input_per_m_token_usd ?? 0),
      outputPerMTokenUsd: Number(r.output_per_m_token_usd ?? 0),
      pricingType: r.pricing_type ?? 'unknown',
      free: r.free === true,
      virtual: r.model.startsWith('auto/'),
      modality: inferModality(r.model),
    }))
}

export interface MarketplaceService {
  /** Path segment under /v1/marketplace, e.g. "exa". */
  service: string
  endpoints: number
  /** One example endpoint, so the UI can show what a service actually offers. */
  sample: string
  description: string
}

/**
 * One browsable category of the federated API catalogue.
 *
 * This is the answer to a real navigation problem rather than a decoration. The catalogue is
 * 2,767 endpoints, and **2,721 of them sit under a single service called `api`** — so the
 * marketplace page rendered one card labelled "api / 2721 endpoints" next to seventeen cards
 * holding one endpoint each. Everything worth finding was behind the least informative label
 * on the page.
 */
export interface MarketplaceCategory {
  /** The value to send as `category=`. */
  category: string
  count: number
  /** A human label; the wire value is a bare lowercase token like `dns`. */
  label: string
}

/**
 * A federated API endpoint, as the catalogue lists it.
 *
 * Distinct from MarketplaceService: a service is a whole provider surface, this is one callable
 * endpoint with its own price.
 */
export interface MarketplaceApi {
  resourceId: number
  name: string
  description: string
  category: string
  /** USD per call. Federation endpoints are flat-priced, unlike models. */
  priceUsd: number
  method: string
}

interface RawApiRow {
  resource_id?: number
  name?: string
  description?: string
  category?: string
  display_price?: number
  method?: string
}

/**
 * Display labels for the categories the gateway actually returns.
 *
 * Only labels — never a REMAPPING of which endpoints belong where. That distinction is the whole
 * design decision here, and it went the other way first.
 *
 * My first attempt derived categories client-side from names and descriptions, because the
 * upstream labels look wrong on inspection: `dns` contains "Labor Unemployment", `qr` contains
 * "Music Release". Measured against names alone, only 46% of labelled rows had a name that
 * matched their label.
 *
 * That measurement was wrong, and its conclusion with it. Judged against name AND description —
 * which is what the label is actually assigned from — the same categories score 100% for `dns`,
 * `qr`, `email` and `code`, and 95% for `search`. "Labor Unemployment" is filed under `dns`
 * because its description says the data is national or **by domain**; "Music Release" resolves an
 * album **by barcode**, which is what `qr` means here. The labels are keyed on the lookup
 * mechanism, not the subject matter. Odd, defensible, and — critically — consistent.
 *
 * So a client-side taxonomy would have replaced a consistent scheme with my own guesses, and it
 * could only ever categorise the page of rows already downloaded. `category=` filters SERVER-side
 * with correct totals across all 2,720 rows (measured: `category=video` -> total 22, and it
 * composes with `q=`). A client-side scheme cannot produce a true count, so every category
 * heading would have been a lie about how much is behind it.
 *
 * Unknown categories are NOT dropped — they fall through to a title-cased version of the wire
 * value. That is not politeness, it is necessary: the live facet grew from 18 categories to 26
 * between writing this and deploying it. A lookup that returned '' for a miss would have silently
 * hidden six categories and made their endpoints reachable only by search.
 *
 * ## Labels stay ONE-TO-ONE with wire values
 *
 * Some of those new categories overlap the old ones — `crypto` (3 rows) beside `blockchain` (238),
 * `web scraping` (2) beside `web` (35), plus singletons like `ai tools`. Mapping each pair to a
 * shared label is the obvious tidy-up, and it is wrong: `category=` accepts exactly one value.
 * Measured:
 *
 *   category=web                          -> 35
 *   category=web%20scraping               -> 2
 *   category=web&category=web%20scraping  -> 35   (the second is ignored)
 *   category=web,web%20scraping           -> 0    (read as one literal name)
 *
 * A merged pill would have to sum the counts and then filter by one of them, promising 37
 * endpoints and delivering 35. That is exactly the lie this design exists to avoid — the counts
 * come from the server so that a heading can be trusted. Two similar pills is a smaller problem
 * than one dishonest pill; the real fix belongs upstream, where the categories are assigned.
 */
export const CATEGORY_LABELS: Record<string, string> = {
  general: 'General',
  search: 'Search & Research',
  blockchain: 'Crypto & Blockchain',
  code: 'Code & Developer',
  dns: 'Domains & Web Intel',
  image: 'Image',
  llm: 'Language Models',
  document: 'Documents',
  email: 'Email & Outreach',
  web: 'Web Scraping',
  geo: 'Location & Maps',
  ocr: 'OCR & Extraction',
  video: 'Video',
  qr: 'Barcodes & QR',
  social: 'Social & Community',
  content: 'Writing & Content',
  utility: 'Screenshots & Render',
  audio: 'Audio & Music',
  storage: 'Storage',
  tts: 'Text to Speech',
}

export function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category]
  if (known !== undefined) return known
  // Title-case the wire value so an upstream addition reads acceptably before anyone labels it,
  // rather than being hidden. Separators become spaces: `quantum_stuff` is a wire token, and
  // "Quantum_Stuff" would look like a bug in the label rather than a category nobody named yet.
  return category
    .split(/[\s_-]+/)
    .filter((w) => w !== '')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

interface RawResource {
  endpoint?: string
  description?: string
  type?: string
}

/**
 * Groups the x402 catalogue's marketplace resources by service.
 *
 * The document is ~770 KB and lists 2700+ endpoints; a flat list of those is not a
 * browsable thing. Grouping by the first path segment gives the ~dozens of services a
 * person actually chooses between.
 */
export async function listMarketplace(opts: RequestOptions = {}): Promise<MarketplaceService[]> {
  const res = await getJson<{ resources?: RawResource[] }>('/.well-known/x402', opts)
  const rows = Array.isArray(res?.resources) ? res.resources : []

  const byService = new Map<string, { endpoints: number; sample: string; description: string }>()
  for (const r of rows) {
    const ep = r.endpoint ?? ''
    const marker = '/v1/marketplace/'
    if (!ep.startsWith(marker)) continue
    const rest = ep.slice(marker.length)
    const service = rest.split('/')[0]
    if (service === '') continue
    const existing = byService.get(service)
    if (existing) {
      existing.endpoints += 1
      // Keep the first description that says something; many entries have none.
      if (existing.description === '' && r.description) existing.description = r.description
    } else {
      byService.set(service, { endpoints: 1, sample: rest, description: r.description ?? '' })
    }
  }

  return [...byService.entries()]
    .map(([service, v]) => ({ service, ...v }))
    .sort((a, b) => b.endpoints - a.endpoints || a.service.localeCompare(b.service))
}

export interface ApiPage {
  items: MarketplaceApi[]
  /** Rows matching the filter across the WHOLE catalogue, not just this page. */
  total: number
  categories: MarketplaceCategory[]
  /**
   * Which tier the gateway actually served. Not the same as what was asked for: a curated
   * request falls back to the complete listing rather than present an empty marketplace, and a
   * UI that labelled that page "curated" would be describing something else.
   */
  curated: boolean
  /** Size of each tier, so the UI can offer the other one by name without a second request. */
  curatedTotal: number
  completeTotal: number
}

/**
 * One page of the federated API catalogue, filtered by category and/or free text.
 *
 * `/api/marketplace/apis` rather than `/.well-known/x402`, and the reason is not preference: the
 * x402 document is ~840 KB, carries every endpoint in one response, and has no per-row
 * description. This endpoint pages, filters server-side, and returns a real `total` for the
 * filter — which is what lets a category heading state how much is behind it truthfully.
 *
 * Anonymous, like everything else in this file. Browsing the catalogue must work on a first visit
 * with no account, because the point of the marketplace page is to show someone what they could
 * do before asking them for anything.
 */
export async function listApis(
  opts: RequestOptions & {
    page?: number
    pageSize?: number
    category?: string
    query?: string
    /**
     * Ask for the browsable subset instead of every callable row.
     *
     * Opt-in on the wire because the endpoint is unauthenticated and already read by
     * aggregators and our own agent tooling; the browsing UI sets it, nothing else does.
     */
    curated?: boolean
  } = {},
): Promise<ApiPage> {
  const params = new URLSearchParams({
    page: String(opts.page ?? 1),
    page_size: String(opts.pageSize ?? 24),
  })
  if (opts.curated) params.set('curated', '1')
  // Omitted rather than sent empty. `category=` with no value is not the same request as no
  // `category` at all, and relying on the gateway to treat them alike is an assumption this code
  // does not need to make.
  if (opts.category) params.set('category', opts.category)
  if (opts.query) params.set('q', opts.query)

  /**
   * `data`, not the bare body. Measured against production:
   *
   *   {"data": {"items": [...], "total": 2720, "categories": [...]}, "success": true}
   *
   * This is the platform's API envelope, and it differs from `/api/discovery/models` and
   * `/.well-known/x402` used above, which return their payload at the top level. Reading `items`
   * off the outer object finds nothing and reports an EMPTY marketplace for a working gateway —
   * the same class of mistake as reading `/api/token/` as a bare array, noted in account.ts.
   */
  const env = await getJson<{
    data?: {
      items?: RawApiRow[]
      total?: number
      categories?: Array<{ category?: string; count?: number }>
      curated?: boolean
      curated_total?: number
      complete_total?: number
    }
  }>(`/api/marketplace/apis?${params.toString()}`, opts)
  const res = env?.data

  const rows = Array.isArray(res?.items) ? res.items : []
  return {
    items: rows
      .filter((r): r is RawApiRow & { resource_id: number } => typeof r.resource_id === 'number')
      .map((r) => ({
        resourceId: r.resource_id,
        name: r.name || `endpoint ${r.resource_id}`,
        description: r.description ?? '',
        category: r.category ?? '',
        priceUsd: Number(r.display_price ?? 0),
        method: r.method || 'POST',
      })),
    total: Number(res?.total ?? 0),
    categories: (Array.isArray(res?.categories) ? res.categories : [])
      .filter((c): c is { category: string; count: number } => typeof c.category === 'string')
      .map((c) => ({
        category: c.category,
        count: Number(c.count ?? 0),
        label: categoryLabel(c.category),
      })),
    curated: res?.curated === true,
    /**
     * Falls back to `total` rather than 0 when the field is missing, which is what an older
     * gateway returns. Zero would render "0 of 0 endpoints" against a full grid of results —
     * a UI that contradicts itself — whereas `total` degrades to the one honest number
     * available: the tier counts collapse and the toggle hides itself.
     */
    curatedTotal: Number(res?.curated_total ?? res?.total ?? 0),
    completeTotal: Number(res?.complete_total ?? res?.total ?? 0),
  }
}
