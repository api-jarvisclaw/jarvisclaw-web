import { type CatalogueModel } from '../lib/catalogue'

/**
 * The console's empty state: a hero and six starters, nothing more.
 *
 * The marketing content that briefly lived here moved to `LandingPage.tsx` on its own route. It was
 * the wrong shape in this position: the console is a three-column grid with fixed panes either side,
 * so a landing page rendered here sat in an 860px column between two sidebars. A landing page is
 * full-bleed or it is not one.
 *
 * What stays is what belongs to a chat screen — a line saying what this is, and six things to try.
 * The counts are still read live, because they are still a claim.
 */
export function Landing({
  models,
  marketplaceTotal,
  onSuggestion,
}: {
  models: CatalogueModel[]
  /** Callable marketplace endpoints, or null while still loading. */
  marketplaceTotal: number | null
  onSuggestion: (text: string) => void
}) {
  // A dash, never 0. "0 callable APIs" on a screen still fetching reads as an empty product.
  const num = (n: number | null) => (n === null || n === 0 ? '—' : n.toLocaleString())

  return (
    <div className="empty">
      <span className="eyebrow">The agent with a wallet</span>
      <h1>
        What should <em>JarvisClaw</em> do?
      </h1>
      <p>
        {num(models.length)} models and {num(marketplaceTotal)} callable APIs, paid per call. Start
        now — no account, no key, no card. Anything paid shows its price and asks first.
      </p>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="suggestion" onClick={() => onSuggestion(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Starters, each one something this gateway can actually do — the marketplace really does carry
 * search, on-chain and prediction-market services, and the catalogue really does expose per-model
 * pricing. A suggestion that fails on click is worse than none: it is the first thing a new visitor
 * tries.
 */
const SUGGESTIONS = [
  'What can you do, and what does it cost?',
  'Find me an API for Ethereum gas prices.',
  'Which models are free right now?',
  'Search the marketplace for on-chain data services.',
  'What would a 5-second video cost me?',
  'Compare the cheapest and most capable chat models.',
]
