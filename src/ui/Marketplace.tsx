import { useEffect, useMemo, useState } from 'react'

import { listMarketplace, type MarketplaceService } from '../lib/catalogue'

/**
 * The marketplace browser.
 *
 * Reads the gateway's own x402 discovery document, which advertises the callable services
 * and their endpoints. Nothing here is a hand-kept list: a catalogue transcribed into the
 * frontend goes stale the first time a service is added, and then the page lies about what
 * the gateway can do.
 */
export function Marketplace({
  baseUrl,
  onAsk,
}: {
  baseUrl: string
  onAsk: (prompt: string) => void
}) {
  const [services, setServices] = useState<MarketplaceService[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const abort = new AbortController()
    setState('loading')
    listMarketplace({ baseUrl, signal: abort.signal })
      .then((rows) => {
        setServices(rows)
        setState('ready')
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
        setState('failed')
      })
    return () => abort.abort()
  }, [baseUrl])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return services
    return services.filter(
      (s) => s.service.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    )
  }, [services, query])

  const total = useMemo(() => services.reduce((n, s) => n + s.endpoints, 0), [services])

  return (
    <div className="market">
      <header className="market-head">
        <h1>Marketplace</h1>
        <p>
          {state === 'ready'
            ? `${services.length} services, ${total.toLocaleString()} callable endpoints. Paid per call — the agent asks before it spends.`
            : 'Live from the gateway’s x402 discovery document.'}
        </p>
        <input
          className="market-search"
          type="search"
          value={query}
          placeholder="search services"
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>

      {state === 'loading' && <p className="market-note">Loading the catalogue…</p>}

      {state === 'failed' && (
        // Named as a gateway failure rather than an empty marketplace: "no services"
        // and "could not reach the gateway" are different facts, and showing the first
        // when the second happened is how a working marketplace looks broken.
        <p className="market-note market-note-error">
          Could not load the catalogue from the gateway: {error}
        </p>
      )}

      {state === 'ready' && shown.length === 0 && (
        <p className="market-note">Nothing matches “{query}”.</p>
      )}

      <div className="market-grid">
        {shown.map((s) => (
          <article key={s.service} className="market-card">
            <h2>{s.service}</h2>
            <p className="market-count">
              {s.endpoints} endpoint{s.endpoints === 1 ? '' : 's'}
            </p>
            {s.description !== '' && <p className="market-desc">{s.description}</p>}
            <code className="market-sample">/v1/marketplace/{s.sample}</code>
            {/* Hands the service to the agent rather than calling it directly: choosing
                the endpoint and its parameters is the agent's job, and a form here would
                need to know all 2700 shapes. */}
            <button
              className="market-ask"
              onClick={() => onAsk(`What can the ${s.service} service do, and what does it cost?`)}
            >
              Ask the agent
            </button>
          </article>
        ))}
      </div>
    </div>
  )
}
