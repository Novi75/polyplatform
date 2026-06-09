import type { MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.ts'
import type { PolyEvent } from '../hooks/useMarkets.ts'

function parseArr(s: string | unknown[]): string[] {
  if (Array.isArray(s)) return s.map(String)
  if (typeof s === 'string') { try { return JSON.parse(s) } catch { return [] } }
  return []
}

function fmtVol(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}k`
  return `$${v.toFixed(0)}`
}

interface Props {
  event: PolyEvent
  onSelect: (conditionId: string, question: string, tokenId?: string) => void
}

export function EventCard({ event, onSelect }: Props) {
  const navigate = useNavigate()
  const setSelectedMarket = useStore((s) => s.setSelectedMarket)

  const markets = event.markets ?? []
  // For binary events show all markets (usually 1-2); for multi-outcome show top 4
  const isBinary = markets.length <= 2
  const displayMarkets = markets.slice(0, isBinary ? markets.length : 4)
  const extraCount = markets.length - displayMarkets.length

  const vol = event.volume ?? 0
  const endDate = event.endDate
    ? new Date(event.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null

  const goTrade = (conditionId: string, question: string, e: MouseEvent) => {
    e.stopPropagation()
    setSelectedMarket({ exchange: 'polymarket', id: conditionId, question })
    navigate('/trade')
  }

  return (
    <div
      className="rounded-xl border overflow-hidden flex flex-col hover:border-[hsl(217,32%,28%)] transition-colors cursor-pointer"
      style={{ background: 'hsl(220,47%,9%)', borderColor: 'hsl(217,32%,17%)' }}
      onClick={() => {
        const m = markets[0]
        if (m?.conditionId) onSelect(m.conditionId, event.title)
      }}
    >
      {/* Banner image */}
      {event.image && (
        <div className="relative h-28 overflow-hidden shrink-0">
          <img
            src={event.image} alt=""
            className="w-full h-full object-cover"
            onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none' }}
          />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, transparent 35%, hsl(220,47%,9%) 100%)' }} />
        </div>
      )}

      {/* Header */}
      <div className="flex items-start gap-2.5 px-3 pt-3 pb-2">
        {!event.image && event.icon && (
          <img
            src={event.icon} alt=""
            className="w-8 h-8 rounded-lg shrink-0 object-cover mt-0.5"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        )}
        {event.image && event.icon && (
          <img
            src={event.icon} alt=""
            className="w-7 h-7 rounded-md shrink-0 object-cover -mt-5 relative z-10 border"
            style={{ borderColor: 'hsl(217,32%,22%)' }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        )}
        <p className="text-sm font-semibold leading-snug flex-1" style={{ color: 'hsl(210,40%,96%)' }}>
          {event.title}
        </p>
      </div>

      {/* Outcome rows */}
      <div className="flex-1 flex flex-col">
        {displayMarkets.map((m) => {
          const prices  = parseArr(m.outcomePrices)
          const yesPrice = parseFloat(prices[0] ?? '0')
          const noPrice  = parseFloat(prices[1] ?? '0')
          const yesPct = Math.round(yesPrice * 100)
          const noPct  = Math.round(noPrice  * 100)

          // For multi-outcome events show just question + YES %
          const label = isBinary
            ? null
            : m.question.length > 38 ? m.question.slice(0, 36) + '…' : m.question

          return (
            <div
              key={m.conditionId}
              className="flex items-center gap-2 px-3 py-2 border-t hover:bg-white/[.03] transition-colors"
              style={{ borderColor: 'hsl(217,32%,13%)' }}
              onClick={(e) => { e.stopPropagation(); onSelect(m.conditionId, event.title) }}
            >
              {label && (
                <span className="flex-1 text-xs truncate" style={{ color: 'hsl(215,20%,70%)' }}>{label}</span>
              )}

              {isBinary ? (
                /* Binary layout: full bar + YES / NO side by side */
                <div className="flex-1 space-y-1">
                  <div className="h-1 rounded-full overflow-hidden" style={{ background: 'hsl(217,32%,18%)' }}>
                    <div className="h-full rounded-full" style={{ width: `${yesPct}%`, background: 'hsl(142,70%,45%)' }} />
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span style={{ color: 'hsl(210,40%,80%)' }}>Yes</span>
                    <span className="font-semibold font-mono" style={{ color: 'hsl(142,70%,55%)' }}>{yesPct}%</span>
                  </div>
                </div>
              ) : (
                /* Multi-outcome: just the YES probability */
                <span
                  className="shrink-0 text-sm font-semibold font-mono w-11 text-right"
                  style={{ color: yesPct >= 50 ? 'hsl(142,70%,55%)' : 'hsl(0,84%,60%)' }}
                >
                  {yesPct}%
                </span>
              )}

              {/* YES / NO chips */}
              <div className="flex gap-1 shrink-0">
                <button
                  className="text-[10px] px-2 py-0.5 rounded font-semibold transition-colors hover:opacity-80"
                  style={{ background: 'hsl(142,70%,14%)', color: 'hsl(142,70%,62%)' }}
                  onClick={(e) => goTrade(m.conditionId, event.title, e)}
                >
                  {isBinary ? `${yesPct}¢ Yes` : 'Yes'}
                </button>
                <button
                  className="text-[10px] px-2 py-0.5 rounded font-semibold transition-colors hover:opacity-80"
                  style={{ background: 'hsl(0,84%,13%)', color: 'hsl(0,84%,62%)' }}
                  onClick={(e) => goTrade(m.conditionId, event.title, e)}
                >
                  {isBinary ? `${noPct}¢ No` : 'No'}
                </button>
              </div>
            </div>
          )
        })}

        {extraCount > 0 && (
          <div className="px-3 py-1.5 border-t text-xs" style={{ borderColor: 'hsl(217,32%,13%)', color: 'hsl(215,20%,45%)' }}>
            +{extraCount} more outcomes
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        className="px-3 py-2 flex items-center justify-between text-xs border-t mt-auto shrink-0"
        style={{ background: 'hsl(220,47%,7%)', borderColor: 'hsl(217,32%,13%)', color: 'hsl(215,20%,50%)' }}
      >
        <span>{fmtVol(vol)} Vol</span>
        {endDate && <span>Ends {endDate}</span>}
      </div>
    </div>
  )
}
