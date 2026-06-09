// Counts outbound REST calls per exchange so the UI can show whether we're
// approaching either exchange's rate limits.
//
// Polymarket: the SDK (and our own raw calls) go through the global `fetch`,
// so patching that catches everything automatically.
//
// Limitless: the SDK calls out via a bundled, inlined `axios` (not `fetch`,
// and not patchable post-build since tsup inlines it into the bundle), so its
// calls are counted explicitly via `trackLimCall()` at each lim.ts call site.

type Exchange = 'poly' | 'lim'

const WINDOW_MS = 60_000

const _timestamps: Record<Exchange, number[]> = { poly: [], lim: [] }
const _totals: Record<Exchange, number> = { poly: 0, lim: 0 }

function classify(url: string): Exchange | null {
  if (url.includes('polymarket.com')) return 'poly'
  if (url.includes('limitless.exchange')) return 'lim'
  return null
}

function record(ex: Exchange): void {
  const now = Date.now()
  _timestamps[ex].push(now)
  _totals[ex]++
  prune(ex, now)
}

/** Explicit counter for Limitless SDK calls — see module header for why. */
export function trackLimCall(): void {
  record('lim')
}

function prune(ex: Exchange, now: number): void {
  const cutoff = now - WINDOW_MS
  const arr = _timestamps[ex]
  while (arr.length && arr[0] < cutoff) arr.shift()
}

let _installed = false

export function installApiCallTracker(): void {
  if (_installed) return
  _installed = true

  const original = globalThis.fetch
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const [input] = args
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const ex = classify(url)
    if (ex) record(ex)
    return original(...args)
  }) as typeof fetch
}

export function getApiCallStats(): Record<Exchange, { total: number; perMin: number }> {
  const now = Date.now()
  prune('poly', now)
  prune('lim', now)
  return {
    poly: { total: _totals.poly, perMin: _timestamps.poly.length },
    lim: { total: _totals.lim, perMin: _timestamps.lim.length },
  }
}
