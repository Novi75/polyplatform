import { useQuery } from '@tanstack/react-query'
import { fetcher } from '../lib/api.ts'
import type { TimeSeriesPoint } from '../components/TimeSeriesChart.tsx'

export type TimeRange = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL'

// Stale time per range — shorter for recent data, longer for historical
const STALE_MS: Record<TimeRange, number> = {
  '1D': 60_000,    // 1 min
  '1W': 300_000,   // 5 min
  '1M': 600_000,   // 10 min
  '3M': 1_800_000, // 30 min
  '1Y': 1_800_000,
  'ALL': 1_800_000,
}

// Needed by MarketTradeWidget to re-fetch when range changes
export const RANGE_CONFIG: Record<TimeRange, { fidelity: number }> = {
  '1D':  { fidelity: 1 },
  '1W':  { fidelity: 60 },
  '1M':  { fidelity: 240 },
  '3M':  { fidelity: 1440 },
  '1Y':  { fidelity: 1440 },
  'ALL': { fidelity: 1440 },
}

function fetchHistory(tokenId: string, range: TimeRange) {
  return fetcher(`/markets/polymarket/${tokenId}/price-history?range=${range}`) as Promise<{
    history: Array<{ ts: number; price: number }>
  }>
}

export function usePriceHistory(
  yesTokenId: string | undefined,
  noTokenId: string | undefined,
  range: TimeRange = '1M',
): { data: TimeSeriesPoint[]; isLoading: boolean; isError: boolean } {
  const enabled = (id: string | undefined) => !!id && id.length >= 10

  const yesQuery = useQuery({
    queryKey: ['price-history', yesTokenId, range],
    queryFn: () => fetchHistory(yesTokenId!, range),
    enabled: enabled(yesTokenId),
    staleTime: STALE_MS[range],
  })

  const noQuery = useQuery({
    queryKey: ['price-history', noTokenId, range],
    queryFn: () => fetchHistory(noTokenId!, range),
    enabled: enabled(noTokenId),
    staleTime: STALE_MS[range],
  })

  const isLoading = yesQuery.isLoading || noQuery.isLoading
  const isError   = yesQuery.isError   || noQuery.isError

  // Merge YES + NO histories into aligned {ts, yes, no} objects
  const data: TimeSeriesPoint[] = (() => {
    const yesH = yesQuery.data?.history ?? []
    const noH  = noQuery.data?.history  ?? []
    if (!yesH.length && !noH.length) return []

    const map = new Map<number, TimeSeriesPoint>()
    for (const pt of yesH) map.set(pt.ts, { ts: pt.ts, yes: pt.price })
    for (const pt of noH) {
      const existing = map.get(pt.ts) ?? { ts: pt.ts }
      map.set(pt.ts, { ...existing, no: pt.price })
    }
    return Array.from(map.values()).sort((a, b) => a.ts - b.ts)
  })()

  return { data, isLoading, isError }
}
