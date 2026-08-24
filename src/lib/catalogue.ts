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
