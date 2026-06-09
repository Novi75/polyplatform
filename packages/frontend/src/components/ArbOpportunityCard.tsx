import { Zap } from 'lucide-react'
import type { ArbOpportunity } from '../store/useStore.ts'

interface Props {
  opp: ArbOpportunity
  onExecute?: (id: string) => void
  executing?: boolean
}

export function ArbOpportunityCard({ opp, onExecute, executing }: Props) {
  const ttlMs = opp.expiresAt - Date.now()
  const ttlSecs = Math.max(0, Math.floor(ttlMs / 1000))

  const buyExchange = opp.direction === 'buy_poly_sell_lim' ? 'Polymarket' : 'Limitless'
  const sellExchange = opp.direction === 'buy_poly_sell_lim' ? 'Limitless' : 'Polymarket'
  const buyPrice = opp.direction === 'buy_poly_sell_lim' ? opp.polymarketBestAsk : opp.limitlessBestAsk
  const sellPrice = opp.direction === 'buy_poly_sell_lim' ? opp.limitlessBestAsk : opp.polymarketBestAsk

  return (
    <div
      className="rounded-xl p-4 border space-y-3"
      style={{ background: 'hsl(222,47%,9%)', borderColor: 'hsl(142,70%,30%)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate" style={{ color: 'hsl(210,40%,95%)' }}>
            {opp.polyQuestion}
          </p>
          <p className="text-xs mt-0.5 truncate" style={{ color: 'hsl(215,20%,55%)' }}>
            Limitless: {opp.limitlessTitle}
          </p>
        </div>
        <span
          className="shrink-0 text-xs px-2 py-1 rounded-full font-semibold"
          style={{ background: 'hsl(142,70%,15%)', color: 'hsl(142,70%,55%)' }}
        >
          +{opp.estimatedProfitPct.toFixed(2)}%
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-lg p-2" style={{ background: 'hsl(142,70%,8%)' }}>
          <p style={{ color: 'hsl(215,20%,55%)' }}>Buy on {buyExchange}</p>
          <p className="text-lg font-mono font-semibold mt-0.5" style={{ color: 'hsl(142,70%,55%)' }}>
            {buyPrice.toFixed(4)}
          </p>
        </div>
        <div className="rounded-lg p-2" style={{ background: 'hsl(0,60%,8%)' }}>
          <p style={{ color: 'hsl(215,20%,55%)' }}>Sell on {sellExchange}</p>
          <p className="text-lg font-mono font-semibold mt-0.5" style={{ color: 'hsl(0,84%,65%)' }}>
            {sellPrice.toFixed(4)}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs" style={{ color: 'hsl(215,20%,55%)' }}>
        <span>Size: ${opp.suggestedSize.toFixed(2)} USDC</span>
        <span>Diff: {opp.priceDiffPct.toFixed(2)}%</span>
        <span>Expires: {ttlSecs}s</span>
      </div>

      {onExecute && (
        <button
          onClick={() => onExecute(opp.id)}
          disabled={executing}
          className="w-full py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
          style={{ background: 'hsl(142,70%,40%)', color: 'hsl(222,47%,5%)' }}
        >
          <Zap size={14} />
          {executing ? 'Executing...' : 'Execute Now'}
        </button>
      )}
    </div>
  )
}
