import { useNavigate } from 'react-router-dom'
import { useMarketDetail } from '../hooks/useMarkets.ts'
import { useStore } from '../store/useStore.ts'
import { ExternalLink, TrendingUp, TrendingDown, Minus } from 'lucide-react'

function Sparkline({ prices }: { prices: number[] }) {
  if (prices.length < 2) return null
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const range = max - min || 0.01
  const w = 80
  const h = 28
  const pts = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * w
    const y = h - ((p - min) / range) * h
    return `${x},${y}`
  }).join(' ')
  const last = prices[prices.length - 1]
  const first = prices[0]
  const color = last >= first ? 'hsl(142,70%,50%)' : 'hsl(0,84%,60%)'
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function PriceChange({ value }: { value: number | null }) {
  if (value == null) return <span style={{ color: 'hsl(215,20%,45%)' }}>—</span>
  const pct = (value * 100).toFixed(1)
  if (value > 0.001) return <span style={{ color: 'hsl(142,70%,55%)' }}><TrendingUp size={10} className="inline mr-0.5" />+{pct}%</span>
  if (value < -0.001) return <span style={{ color: 'hsl(0,84%,60%)' }}><TrendingDown size={10} className="inline mr-0.5" />{pct}%</span>
  return <span style={{ color: 'hsl(215,20%,55%)' }}><Minus size={10} className="inline mr-0.5" />{pct}%</span>
}

interface Props {
  conditionId: string
  question?: string
}

export function MarketCard({ conditionId, question }: Props) {
  const navigate = useNavigate()
  const setSelectedMarket = useStore((s) => s.setSelectedMarket)
  const { data, isLoading } = useMarketDetail(conditionId, !!conditionId)

  if (isLoading) {
    return (
      <div className="rounded-xl border p-4 animate-pulse" style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>
        <div className="h-4 rounded w-3/4 mb-3" style={{ background: 'hsl(217,32%,17%)' }} />
        <div className="h-3 rounded w-1/2" style={{ background: 'hsl(217,32%,14%)' }} />
      </div>
    )
  }

  if (!data) return null

  const dim = { color: 'hsl(215,20%,50%)' }
  const endDate = data.endDate ? new Date(data.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null
  const volDisplay = data.volume >= 1_000_000
    ? `$${(data.volume / 1_000_000).toFixed(1)}M`
    : `$${(data.volume / 1_000).toFixed(0)}k`

  const goTrade = () => {
    setSelectedMarket({
      exchange: 'polymarket',
      id: conditionId,
      question: data.question || question || '',
      tokenId: data.clobTokenIds?.[0],  // YES outcome token
    })
    navigate('/trade')
  }

  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>

      {/* Header */}
      <div className="p-4 space-y-2">
        <div className="flex items-start gap-3">
          {data.icon && (
            <img src={data.icon} alt="" className="w-9 h-9 rounded-lg shrink-0 object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          )}
          <p className="text-sm font-medium leading-snug" style={{ color: 'hsl(210,40%,95%)' }}>
            {data.question || question}
          </p>
        </div>

        {/* Price change row */}
        <div className="flex items-center gap-3 text-xs">
          <span style={dim}>1d</span><PriceChange value={data.oneDayPriceChange} />
          <span style={dim}>1w</span><PriceChange value={data.oneWeekPriceChange} />
          <span style={dim}>1m</span><PriceChange value={data.oneMonthPriceChange} />
        </div>
      </div>

      {/* Outcomes */}
      <div className="border-t" style={{ borderColor: 'hsl(217,32%,14%)' }}>
        {data.outcomes.map((outcome, i) => {
          const price = data.outcomePrices[i] ?? 0
          const pct = Math.round(price * 100)
          // Reconstruct a 2-point sparkline from change data for YES outcome
          const sparkPrices = i === 0 && data.lastTradePrice != null
            ? [
                data.lastTradePrice - (data.oneMonthPriceChange ?? 0),
                data.lastTradePrice - (data.oneWeekPriceChange ?? 0),
                data.lastTradePrice - (data.oneDayPriceChange ?? 0),
                data.lastTradePrice,
              ]
            : null
          return (
            <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b last:border-b-0"
              style={{ borderColor: 'hsl(217,32%,12%)' }}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium" style={{ color: 'hsl(210,40%,90%)' }}>{outcome}</span>
                  <span className="text-sm font-semibold font-mono"
                    style={{ color: pct > 50 ? 'hsl(142,70%,55%)' : pct < 50 ? 'hsl(0,84%,60%)' : 'hsl(210,40%,80%)' }}>
                    {pct}%
                  </span>
                </div>
                {/* Probability bar */}
                <div className="h-1 rounded-full overflow-hidden" style={{ background: 'hsl(217,32%,17%)' }}>
                  <div className="h-full rounded-full transition-all"
                    style={{
                      width: `${pct}%`,
                      background: pct > 50 ? 'hsl(142,70%,45%)' : pct < 20 ? 'hsl(0,84%,50%)' : 'hsl(38,80%,50%)',
                    }}
                  />
                </div>
              </div>
              {sparkPrices && (
                <div className="shrink-0">
                  <Sparkline prices={sparkPrices} />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 flex items-center justify-between text-xs" style={{ background: 'hsl(222,47%,6%)', ...dim }}>
        <div className="flex items-center gap-3">
          <span>{volDisplay} Vol</span>
          {endDate && <span>Ends {endDate}</span>}
        </div>
        <button onClick={goTrade}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium"
          style={{ background: 'hsl(142,70%,40%)', color: 'hsl(222,47%,5%)' }}>
          <ExternalLink size={11} /> Trade
        </button>
      </div>
    </div>
  )
}
