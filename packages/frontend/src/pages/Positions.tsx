import { useQuery } from '@tanstack/react-query'
import { fetcher } from '../lib/api.ts'
import { TrendingUp, TrendingDown } from 'lucide-react'

export default function Positions() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['positions'],
    queryFn: () => fetcher('/positions'),
    refetchInterval: 30_000,
  })

  const polyPositions: unknown[] = data?.polymarket ?? []
  const limPositions: unknown[] = data?.limitless ?? []

  if (isLoading) {
    return <div className="text-center py-16 text-sm" style={{ color: 'hsl(215,20%,55%)' }}>Loading positions...</div>
  }

  const PositionTable = ({ positions, exchange }: { positions: unknown[]; exchange: string }) => (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'hsl(217,32%,17%)' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: 'hsl(222,47%,10%)', borderColor: 'hsl(217,32%,17%)' }}>
        <span className="text-xs font-semibold uppercase" style={{ color: 'hsl(215,20%,65%)' }}>
          {exchange === 'polymarket' ? 'Polymarket' : 'Limitless'} ({positions.length})
        </span>
        <button onClick={() => refetch()} className="text-xs" style={{ color: 'hsl(215,20%,50%)' }}>Refresh</button>
      </div>
      {positions.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm" style={{ background: 'hsl(222,47%,8%)', color: 'hsl(215,20%,45%)' }}>
          No open positions on {exchange}
        </div>
      ) : (
        <div style={{ background: 'hsl(222,47%,8%)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr>
                {['Market', 'Side', 'Size', 'Avg Price', 'Expires In', 'P&L'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold" style={{ color: 'hsl(215,20%,55%)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((pos, i) => {
                const p = pos as Record<string, unknown>
                const pnl = typeof p.unrealizedPnl === 'number' ? p.unrealizedPnl : (typeof p.pnl === 'number' ? p.pnl : 0)
                return (
                  <tr key={i} className="border-t" style={{ borderColor: 'hsl(217,32%,13%)' }}>
                    <td className="px-4 py-3 text-xs max-w-xs truncate" style={{ color: 'hsl(210,40%,88%)' }}>
                      {String(p.market ?? p.marketId ?? p.conditionId ?? 'Unknown').slice(0, 40)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-medium" style={{ color: p.side === 'BUY' ? 'hsl(142,70%,55%)' : 'hsl(0,84%,60%)' }}>
                        {String(p.side ?? 'LONG')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs font-mono" style={{ color: 'hsl(210,40%,80%)' }}>
                      {String(p.size ?? p.amount ?? '-')}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono" style={{ color: 'hsl(210,40%,80%)' }}>
                      {p.avgPrice != null ? parseFloat(String(p.avgPrice)).toFixed(4) : '-'}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono" style={{ color: 'hsl(210,40%,80%)' }}>
                      {p.expiresIn != null ? `${Math.floor(Number(p.expiresIn) / 60)}:${String(Number(p.expiresIn) % 60).padStart(2, '0')}` : '-'}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono flex items-center gap-1" style={{ color: pnl >= 0 ? 'hsl(142,70%,55%)' : 'hsl(0,84%,60%)' }}>
                      {pnl >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                      {pnl >= 0 ? '+' : ''}{pnl.toFixed(3)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )

  const allPositions = [...polyPositions, ...limPositions]

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Positions', value: String(allPositions.length) },
          { label: 'Polymarket', value: String(polyPositions.length) },
          { label: 'Limitless', value: String(limPositions.length) },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl border p-4" style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>
            <p className="text-xs mb-1" style={{ color: 'hsl(215,20%,55%)' }}>{label}</p>
            <p className="text-2xl font-semibold font-mono" style={{ color: 'hsl(210,40%,98%)' }}>{value}</p>
          </div>
        ))}
      </div>

      <PositionTable positions={polyPositions} exchange="polymarket" />
      <PositionTable positions={limPositions} exchange="limitless" />
    </div>
  )
}
