import { X, TrendingUp } from 'lucide-react'
import type { MarketFilters } from '../hooks/useMarkets.ts'

export const SORT_OPTIONS = [
  { value: 'eventVolume', label: 'Event Volume' },
  { value: 'volumeNum',   label: 'Market Volume' },
  { value: 'volume24hr',  label: '24hr Volume' },
  { value: 'liquidity',   label: 'Liquidity' },
  { value: 'startDate',   label: 'Newest', ascending: false },
  { value: 'endDate',     label: 'Ending Soon', ascending: true },
  { value: 'competitive', label: 'Competitive' },
  { value: 'trending',    label: 'Trending' },
]

const DEFAULT: MarketFilters = { order: 'eventVolume', ascending: false, competitive: false, trending: false }

function isDefault(f: MarketFilters) {
  return f.order === DEFAULT.order && !f.ascending && !f.competitive && !f.trending
}

interface Props {
  filters: MarketFilters
  onChange: (f: MarketFilters) => void
}

export function FilterBar({ filters, onChange }: Props) {
  const dim = { color: 'hsl(215,20%,50%)' }

  const setOrder = (opt: typeof SORT_OPTIONS[number]) => {
    if (opt.value === 'competitive') {
      onChange({ ...filters, competitive: !filters.competitive, trending: false, order: 'volumeNum', ascending: false })
    } else if (opt.value === 'trending') {
      onChange({ ...filters, trending: !filters.trending, competitive: false, order: 'volumeNum', ascending: false })
    } else {
      onChange({ ...filters, order: opt.value, ascending: opt.ascending ?? false, competitive: false, trending: false })
    }
  }

  const activeLabel = filters.trending
    ? 'Trending'
    : filters.competitive
    ? 'Competitive'
    : SORT_OPTIONS.find((o) => o.value === filters.order)?.label ?? 'Total Volume'

  return (
    <div className="flex items-center gap-2 flex-wrap shrink-0">
      {/* Sort dropdown */}
      <div className="relative group">
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border"
          style={{
            background: filters.trending ? 'hsl(38,80%,12%)' : 'hsl(222,47%,10%)',
            borderColor: filters.trending ? 'hsl(38,80%,30%)' : 'hsl(217,32%,20%)',
            color: filters.trending ? 'hsl(38,90%,65%)' : 'hsl(210,40%,90%)',
          }}
        >
          {filters.trending && <TrendingUp size={11} />}
          {activeLabel}
          <span style={dim}>▾</span>
        </button>
        <div
          className="absolute left-0 top-full mt-1 z-20 rounded-xl border py-1 min-w-[160px] hidden group-focus-within:block group-hover:block"
          style={{ background: 'hsl(222,47%,10%)', borderColor: 'hsl(217,32%,20%)' }}
        >
          {SORT_OPTIONS.map((opt) => {
            const isActive = opt.value === 'competitive' ? !!filters.competitive
              : opt.value === 'trending' ? !!filters.trending
              : filters.order === opt.value && !filters.competitive && !filters.trending
            return (
              <button
                key={opt.value}
                onClick={() => setOrder(opt)}
                className="w-full text-left px-4 py-2 text-xs hover:bg-white/5 flex items-center gap-2"
                style={{ color: isActive ? 'hsl(142,70%,55%)' : 'hsl(210,40%,85%)' }}
              >
                {isActive ? (
                  <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: 'hsl(142,70%,50%)' }} />
                ) : (
                  <span className="w-1.5 h-1.5" />
                )}
                {opt.label === 'Trending' && <TrendingUp size={10} />}
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Active pills */}
      {filters.competitive && (
        <span className="flex items-center gap-1 px-2 py-1 rounded-full text-xs"
          style={{ background: 'hsl(217,70%,18%)', color: 'hsl(217,70%,70%)' }}>
          Competitive
          <button onClick={() => onChange({ ...filters, competitive: false })}><X size={10} /></button>
        </span>
      )}
      {filters.trending && (
        <span className="flex items-center gap-1 px-2 py-1 rounded-full text-xs"
          style={{ background: 'hsl(38,80%,12%)', color: 'hsl(38,90%,65%)' }}>
          <TrendingUp size={10} /> Trending
          <button onClick={() => onChange({ ...filters, trending: false })}><X size={10} /></button>
        </span>
      )}

      {/* Clear */}
      {!isDefault(filters) && (
        <button onClick={() => onChange(DEFAULT)}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg"
          style={{ color: 'hsl(215,20%,50%)', background: 'hsl(217,32%,13%)' }}>
          <X size={11} /> Clear
        </button>
      )}
    </div>
  )
}
