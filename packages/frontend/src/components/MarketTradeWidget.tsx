import { useState, useEffect } from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { useMarketDetail, useLivePrices } from '../hooks/useMarkets.ts'
import { TimeSeriesChart, type SeriesConfig, type TimeRange } from './TimeSeriesChart.tsx'
import { usePriceHistory } from '../hooks/usePriceHistory.ts'

// ── PriceChange badge ─────────────────────────────────────────────────────────

function Delta({ label, value }: { label: string; value: number | null }) {
  const dim = { color: 'hsl(215,20%,45%)' }
  if (value == null) return (
    <span className="flex items-center gap-1 text-xs">
      <span style={dim}>{label}</span>
      <span style={dim}>—</span>
    </span>
  )
  const pct = (Math.abs(value) * 100).toFixed(1)
  const up = value > 0.001
  const down = value < -0.001
  return (
    <span className="flex items-center gap-0.5 text-xs">
      <span style={dim}>{label}</span>
      {up   && <TrendingUp size={10} style={{ color: 'hsl(142,70%,55%)' }} />}
      {down && <TrendingDown size={10} style={{ color: 'hsl(0,84%,60%)' }} />}
      {!up && !down && <Minus size={10} style={dim} />}
      <span style={{ color: up ? 'hsl(142,70%,55%)' : down ? 'hsl(0,84%,60%)' : dim.color }}>
        {up ? '+' : down ? '-' : ''}{pct}%
      </span>
    </span>
  )
}

// ── Countdown ─────────────────────────────────────────────────────────────────

function useCountdown(endDate: string | undefined): string {
  const [label, setLabel] = useState('')
  useEffect(() => {
    if (!endDate) return
    const tick = () => {
      const diff = new Date(endDate).getTime() - Date.now()
      if (diff <= 0) { setLabel('Ended'); return }
      const d = Math.floor(diff / 86_400_000)
      const h = Math.floor((diff % 86_400_000) / 3_600_000)
      const m = Math.floor((diff % 3_600_000) / 60_000)
      const s = Math.floor((diff % 60_000) / 1_000)
      if (d > 0) setLabel(`${d}d ${h}h`)
      else if (h > 0) setLabel(`${h}h ${m}m`)
      else setLabel(`${m}m ${s}s`)
    }
    tick()
    const id = setInterval(tick, 1_000)
    return () => clearInterval(id)
  }, [endDate])
  return label
}

// ── Outcome card ──────────────────────────────────────────────────────────────

interface OutcomeCardProps {
  label: string
  pct: number
  bestBid: string | null
  bestAsk: string | null
  tokenId: string
  isYes: boolean
  onBuy: (tokenId: string, price: string, outcome: string) => void
  onSell: (tokenId: string, price: string, outcome: string) => void
}

function OutcomeCard({ label, pct, bestBid, bestAsk, tokenId, isYes, onBuy, onSell }: OutcomeCardProps) {
  const multiplier = pct > 0 ? (100 / pct).toFixed(2) : '—'
  const askNum = bestAsk ? parseFloat(bestAsk) : null
  const bidNum = bestBid ? parseFloat(bestBid) : null
  const barColor = isYes ? 'hsl(142,70%,45%)' : 'hsl(0,84%,55%)'
  const accent = isYes ? 'hsl(142,70%,55%)' : 'hsl(0,84%,65%)'
  const bg = isYes ? 'hsl(142,70%,7%)' : 'hsl(0,84%,8%)'
  const border = isYes ? 'hsl(142,70%,18%)' : 'hsl(0,84%,20%)'

  return (
    <div className="flex-1 rounded-xl border p-4 flex flex-col gap-3" style={{ background: bg, borderColor: border }}>
      {/* Label + multiplier */}
      <div className="flex items-center justify-between">
        <span className="text-base font-bold" style={{ color: accent }}>{label}</span>
        <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
          style={{ background: isYes ? 'hsl(142,70%,13%)' : 'hsl(0,84%,14%)', color: accent }}>
          {multiplier}x return
        </span>
      </div>

      {/* Big probability */}
      <div className="text-center">
        <span className="text-4xl font-bold tabular-nums" style={{ color: accent }}>{pct}%</span>
        <p className="text-xs mt-0.5" style={{ color: 'hsl(215,20%,50%)' }}>probability</p>
      </div>

      {/* Probability bar */}
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'hsl(217,32%,18%)' }}>
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: barColor }} />
      </div>

      {/* Live bid/ask */}
      <div className="grid grid-cols-2 gap-1 text-xs">
        <div className="rounded-lg px-2 py-1.5 text-center" style={{ background: 'hsl(217,32%,13%)' }}>
          <div style={{ color: 'hsl(215,20%,50%)' }}>Bid</div>
          <div className="font-mono font-semibold" style={{ color: 'hsl(142,70%,55%)' }}>
            {bidNum != null ? bidNum.toFixed(4) : '—'}
          </div>
        </div>
        <div className="rounded-lg px-2 py-1.5 text-center" style={{ background: 'hsl(217,32%,13%)' }}>
          <div style={{ color: 'hsl(215,20%,50%)' }}>Ask</div>
          <div className="font-mono font-semibold" style={{ color: 'hsl(0,84%,65%)' }}>
            {askNum != null ? askNum.toFixed(4) : '—'}
          </div>
        </div>
      </div>

      {/* BUY / SELL buttons */}
      <div className="grid grid-cols-2 gap-2 mt-auto">
        <button
          onClick={() => onBuy(tokenId, bestAsk ?? '0.50', label)}
          className="py-2 rounded-lg text-sm font-semibold transition-opacity hover:opacity-80"
          style={{ background: barColor, color: 'hsl(222,47%,5%)' }}
        >
          Buy
        </button>
        <button
          onClick={() => onSell(tokenId, bestBid ?? '0.50', label)}
          className="py-2 rounded-lg text-sm font-semibold transition-opacity hover:opacity-80"
          style={{ background: 'hsl(217,32%,20%)', color: 'hsl(215,20%,80%)' }}
        >
          Sell
        </button>
      </div>
    </div>
  )
}

// ── Main widget ───────────────────────────────────────────────────────────────

interface Props {
  conditionId: string
  question?: string
  onOutcomeSelect: (tokenId: string, price: string, side: 'BUY' | 'SELL', outcome: string) => void
}

const YES_SERIES: SeriesConfig[] = [
  { key: 'yes', label: 'Yes', color: 'hsl(142,70%,50%)' },
  { key: 'no',  label: 'No',  color: 'hsl(0,84%,60%)' },
]

export function MarketTradeWidget({ conditionId, question, onOutcomeSelect }: Props) {
  const { data, isLoading } = useMarketDetail(conditionId, !!conditionId)
  const countdown = useCountdown(data?.endDate)
  const [chartRange, setChartRange] = useState<TimeRange>('1M')

  // Live bid/ask for both YES and NO tokens
  const tokenIds = (data?.clobTokenIds ?? []).filter(Boolean).slice(0, 2)
  const { data: livePrices } = useLivePrices(tokenIds)

  // Price history for the chart
  const { data: chartData, isLoading: chartLoading, isError: chartError } =
    usePriceHistory(data?.clobTokenIds[0], data?.clobTokenIds[1], chartRange)

  const dim = { color: 'hsl(215,20%,50%)' }

  if (!conditionId) {
    return (
      <div className="flex-1 rounded-xl border flex items-center justify-center h-64"
        style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>
        <p className="text-sm" style={dim}>Select a market to see the live widget</p>
      </div>
    )
  }

  if (isLoading || !data) {
    return (
      <div className="flex-1 rounded-xl border overflow-hidden"
        style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>
        {/* Show the market name immediately from the store prop while detail loads */}
        {question && (
          <div className="px-5 py-4 border-b" style={{ background: 'hsl(220,47%,10%)', borderColor: 'hsl(217,32%,15%)' }}>
            <p className="text-base font-semibold leading-snug animate-pulse"
              style={{ color: 'hsl(210,40%,90%)' }}>{question}</p>
            <p className="text-xs mt-1" style={{ color: 'hsl(215,20%,45%)' }}>Loading market data…</p>
          </div>
        )}
        <div className="p-6 space-y-4 animate-pulse">
          {[40, 16, 96, 40].map((h, i) => (
            <div key={i} style={{ height: h, borderRadius: 8, background: 'hsl(217,32%,14%)' }} />
          ))}
        </div>
      </div>
    )
  }

  // Volume
  const volDisplay = data.volume >= 1_000_000
    ? `$${(data.volume / 1_000_000).toFixed(1)}M`
    : `$${(data.volume / 1_000).toFixed(0)}k`

  // Outcomes
  const yesPrice = data.outcomePrices[0] ?? 0
  const noPrice  = data.outcomePrices[1] ?? 0
  const yesPct   = Math.round(yesPrice * 100)
  const noPct    = Math.round(noPrice  * 100)
  const yesToken = data.clobTokenIds[0] ?? ''
  const noToken  = data.clobTokenIds[1] ?? ''

  // Live prices
  const yesLive = yesToken ? livePrices?.[yesToken] : null
  const noLive  = noToken  ? livePrices?.[noToken]  : null
  const isLive  = !!(yesLive?.bestBid || noLive?.bestBid)

  // End date display
  const endDateStr = data.endDate
    ? new Date(data.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null

  const handleBuy  = (tokenId: string, price: string, outcome: string) =>
    onOutcomeSelect(tokenId, price, 'BUY', outcome)
  const handleSell = (tokenId: string, price: string, outcome: string) =>
    onOutcomeSelect(tokenId, price, 'SELL', outcome)

  return (
    <div className="flex-1 rounded-xl border overflow-hidden"
      style={{ background: 'hsl(220,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>

      {/* ── Header ── */}
      <div className="px-5 py-4 border-b flex items-start gap-3"
        style={{ background: 'hsl(220,47%,10%)', borderColor: 'hsl(217,32%,15%)' }}>
        {data.icon && (
          <img src={data.icon} alt="" className="w-10 h-10 rounded-xl shrink-0 object-cover"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold leading-snug" style={{ color: 'hsl(210,40%,97%)' }}>
            {data.question}
          </p>
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            {endDateStr && (
              <span className="text-xs" style={dim}>Ends {endDateStr}</span>
            )}
            <span className="text-xs font-medium" style={dim}>{volDisplay} Vol</span>
          </div>
        </div>
        {/* Live badge + countdown */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full"
            style={{ background: isLive ? 'hsl(142,70%,10%)' : 'hsl(217,32%,14%)', color: isLive ? 'hsl(142,70%,55%)' : dim.color }}>
            <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'animate-pulse' : ''}`}
              style={{ background: isLive ? 'hsl(142,70%,55%)' : 'hsl(215,20%,35%)', display: 'inline-block' }} />
            {isLive ? 'Live' : 'Delayed'}
          </div>
          {countdown && (
            <div className="text-xs font-mono font-semibold px-2.5 py-1 rounded-full"
              style={{ background: 'hsl(38,80%,10%)', color: 'hsl(38,90%,65%)' }}>
              ⏱ {countdown}
            </div>
          )}
        </div>
      </div>

      {/* ── Price stats row ── */}
      <div className="px-5 py-3 border-b flex items-center gap-6 flex-wrap"
        style={{ background: 'hsl(220,47%,9%)', borderColor: 'hsl(217,32%,14%)' }}>
        {data.lastTradePrice != null && (
          <div>
            <div className="text-xs mb-0.5" style={dim}>Last Trade</div>
            <div className="text-lg font-bold font-mono" style={{ color: 'hsl(210,40%,97%)' }}>
              {(data.lastTradePrice * 100).toFixed(1)}¢
            </div>
          </div>
        )}
        <div>
          <div className="text-xs mb-0.5" style={dim}>Liquidity</div>
          <div className="text-sm font-semibold" style={{ color: 'hsl(210,40%,90%)' }}>
            {data.liquidity >= 1_000_000
              ? `$${(data.liquidity / 1_000_000).toFixed(1)}M`
              : `$${(data.liquidity / 1_000).toFixed(0)}k`}
          </div>
        </div>
        {/* Price changes */}
        <div className="flex items-center gap-4 ml-auto flex-wrap">
          <Delta label="1d" value={data.oneDayPriceChange} />
          <Delta label="1w" value={data.oneWeekPriceChange} />
          <Delta label="1m" value={data.oneMonthPriceChange} />
        </div>
      </div>

      {/* ── Price history chart ── */}
      <div className="px-5 pb-1 border-b" style={{ borderColor: 'hsl(217,32%,14%)' }}>
        <TimeSeriesChart
          data={chartData}
          series={YES_SERIES}
          yDomain={[0, 1]}
          yFormatter={(v) => `${(v * 100).toFixed(0)}%`}
          chartHeight={200}
          isLoading={chartLoading && chartData.length === 0}
          isError={chartError}
          range={chartRange}
          onRangeChange={setChartRange}
        />
      </div>

      {/* ── Outcome cards ── */}
      <div className="p-5 flex gap-4">
        <OutcomeCard
          label={data.outcomes[0] ?? 'Yes'}
          pct={yesPct}
          bestBid={yesLive?.bestBid ?? null}
          bestAsk={yesLive?.bestAsk ?? null}
          tokenId={yesToken}
          isYes
          onBuy={handleBuy}
          onSell={handleSell}
        />
        <OutcomeCard
          label={data.outcomes[1] ?? 'No'}
          pct={noPct}
          bestBid={noLive?.bestBid ?? null}
          bestAsk={noLive?.bestAsk ?? null}
          tokenId={noToken}
          isYes={false}
          onBuy={handleBuy}
          onSell={handleSell}
        />
      </div>

    </div>
  )
}
