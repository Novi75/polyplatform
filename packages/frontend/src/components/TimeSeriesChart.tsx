import { useState, useMemo, useCallback, useId } from 'react'
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  type TooltipProps,
} from 'recharts'

// ── Public types ──────────────────────────────────────────────────────────────

export interface TimeSeriesPoint {
  ts: number                    // unix milliseconds
  [seriesKey: string]: number   // e.g. { ts: ..., yes: 0.54, no: 0.46 }
}

export interface SeriesConfig {
  key: string
  label: string
  color: string
}

export type TimeRange = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL'

// ── Constants ─────────────────────────────────────────────────────────────────

const RANGES: Array<{ label: TimeRange; ms: number | null }> = [
  { label: '1D',  ms: 86_400_000 },
  { label: '1W',  ms: 7   * 86_400_000 },
  { label: '1M',  ms: 30  * 86_400_000 },
  { label: '3M',  ms: 90  * 86_400_000 },
  { label: '1Y',  ms: 365 * 86_400_000 },
  { label: 'ALL', ms: null },
]

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtAxisTick(ts: number, rangeMs: number | null): string {
  const d = new Date(ts)
  if (rangeMs === null || rangeMs >= 365 * 86_400_000)
    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  if (rangeMs >= 7 * 86_400_000)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function fmtTooltipTs(ts: number, rangeMs: number | null): string {
  const d = new Date(ts)
  if (rangeMs !== null && rangeMs <= 86_400_000)
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

// ── Custom Tooltip ────────────────────────────────────────────────────────────

type TTProps = TooltipProps<number, string> & {
  coordinate?: { x: number; y: number }
  viewBox?: { x: number; y: number; width: number; height: number }
  rangeMs: number | null
  yFmt: (v: number) => string
}

function CustomTooltip({ active, payload, label, coordinate, viewBox, rangeMs, yFmt }: TTProps) {
  if (!active || !payload?.length || !coordinate || !viewBox) return null

  const TOOLTIP_W = 168
  const nearRight = (coordinate.x ?? 0) > (viewBox.width ?? 0) - TOOLTIP_W - 12
  const left = nearRight
    ? (coordinate.x ?? 0) - TOOLTIP_W - 14
    : (coordinate.x ?? 0) + 14
  const top = Math.max(4, (coordinate.y ?? 0) - 36)

  // Skip Area duplicates — Recharts adds them with type 'area'
  const entries = payload.filter((p) => (p.type as string) !== 'area' && p.value != null)

  return (
    <div style={{
      position: 'absolute',
      left,
      top,
      pointerEvents: 'none',
      zIndex: 20,
      width: TOOLTIP_W,
      background: 'hsl(222,47%,9%)',
      border: '1px solid hsl(217,32%,24%)',
      borderRadius: 10,
      padding: '10px 12px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
    }}>
      <p style={{ fontSize: 11, color: 'hsl(215,20%,50%)', marginBottom: 8, margin: '0 0 8px 0' }}>
        {fmtTooltipTs(label as number, rangeMs)}
      </p>
      {entries.map((p) => (
        <div key={String(p.dataKey)} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4,
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'hsl(215,20%,72%)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, display: 'inline-block', flexShrink: 0 }} />
            {p.name}
          </span>
          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: p.color }}>
            {typeof p.value === 'number' ? yFmt(p.value) : '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Time range button strip ───────────────────────────────────────────────────

function RangeButtons({ active, onChange }: { active: TimeRange; onChange: (r: TimeRange) => void }) {
  return (
    <div style={{ display: 'flex', gap: 3, justifyContent: 'flex-end', paddingBottom: 10 }}>
      {RANGES.map((r) => {
        const isActive = active === r.label
        return (
          <button
            key={r.label}
            onClick={() => onChange(r.label)}
            style={{
              padding: '3px 10px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              border: isActive ? '1px solid hsl(142,70%,24%)' : '1px solid transparent',
              background: isActive ? 'hsl(142,70%,11%)' : 'transparent',
              color: isActive ? 'hsl(142,70%,58%)' : 'hsl(215,20%,48%)',
              transition: 'all 0.12s',
            }}
          >
            {r.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  data: TimeSeriesPoint[]
  series: SeriesConfig[]
  defaultRange?: TimeRange
  /** Y value formatter. Default: probability % (0.54 → "54%") */
  yFormatter?: (v: number) => string
  /** Y axis domain. Default auto. Use [0, 1] for probability charts. */
  yDomain?: [number | 'auto', number | 'auto']
  /** Chart area height in px (excluding range buttons). Default 220. */
  chartHeight?: number
  isLoading?: boolean
  isError?: boolean
  /** Controlled range — pass to sync with parent */
  range?: TimeRange
  onRangeChange?: (r: TimeRange) => void
}

export function TimeSeriesChart({
  data,
  series,
  defaultRange = '1M',
  yFormatter = (v) => `${(v * 100).toFixed(1)}%`,
  yDomain = ['auto', 'auto'],
  chartHeight = 220,
  isLoading = false,
  isError = false,
  range: externalRange,
  onRangeChange,
}: Props) {
  const uid = useId().replace(/:/g, '')
  const [internalRange, setInternalRange] = useState<TimeRange>(defaultRange)
  const activeRange = externalRange ?? internalRange
  const setRange = useCallback((r: TimeRange) => {
    setInternalRange(r)
    onRangeChange?.(r)
  }, [onRangeChange])

  const rangeDef = RANGES.find((r) => r.label === activeRange) ?? RANGES[2]

  // Filter to the selected time window
  const filteredData = useMemo(() => {
    if (!rangeDef.ms) return data
    const cutoff = Date.now() - rangeDef.ms
    return data.filter((d) => d.ts >= cutoff)
  }, [data, rangeDef.ms])

  // Nice Y ticks for [0,1] domain
  const yTicks = useMemo(
    () => (yDomain[0] === 0 && yDomain[1] === 1 ? [0, 0.25, 0.5, 0.75, 1] : undefined),
    [yDomain],
  )

  const dimColor = 'hsl(215,20%,42%)'
  const gridColor = 'hsl(217,32%,14%)'

  const tooltipContent = useCallback(
    (props: TooltipProps<number, string>) => (
      <CustomTooltip {...(props as TTProps)} rangeMs={rangeDef.ms} yFmt={yFormatter} />
    ),
    [rangeDef.ms, yFormatter],
  )

  // ── Loading skeleton ──
  if (isLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          {RANGES.map((r) => (
            <div key={r.label} style={{ width: 36, height: 24, borderRadius: 6, background: 'hsl(217,32%,14%)' }} />
          ))}
        </div>
        <div style={{ height: chartHeight, borderRadius: 12, background: 'hsl(217,32%,12%)' }}>
          <div style={{ height: '100%', background: 'linear-gradient(90deg, transparent 0%, hsl(217,32%,16%) 50%, transparent 100%)', borderRadius: 12, animation: 'pulse 1.5s infinite' }} />
        </div>
      </div>
    )
  }

  // ── Empty / error state ──
  if (isError || filteredData.length < 2) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        <RangeButtons active={activeRange} onChange={setRange} />
        <div style={{ height: chartHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'hsl(217,32%,10%)', borderRadius: 12 }}>
          <span style={{ fontSize: 13, color: dimColor }}>
            {isError ? 'Could not load price history' : 'No data available for this range'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <RangeButtons active={activeRange} onChange={setRange} />

      {/* Gradient defs injected into the document-level SVG namespace */}
      <svg style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }} aria-hidden="true">
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`${uid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={s.color} stopOpacity={0.20} />
              <stop offset="55%"  stopColor={s.color} stopOpacity={0.07} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.00} />
            </linearGradient>
          ))}
        </defs>
      </svg>

      <div style={{ position: 'relative' }}>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <ComposedChart data={filteredData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>

            <CartesianGrid stroke={gridColor} strokeWidth={1} horizontal vertical={false} />

            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(ts) => fmtAxisTick(ts, rangeDef.ms)}
              tick={{ fontSize: 11, fill: dimColor, fontFamily: 'system-ui' }}
              tickLine={false}
              axisLine={false}
              minTickGap={48}
            />

            <YAxis
              domain={yDomain}
              ticks={yTicks}
              tickFormatter={yFormatter}
              tick={{ fontSize: 11, fill: dimColor, fontFamily: 'system-ui' }}
              tickLine={false}
              axisLine={false}
              width={44}
            />

            {/* Snapping crosshair cursor */}
            <Tooltip
              content={tooltipContent}
              cursor={{ stroke: 'rgba(255,255,255,0.16)', strokeWidth: 1 }}
              isAnimationActive={false}
              allowEscapeViewBox={{ x: false, y: true }}
              wrapperStyle={{ pointerEvents: 'none', overflow: 'visible' }}
            />

            {/* Area fills — rendered first so lines draw on top */}
            {series.map((s) => (
              <Area
                key={`fill-${s.key}`}
                dataKey={s.key}
                name={s.label}
                stroke="none"
                fill={`url(#${uid}-${s.key})`}
                fillOpacity={1}
                type="monotone"
                connectNulls
                isAnimationActive={false}
                dot={false}
                activeDot={false}
                legendType="none"
              />
            ))}

            {/* Lines — drawn above the fills */}
            {series.map((s) => (
              <Line
                key={`line-${s.key}`}
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                type="monotone"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(220,47%,8%)', fill: s.color }}
                isAnimationActive={false}
                connectNulls
              />
            ))}

          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
