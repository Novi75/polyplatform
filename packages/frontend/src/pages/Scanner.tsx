import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetcher, api } from '../lib/api.ts'
import { usePriceFeed } from '../hooks/usePriceFeed.ts'
import { useStore } from '../store/useStore.ts'
import { Search, RefreshCw, Play, Square, Zap, ArrowRightLeft, TrendingUp, X, Timer } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useWebSocket, useChannel } from '../hooks/useWebSocket.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PairLive {
  conditionId: string
  polyQuestion: string
  limTitle: string
  limId: string
  polyTokenId: string | null
  matchScore: number
  poly: { bid: number | null; ask: number | null }
  lim:  { bid: number | null; ask: number | null }
  spreadPct: number | null
  direction: 'buy_poly_sell_lim' | 'buy_lim_sell_poly' | null
}

interface EngineStatus {
  running: boolean
  clientCount: number
  lastError: string | null
}

interface FiveMinArb {
  sameSide:  { diffPct: number; netProfitPct: number; profitable: boolean; direction: string }
  crossSide: {
    buyUpPolyDownLim:  { cost: number | null; netProfitPct: number | null }
    buyDownPolyUpLim:  { cost: number | null; netProfitPct: number | null }
    profitable: boolean
    bestNetProfitPct: number
  }
}
interface FiveMinPair {
  asset: string
  poly: { conditionId: string; question: string; upTokenId: string; downTokenId: string; upAsk: number; upBid: number; downAsk: number | null; endTime: string }
  lim:  { id: string; title: string; upAsk: number; upBid: number; downAsk: number | null }
  fees: { poly: number; lim: number; total: number }
  arb:  FiveMinArb
}
interface FiveMinResponse { pairs: FiveMinPair[]; fetchedAt: number }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(v: number | null, digits = 3) {
  return v != null ? v.toFixed(digits) : '—'
}

function SpreadBadge({ pct, minPct = 1.5 }: { pct: number | null; minPct?: number }) {
  if (pct == null) return <span style={{ color: 'hsl(215,20%,40%)' }}>—</span>
  const hot = pct >= minPct
  return (
    <span
      className="font-bold tabular-nums px-1.5 py-0.5 rounded"
      style={{
        background: hot ? 'hsl(142,70%,10%)' : 'transparent',
        color: hot ? 'hsl(142,70%,55%)' : pct > 0.5 ? 'hsl(38,80%,55%)' : 'hsl(215,20%,45%)',
      }}
    >
      {pct > 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`}
    </span>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Scanner() {
  useWebSocket()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const setSelectedMarket = useStore((s) => s.setSelectedMarket)
  const opportunities = useStore((s) => s.opportunities)
  const scannerFilter = useStore((s) => s.scannerFilter)
  const setScannerFilter = useStore((s) => s.setScannerFilter)

  const [q, setQ] = useState('')
  const [minSpread, setMinSpread] = useState(0)  // 0 = show all pairs
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'pairs' | '5min'>('pairs')

  // ── 5-Min live market data via WebSocket ──────────────────────────────────
  const [fiveMinData, setFiveMinData] = useState<FiveMinResponse | null>(null)
  const [fiveMinLoading, setFiveMinLoading] = useState(false)
  const fiveMinFetched = useRef(false)

  // One-shot REST fetch when the tab first opens — gives us endTime and initial prices
  // while the WS subscription warms up.
  useEffect(() => {
    if (view !== '5min' || fiveMinFetched.current) return
    fiveMinFetched.current = true
    setFiveMinLoading(true)
    fetcher('/markets/5min')
      .then((d: unknown) => { setFiveMinData(d as FiveMinResponse); setFiveMinLoading(false) })
      .catch(() => setFiveMinLoading(false))
  }, [view])

  // Live price updates pushed by the backend whenever a Poly or Lim WS tick fires.
  // At most one broadcast per 500ms — no polling, no API cost.
  useChannel('prices.5min', (msg) => {
    const d = msg as { pairs?: FiveMinPair[]; fetchedAt?: number }
    if (d.pairs && d.pairs.length > 0) {
      setFiveMinData({ pairs: d.pairs, fetchedAt: d.fetchedAt ?? Date.now() })
    }
  })

  // ── Engine status (poll every 3s) ───────────────────────────────────────────
  const { data: engineStatus } = useQuery<EngineStatus>({
    queryKey: ['engine-status'],
    queryFn: () => fetcher('/arbitrage/engine/status'),
    refetchInterval: 3_000,
  })

  // ── Matched pairs (refetch every 2s to catch price updates from REST) ───────
  const { data: pairs = [], isLoading: pairsLoading } = useQuery<PairLive[]>({
    queryKey: ['pairs-live'],
    queryFn: () => fetcher('/arbitrage/pairs/live'),
    refetchInterval: 2_000,
    staleTime: 0,
  })

  // ── Engine mutations ────────────────────────────────────────────────────────
  const startEngine = useMutation({
    mutationFn: () => api.post('/arbitrage/engine/start').then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engine-status'] }),
  })
  const stopEngine = useMutation({
    mutationFn: () => api.post('/arbitrage/engine/stop').then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engine-status'] }),
  })
  const scanNow = useMutation({
    mutationFn: () => api.post('/arbitrage/scan').then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pairs-live'] })
      qc.invalidateQueries({ queryKey: ['engine-status'] })
    },
  })

  // ── Live WS price subscriptions for all visible pairs ───────────────────────
  const polyTokenIds = pairs.map((p) => p.polyTokenId ?? '').filter(Boolean)
  const limSlugs     = pairs.map((p) => p.limId).filter(Boolean)
  const wsPrices     = usePriceFeed(polyTokenIds, limSlugs)

  // ── Merge static pair prices with live WS prices ─────────────────────────
  const enriched = pairs.map((pair) => {
    const wsPolyPrice = pair.polyTokenId ? wsPrices.get(pair.polyTokenId) : null
    const wsLimPrice  = wsPrices.get(pair.limId)

    const polyAsk = wsPolyPrice?.ask ?? pair.poly.ask
    const polyBid = wsPolyPrice?.bid ?? pair.poly.bid
    const limAsk  = wsLimPrice?.ask  ?? pair.lim.ask
    const limBid  = wsLimPrice?.bid  ?? pair.lim.bid

    let spreadPct = pair.spreadPct
    let direction = pair.direction
    if (polyAsk != null && limAsk != null && polyAsk > 0 && limAsk > 0) {
      spreadPct = parseFloat(((Math.abs(polyAsk - limAsk) / Math.min(polyAsk, limAsk)) * 100).toFixed(2))
      direction = polyAsk < limAsk ? 'buy_poly_sell_lim' : 'buy_lim_sell_poly'
    }

    return { ...pair, poly: { bid: polyBid, ask: polyAsk }, lim: { bid: limBid, ask: limAsk }, spreadPct, direction, hasWs: !!(wsPolyPrice || wsLimPrice) }
  })

  // ── Market-filter keywords (mirrors Markets.tsx logic) ──────────────────────
  const CRYPTO_KW = ['bitcoin','btc','ethereum','eth','solana','sol','dogecoin','doge','hyperliquid','hype','crypto','bnb','xrp','ripple','microstrategy','mstr']
  const DURATION_KW: Record<string, RegExp[]> = {
    '5 Min':   [/candle\)/i, /5:?\s*min/i, /\d{1,2}:\d{2}(am|pm)-\d{1,2}:\d{2}(am|pm)/i],
    '15 Min':  [/\b15\s*min/i],
    '1 Hour':  [/candle\)/i, /\d+(am|pm)\s*et/i, /hourly/i, /\b1\s*hour/i],
    '4 Hours': [/above\s+_{2,}/i, /\b4\s*hour/i],
    'Daily':   [/daily/i, /\bon [a-z]+ \d+\?/i],
    'Weekly':  [/weekly/i, /\bweek\b/i],
  }
  const ASSET_KW: Record<string, string[]> = {
    Bitcoin: ['bitcoin','btc'], Ethereum: ['ethereum','eth'], Solana: ['solana','sol'],
    XRP: ['xrp','ripple'], Dogecoin: ['dogecoin','doge'], BNB: ['bnb'],
    Microstrategy: ['microstrategy','mstr'], Hyperliquid: ['hyperliquid','hype'],
  }

  function matchesScannerFilter(question: string): boolean {
    if (!scannerFilter || scannerFilter.topTab === 'all') return true
    const t = question.toLowerCase()
    if (scannerFilter.topTab === 'crypto') {
      if (!CRYPTO_KW.some(k => t.includes(k))) return false
      if (scannerFilter.dur && scannerFilter.dur !== 'All') {
        const pats = DURATION_KW[scannerFilter.dur]
        if (pats && !pats.some(r => r.test(question))) return false
      }
      if (scannerFilter.asset && scannerFilter.asset !== 'All') {
        const kws = ASSET_KW[scannerFilter.asset]
        if (kws && !kws.some(k => t.includes(k))) return false
      }
    }
    return true
  }

  // ── Filter + sort ──────────────────────────────────────────────────────────
  const filtered = enriched
    .filter((p) => {
      if (!matchesScannerFilter(p.polyQuestion)) return false
      if (q) {
        const ql = q.toLowerCase()
        if (!p.polyQuestion.toLowerCase().includes(ql) && !p.limTitle.toLowerCase().includes(ql)) return false
      }
      if (minSpread > 0 && (p.spreadPct ?? 0) < minSpread) return false
      return true
    })
    .sort((a, b) => (b.spreadPct ?? 0) - (a.spreadPct ?? 0))  // best spread first

  const running = engineStatus?.running ?? false
  const dim = { color: 'hsl(215,20%,50%)' }

  const handleSelect = (pair: typeof enriched[number]) => {
    setSelectedId(pair.conditionId)
    setSelectedMarket({ exchange: 'polymarket', id: pair.conditionId, question: pair.polyQuestion, tokenId: pair.polyTokenId ?? undefined })
  }

  return (
    <div className="flex flex-col gap-4 h-full">

      {/* ── Live Opportunities banner ── */}
      {opportunities.length > 0 && (
        <div className="rounded-xl border p-3 flex gap-3 overflow-x-auto shrink-0"
          style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(142,70%,20%)' }}>
          <div className="flex items-center gap-1.5 text-xs font-semibold shrink-0" style={{ color: 'hsl(142,70%,50%)' }}>
            <Zap size={12} /> {opportunities.length} live
          </div>
          {opportunities.slice(0, 5).map((opp) => (
            <div key={opp.id} className="shrink-0 rounded-lg px-3 py-1.5 text-xs space-y-0.5 cursor-pointer hover:opacity-80"
              style={{ background: 'hsl(142,70%,10%)', minWidth: '180px' }}>
              <p className="font-medium truncate" style={{ color: 'hsl(210,40%,90%)', maxWidth: '160px' }}>
                {opp.polyQuestion?.slice(0, 40)}…
              </p>
              <div className="flex gap-3" style={dim}>
                <span>Poly <span style={{ color: 'hsl(0,84%,60%)' }}>{opp.polymarketBestAsk?.toFixed(3)}</span></span>
                <span>Lim <span style={{ color: 'hsl(142,70%,55%)' }}>{opp.limitlessBestAsk?.toFixed(3)}</span></span>
                <span style={{ color: 'hsl(142,70%,50%)' }}>+{opp.estimatedProfitPct?.toFixed(1)}%</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Engine controls + scan button ── */}
      <div className="rounded-xl border p-3 flex items-center gap-3 shrink-0 flex-wrap"
        style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>

        {/* Engine status indicator */}
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${running ? 'animate-pulse' : ''}`}
            style={{ background: running ? 'hsl(142,70%,50%)' : 'hsl(215,20%,35%)', display: 'inline-block' }} />
          <span className="text-sm font-semibold" style={{ color: running ? 'hsl(142,70%,60%)' : 'hsl(215,20%,55%)' }}>
            Arb Engine {running ? 'Running' : 'Stopped'}
          </span>
        </div>

        {engineStatus?.lastError && (
          <span className="text-xs px-2 py-1 rounded" style={{ background: 'hsl(0,60%,10%)', color: 'hsl(0,70%,60%)' }}>
            {engineStatus.lastError}
          </span>
        )}

        <div className="flex gap-2 ml-auto">
          {/* Scan Now */}
          <button
            onClick={() => scanNow.mutate()}
            disabled={scanNow.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity disabled:opacity-50"
            style={{ background: 'hsl(217,32%,18%)', color: 'hsl(215,20%,75%)', border: '1px solid hsl(217,32%,25%)' }}
          >
            <RefreshCw size={12} className={scanNow.isPending ? 'animate-spin' : ''} />
            {scanNow.isPending ? 'Scanning…' : 'Scan Now'}
          </button>

          {/* Start/Stop Engine */}
          {!running ? (
            <button
              onClick={() => startEngine.mutate()}
              disabled={startEngine.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity disabled:opacity-50"
              style={{ background: 'hsl(142,70%,20%)', color: 'hsl(142,70%,70%)', border: '1px solid hsl(142,70%,30%)' }}
            >
              <Play size={12} /> Start Engine
            </button>
          ) : (
            <button
              onClick={() => stopEngine.mutate()}
              disabled={stopEngine.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity disabled:opacity-50"
              style={{ background: 'hsl(0,60%,15%)', color: 'hsl(0,70%,65%)', border: '1px solid hsl(0,60%,25%)' }}
            >
              <Square size={12} /> Stop Engine
            </button>
          )}
        </div>

        {/* Pair count summary */}
        <div className="text-xs w-full mt-1 flex gap-4" style={dim}>
          <span><span style={{ color: 'hsl(210,40%,85%)' }}>{pairs.length}</span> matched pairs</span>
          <span><span style={{ color: 'hsl(142,70%,55%)' }}>{enriched.filter(p => (p.spreadPct ?? 0) >= 1.5).length}</span> above threshold</span>
          <span><span style={{ color: 'hsl(38,80%,60%)' }}>{enriched.filter(p => p.hasWs).length}</span> live WS</span>
        </div>
      </div>

      {/* ── View mode tabs ── */}
      <div className="flex gap-1 shrink-0">
        {[
          { id: 'pairs' as const, label: 'All Pairs' },
          { id: '5min' as const,  label: '5-Min Live', icon: <Timer size={11} /> },
        ].map(tab => (
          <button key={tab.id} onClick={() => setView(tab.id)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
            style={view === tab.id
              ? { background: 'hsl(217,32%,20%)', color: 'hsl(210,40%,95%)', border: '1px solid hsl(217,32%,35%)' }
              : { background: 'transparent', color: 'hsl(215,20%,50%)', border: '1px solid hsl(217,32%,17%)' }}>
            {tab.icon}{tab.label}
          </button>
        ))}
      </div>

      {/* ── 5-Min Live panel ── */}
      {view === '5min' && (
        <div className="flex-1 min-h-0 rounded-xl border overflow-hidden flex flex-col"
          style={{ borderColor: 'hsl(217,32%,17%)', background: 'hsl(222,47%,8%)' }}>

          {/* Header */}
          <div className="px-4 py-2.5 border-b flex items-center gap-3 shrink-0"
            style={{ background: 'hsl(222,47%,10%)', borderColor: 'hsl(217,32%,17%)' }}>
            <Timer size={13} style={{ color: 'hsl(38,80%,55%)' }} />
            <span className="text-xs font-bold" style={{ color: 'hsl(210,40%,88%)' }}>5-Min Rotating Markets</span>
            <span className="text-xs ml-1" style={{ color: 'hsl(215,20%,45%)' }}>— live prices, refreshed every 3s</span>
            <div className="ml-auto text-[10px] px-2 py-0.5 rounded" style={{ background: 'hsl(38,80%,10%)', color: 'hsl(38,80%,60%)' }}>
              Fees: 2% Poly + 2% Lim = 4% total
            </div>
          </div>

          {/* Column headers */}
          <div className="grid text-[10px] font-semibold uppercase tracking-wider px-4 py-2 border-b shrink-0"
            style={{ gridTemplateColumns: '80px 1fr 1fr 1fr 1fr 1fr 1fr 110px', borderColor: 'hsl(217,32%,15%)', background: 'hsl(222,47%,9%)', color: 'hsl(215,20%,50%)' }}>
            <span>Asset</span>
            <span className="text-right">Poly Up↑</span>
            <span className="text-right">Poly Down↓</span>
            <span className="text-right">Lim Up↑</span>
            <span className="text-right">Lim Down↓</span>
            <span className="text-right">Same-Side</span>
            <span className="text-right">Cross-Hedge</span>
            <span className="text-right">Best Profit</span>
          </div>

          {/* Rows */}
          <div className="overflow-y-auto flex-1">
            {fiveMinLoading && !fiveMinData ? (
              <div className="text-center py-12 text-sm" style={{ color: 'hsl(215,20%,45%)' }}>
                Fetching 5-min markets…
              </div>
            ) : !fiveMinData?.pairs?.length ? (
              <div className="text-center py-12 text-sm" style={{ color: 'hsl(215,20%,45%)' }}>
                No active 5-min pairs found
              </div>
            ) : (
              fiveMinData.pairs.map(pair => {
                const hasCross = pair.arb.crossSide.profitable
                const hasSame  = pair.arb.sameSide.profitable
                const bestNet  = Math.max(pair.arb.crossSide.bestNetProfitPct, pair.arb.sameSide.netProfitPct)
                const hot      = bestNet > 0

                const priceFmt = (v: number | null | undefined) =>
                  v != null && v > 0 ? v.toFixed(3) : '—'
                const profitFmt = (v: number | null | undefined) =>
                  v != null ? (v > 0
                    ? <span style={{ color: 'hsl(142,70%,55%)' }}>+{v.toFixed(2)}%</span>
                    : <span style={{ color: 'hsl(215,20%,40%)' }}>{v.toFixed(2)}%</span>)
                  : <span style={{ color: 'hsl(215,20%,35%)' }}>—</span>

                return (
                  <div key={pair.asset}
                    className="grid items-center px-4 py-3 border-b transition-colors"
                    style={{
                      gridTemplateColumns: '80px 1fr 1fr 1fr 1fr 1fr 1fr 110px',
                      borderColor: 'hsl(217,32%,12%)',
                      background: hot ? 'hsl(142,70%,4%)' : 'transparent',
                    }}>
                    {/* Asset */}
                    <div className="flex items-center gap-1.5">
                      {hot && <Zap size={10} style={{ color: 'hsl(142,70%,55%)', flexShrink: 0 }} />}
                      <span className="text-xs font-bold uppercase" style={{ color: 'hsl(210,40%,88%)' }}>
                        {pair.asset.slice(0, 4)}
                      </span>
                    </div>

                    {/* Poly Up Ask */}
                    <div className="text-right tabular-nums text-xs" style={{ color: 'hsl(210,40%,80%)' }}>
                      {priceFmt(pair.poly.upAsk)}
                    </div>

                    {/* Poly Down Ask */}
                    <div className="text-right tabular-nums text-xs" style={{ color: 'hsl(210,40%,65%)' }}>
                      {priceFmt(pair.poly.downAsk)}
                    </div>

                    {/* Lim Up Ask */}
                    <div className="text-right tabular-nums text-xs" style={{ color: 'hsl(217,80%,70%)' }}>
                      {priceFmt(pair.lim.upAsk)}
                    </div>

                    {/* Lim Down Ask */}
                    <div className="text-right tabular-nums text-xs" style={{ color: 'hsl(217,80%,55%)' }}>
                      {priceFmt(pair.lim.downAsk)}
                    </div>

                    {/* Same-side arb */}
                    <div className="text-right tabular-nums text-xs">
                      {hasSame
                        ? profitFmt(pair.arb.sameSide.netProfitPct)
                        : <span style={{ color: 'hsl(215,20%,35%)' }}>{pair.arb.sameSide.netProfitPct.toFixed(2)}%</span>}
                    </div>

                    {/* Cross-hedge arb */}
                    <div className="text-right tabular-nums text-xs">
                      {hasCross
                        ? profitFmt(pair.arb.crossSide.bestNetProfitPct)
                        : <span style={{ color: 'hsl(215,20%,35%)' }}>{pair.arb.crossSide.bestNetProfitPct.toFixed(2)}%</span>}
                    </div>

                    {/* Best profit badge */}
                    <div className="text-right">
                      {hot ? (
                        <span className="text-xs font-bold px-2 py-0.5 rounded"
                          style={{ background: 'hsl(142,70%,12%)', color: 'hsl(142,70%,60%)' }}>
                          +{bestNet.toFixed(2)}%
                        </span>
                      ) : (
                        <span className="text-xs tabular-nums" style={{ color: 'hsl(215,20%,35%)' }}>
                          {bestNet.toFixed(2)}%
                        </span>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t text-[10px] flex gap-4 shrink-0"
            style={{ background: 'hsl(222,47%,9%)', borderColor: 'hsl(217,32%,15%)', color: 'hsl(215,20%,40%)' }}>
            <span>Cross-Hedge: buy Up on one exchange AND Down on the other — guaranteed winner pays $1</span>
            <span className="ml-auto" style={{ color: 'hsl(215,20%,30%)' }}>
              ⚠ Poly=Chainlink, Lim=Pyth — small oracle divergence risk on cross-hedge
            </span>
          </div>
        </div>
      )}

      {/* ── Markets page filter badge (pairs view only) ── */}
      {view === 'pairs' && scannerFilter && scannerFilter.topTab !== 'all' && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg border"
          style={{ background: 'hsl(217,50%,9%)', borderColor: 'hsl(217,80%,30%)' }}>
          <span className="text-xs font-semibold" style={{ color: 'hsl(217,80%,65%)' }}>Filtered:</span>
          {[
            scannerFilter.topTab,
            scannerFilter.dur,
            scannerFilter.asset,
            scannerFilter.sport,
            scannerFilter.esport,
          ].filter(Boolean).map((label) => (
            <span key={label} className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: 'hsl(217,60%,18%)', color: 'hsl(217,80%,75%)' }}>
              {label}
            </span>
          ))}
          <span className="text-xs ml-1" style={{ color: 'hsl(215,20%,50%)' }}>
            ({filtered.length} of {enriched.length} pairs)
          </span>
          <button onClick={() => setScannerFilter(null)} className="ml-auto hover:opacity-80">
            <X size={13} style={{ color: 'hsl(215,20%,55%)' }} />
          </button>
        </div>
      )}

      {/* ── Search + spread filter + pairs table (pairs view only) ── */}
      {view === 'pairs' && <>
      <div className="flex gap-2 items-center shrink-0 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border flex-1 min-w-[180px]"
          style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>
          <Search size={14} style={dim} />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search matched markets…"
            className="flex-1 bg-transparent text-sm outline-none" style={{ color: 'hsl(210,40%,98%)' }} />
        </div>

        {/* Min spread presets */}
        <div className="flex items-center gap-1 px-2 py-1.5 rounded-lg border"
          style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>
          {[{ label: 'All', min: 0 }, { label: '>0.5%', min: 0.5 }, { label: '>1%', min: 1 }, { label: '>2%', min: 2 }].map((p) => (
            <button key={p.min} onClick={() => setMinSpread(p.min)}
              className="px-2.5 py-1 rounded text-xs font-medium transition-colors"
              style={minSpread === p.min ? { background: 'hsl(217,32%,28%)', color: 'hsl(210,40%,95%)' } : { color: 'hsl(215,20%,50%)' }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Matched pairs table ── */}
      <div className="flex-1 min-h-0 rounded-xl border overflow-hidden flex flex-col"
        style={{ borderColor: 'hsl(217,32%,17%)' }}>

        {/* Table header */}
        <div className="grid text-[11px] font-semibold uppercase tracking-wider px-4 py-2.5 border-b shrink-0"
          style={{
            gridTemplateColumns: '1fr 100px 100px 16px 1fr 100px 100px 80px',
            background: 'hsl(222,47%,10%)', borderColor: 'hsl(217,32%,17%)', color: 'hsl(215,20%,55%)',
          }}>
          <span>Polymarket</span>
          <span className="text-right">Bid</span>
          <span className="text-right">Ask</span>
          <span />
          <span>Limitless</span>
          <span className="text-right">Bid</span>
          <span className="text-right">Ask</span>
          <span className="text-right">Spread</span>
        </div>

        {/* Table body */}
        <div className="overflow-y-auto flex-1" style={{ background: 'hsl(222,47%,8%)' }}>
          {pairsLoading && pairs.length === 0 ? (
            <div className="text-center py-16 text-sm" style={dim}>
              Loading matched pairs…
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 text-sm space-y-2" style={dim}>
              {pairs.length === 0 ? (
                <>
                  <p>No matched pairs found.</p>
                  <p className="text-xs">Click <strong style={{ color: 'hsl(215,20%,70%)' }}>Scan Now</strong> to fetch all markets and find matches.</p>
                </>
              ) : (
                <p>No pairs match the current filter.</p>
              )}
            </div>
          ) : (
            filtered.map((pair) => {
              const isSelected = selectedId === pair.conditionId
              const hasOpp = opportunities.some((o) => o.id === pair.conditionId)
              const spread = pair.spreadPct ?? 0
              const hot = spread >= 1.5
              const polyLive = !!wsPrices.get(pair.polyTokenId ?? '')
              const limLive  = !!wsPrices.get(pair.limId)

              return (
                <div
                  key={pair.conditionId}
                  className="grid items-center px-4 py-3 border-b hover:bg-white/5 transition-colors cursor-pointer"
                  style={{
                    gridTemplateColumns: '1fr 100px 100px 16px 1fr 100px 100px 80px',
                    borderColor: 'hsl(217,32%,13%)',
                    background: isSelected ? 'hsl(217,32%,12%)' : hot ? 'hsl(142,70%,4%)' : 'transparent',
                  }}
                  onClick={() => { handleSelect(pair); navigate('/trade') }}
                >
                  {/* Polymarket question */}
                  <div className="min-w-0 pr-3">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      {hasOpp && <Zap size={10} style={{ color: 'hsl(142,70%,55%)', flexShrink: 0 }} />}
                      {polyLive && <span className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style={{ background: 'hsl(142,70%,50%)' }} />}
                    </div>
                    <p className="text-xs leading-snug truncate" style={{ color: 'hsl(210,40%,88%)' }} title={pair.polyQuestion}>
                      {pair.polyQuestion}
                    </p>
                  </div>

                  {/* Poly bid */}
                  <div className="text-right tabular-nums text-xs" style={{ color: 'hsl(142,70%,50%)' }}>
                    {fmt(pair.poly.bid)}
                  </div>
                  {/* Poly ask */}
                  <div className="text-right tabular-nums text-xs font-medium" style={{ color: polyLive ? 'hsl(142,70%,65%)' : 'hsl(0,84%,60%)' }}>
                    {fmt(pair.poly.ask)}
                  </div>

                  {/* Direction arrow */}
                  <div className="flex justify-center">
                    <ArrowRightLeft size={10} style={{ color: hot ? 'hsl(142,70%,45%)' : 'hsl(217,32%,35%)' }} />
                  </div>

                  {/* Limitless title */}
                  <div className="min-w-0 px-2">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      {limLive && <span className="w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style={{ background: 'hsl(217,80%,60%)' }} />}
                    </div>
                    <p className="text-xs leading-snug truncate" style={{ color: 'hsl(210,40%,80%)' }} title={pair.limTitle}>
                      {pair.limTitle}
                    </p>
                  </div>

                  {/* Lim bid */}
                  <div className="text-right tabular-nums text-xs" style={{ color: 'hsl(142,70%,50%)' }}>
                    {fmt(pair.lim.bid)}
                  </div>
                  {/* Lim ask */}
                  <div className="text-right tabular-nums text-xs font-medium" style={{ color: limLive ? 'hsl(217,80%,70%)' : 'hsl(0,84%,60%)' }}>
                    {fmt(pair.lim.ask)}
                  </div>

                  {/* Spread */}
                  <div className="text-right">
                    <SpreadBadge pct={pair.spreadPct} />
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Table footer — legend */}
        <div className="px-4 py-2 border-t text-[10px] flex gap-4 shrink-0"
          style={{ background: 'hsl(222,47%,9%)', borderColor: 'hsl(217,32%,15%)', color: 'hsl(215,20%,40%)' }}>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full animate-pulse inline-block" style={{ background: 'hsl(142,70%,50%)' }} />
            Poly WS live
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full animate-pulse inline-block" style={{ background: 'hsl(217,80%,60%)' }} />
            Lim WS live
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded" style={{ background: 'hsl(142,70%,10%)' }} />
            ≥1.5% spread (arb threshold)
          </span>
          <span className="ml-auto flex items-center gap-1">
            <TrendingUp size={10} /> Click any pair to trade
          </span>
        </div>
      </div>
      </>}
    </div>
  )
}
