import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useChannel } from '../hooks/useWebSocket.ts'
import { useStore } from '../store/useStore.ts'
import { api } from '../lib/api.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AssetPrice {
  poly: { yesAsk: number | null; yesBid: number | null; noAsk: number | null; noBid: number | null } | null
  lim:  { yesAsk: number | null; yesBid: number | null; noAsk: number | null; noBid: number | null } | null
  opportunity: { direction: 'UP' | 'DOWN'; profitPct: number; totalCost: number; netProfit: number; secsToExpiry?: number } | null
  signal: { direction: 'UP' | 'DOWN'; exchange: 'poly' | 'lim'; entryPrice: number; confidence: number; evPct: number; gapPct: number } | null
  openTrade: { id: string; direction: 'UP' | 'DOWN'; positionSize: number; entryProfitPct: number; exitPnLPct: number | null } | null
  expiresAt?: number
}

interface OpenPosition {
  tradeId: string
  asset: string
  timeframe?: string
  direction: 'UP' | 'DOWN'
  type: 'arb' | 'signal' | 'xtf' | 'xasset' | 'buzzer' | 'spread'
  positionSize: number
  projectedProfitPct: number
  exitPnLPct: number | null
  expiresIn: number
  polyEntryPrice: number | null
  limEntryPrice: number | null
  xtfShortKey?: string | null
  xtfLongKey?: string | null
  xtfShortExchange?: string | null
  xtfLongExchange?: string | null
  xtfShortOutcome?: string | null
  xtfLongOutcome?: string | null
  spreadYesPlatform?: 'poly' | 'lim' | null
  spreadNoPlatform?: 'poly' | 'lim' | null
}

interface SpreadOpportunity {
  key: string; asset: string; timeframe: string
  yesPlatform: 'poly' | 'lim'; noPlatform: 'poly' | 'lim'
  yesAsk: number; noAsk: number; totalCost: number; spreadPct: number; secsToExpiry: number
}

interface ArbState {
  type: 'arb.state'
  assets: Record<string, AssetPrice>
  xtf?: Array<{ asset: string; shortKey: string; longKey: string; shortOutcome: string; longOutcome: string; gapPct: number; profitPct: number; secsToExpiry: number }>
  xasset?: Array<{ leaderAsset: string; followerAsset: string; followerKey: string; timeframe: string; direction: 'UP' | 'DOWN'; leaderMid: number; followerMid: number; gapPct: number; evPct: number; exchange: string; entryPrice: number; secsToExpiry: number }>
  spread?: SpreadOpportunity[]
  buzzer?: Record<string, { status: 'idle' | 'resting' | 'filled' | 'stood_down'; side: 'yes' | 'no' | null; entryPrice: number | null; shares: number | null; secsToExpiry: number }>
  apiCalls?: Record<'poly' | 'lim', { total: number; perMin: number }>
  sports?: SportsSnapshot
  copyTrade?: CopyTradeSnapshot
  engine: { running: boolean; autoExecute: boolean; minProfitPct: number; mode: 'arb' | 'signal' | 'both' | 'none'; signalMinGapPct: number; xtfEnabled?: boolean; xtfMinGapPct?: number; xAssetEnabled?: boolean; xAssetMinGapPct?: number; autoExit?: boolean; buzzerEnabled?: boolean; buzzerAutoExecute?: boolean; buzzerPositionSize?: number; sportEnabled?: boolean; cryptoEnabled?: boolean; copyTradeEnabled?: boolean; copyTradeAutoExecute?: boolean; copyTradePositionSize?: number; followedWallets?: string[]; spreadEnabled?: boolean; spreadAutoExecute?: boolean; spreadPositionSize?: number; spreadMinGapPct?: number; spreadPlatform?: 'poly' | 'lim' | 'best' }
  ts: number
}

// ── Leaderboard Copy-Trading types ───────────────────────────────────────────

interface LeaderboardEntry {
  rank: number
  proxyWallet: string
  userName: string
  xUsername: string | null
  verifiedBadge: boolean
  vol: number
  pnl: number
  profileImage: string | null
  windowVol?: number
  windowTradeCount?: number
  windowNetFlow?: number
  windowRank?: number
}

interface TraderStats {
  wallet: string
  totalPositions: number
  winningPositions: number
  winRate: number
  totalPnl: number
  totalRealizedPnl: number
  totalVolume: number
  avgPositionSize: number
  bestTrade: { title: string; pnl: number } | null
  worstTrade: { title: string; pnl: number } | null
  updatedAt: number
}

interface CopyTradeSignal {
  id: string
  wallet: string
  traderName: string
  ts: number
  side: 'BUY' | 'SELL'
  asset: string
  conditionId: string
  title: string
  size: number
  price: number
  status: 'detected' | 'executed' | 'failed' | 'skipped'
  error?: string
  copiedSize?: number
}

interface CopyTradeSnapshot {
  signals: CopyTradeSignal[]
  stats: Record<string, TraderStats>
}

interface SportsMatch {
  exchange: 'poly' | 'lim'
  kind: 'sports' | 'esports'
  league: string
  homeTeam: string
  awayTeam: string
  title: string
  homeAsk: number | null
  homeBid: number | null
  awayAsk: number | null
  awayBid: number | null
  score: string | null
  isLive: boolean
  startTime: number | null
}

interface SportsArbOpportunity {
  homeTeam: string
  awayTeam: string
  league: string
  kind: 'sports' | 'esports'
  poly: SportsMatch
  lim: SportsMatch
  buyHomeOn: 'poly' | 'lim'
  buyAwayOn: 'poly' | 'lim'
  homeCost: number
  awayCost: number
  totalCost: number
  profitPct: number
}

interface SportsMatchedEvent {
  homeTeam: string
  awayTeam: string
  league: string
  kind: 'sports' | 'esports'
  poly: SportsMatch
  lim: SportsMatch
}

interface SportsSnapshot {
  matched: SportsMatchedEvent[]
  opportunities: SportsArbOpportunity[]
}

interface DashboardData {
  balances: { polymarket: string | null; limitless: string | null; polyAddress: string | null; limAddress: string | null }
  stats: { totalTrades: number; wins: number; winRate: number; totalPnl: number }
  recentTrades: TradeRecord[]
  engine: { running: boolean; autoExecute: boolean; minProfitPct: number; maxPositionSize: number; mode?: 'arb' | 'signal' | 'both' | 'none'; signalMinGapPct?: number; apiCalls?: Record<'poly' | 'lim', { total: number; perMin: number }>; sportEnabled?: boolean; cryptoEnabled?: boolean }
}

interface TradeRecord {
  id: string
  ts: number
  asset: string
  direction: 'UP' | 'DOWN'
  profitPct: number
  positionSize: number
  success: boolean
  type?: 'arb' | 'signal' | 'xtf' | 'xasset' | 'buzzer' | 'spread'
  signalExchange?: 'poly' | 'lim'
  xtfShortKey?: string
  xtfLongKey?: string
  error?: string
}

interface LogEntry { ts: number; level: string; tag: string; msg: string }

// All 21 market keys: 7 assets × 3 timeframes
const CRYPTO_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'] as const
const TIMEFRAMES = ['5min', '15min', '1h'] as const
const ALL_KEYS = CRYPTO_ASSETS.flatMap(a => TIMEFRAMES.map(tf => `${a}-${tf}`))

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, decimals = 3): string {
  if (n == null) return '—'
  return n.toFixed(decimals)
}


function fmtKickoff(startTime: number | null | undefined, isLive: boolean, now: number): string {
  if (isLive) return 'LIVE'
  if (startTime == null) return '—'
  const diffMin = Math.round((startTime - now) / 60_000)
  if (diffMin <= 0) return 'started'
  if (diffMin < 60) return `in ${diffMin}m`
  return `in ${Math.floor(diffMin / 60)}h ${diffMin % 60}m`
}

function shortWallet(w: string): string {
  if (!w || w.length < 12) return w
  return `${w.slice(0, 6)}…${w.slice(-4)}`
}

function TraderStatsGrid({ stats }: { stats: TraderStats }) {
  return (
    <div className="grid grid-cols-3 gap-x-4 gap-y-1 font-mono text-[11px]" style={{color:'var(--dim)'}}>
      <span>Win% <span style={stats.winRate>=50?{color:'var(--ng)'}:{color:'var(--nr)'}}>{stats.winRate}%</span></span>
      <span>Pos <span style={{color:'var(--txt)'}}>{stats.totalPositions}</span></span>
      <span>AvgSz <span style={{color:'var(--txt)'}}>${stats.avgPositionSize.toFixed(0)}</span></span>
      <span>PnL <span style={stats.totalPnl>=0?{color:'var(--ng)'}:{color:'var(--nr)'}}>${stats.totalPnl.toFixed(0)}</span></span>
      <span>Real <span style={stats.totalRealizedPnl>=0?{color:'var(--ng)'}:{color:'var(--nr)'}}>${stats.totalRealizedPnl.toFixed(0)}</span></span>
      <span>Vol <span style={{color:'var(--txt)'}}>${stats.totalVolume.toFixed(0)}</span></span>
      {stats.bestTrade && (
        <span className="col-span-3 truncate" title={stats.bestTrade.title}>
          Best <span style={{color:'var(--ng)'}}>+${stats.bestTrade.pnl.toFixed(0)}</span> — {stats.bestTrade.title}
        </span>
      )}
      {stats.worstTrade && (
        <span className="col-span-3 truncate" title={stats.worstTrade.title}>
          Worst <span style={{color:'var(--nr)'}}>${stats.worstTrade.pnl.toFixed(0)}</span> — {stats.worstTrade.title}
        </span>
      )}
    </div>
  )
}

function fmtAgo(ts: number, now: number): string {
  const diffSec = Math.max(0, Math.round((now - ts) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  return `${Math.floor(diffSec / 3600)}h ago`
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return '0:00'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}


function tfLabel(tf: string): string {
  return tf
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const wsConnected = useStore(s => s.wsConnected)

  const [arbState, setArbState] = useState<ArbState | null>(null)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [openPositions, setOpenPositions] = useState<OpenPosition[]>([])
  const [tradeHistory, setTradeHistory] = useState<TradeRecord[]>([])
  const [leftTab, setLeftTab] = useState<'positions' | 'history'>('positions')
  const [balances, setBalances] = useState<DashboardData['balances'] | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [autoExecute, setAutoExecute] = useState(false)
  const [minProfit, setMinProfit] = useState(1.5)
  const [maxSize, setMaxSize] = useState(10)
  const [maxOpenTrades, setMaxOpenTrades] = useState(3)
  const [mode, setMode] = useState<'arb' | 'signal' | 'both' | 'none'>('arb')
  const [signalGap, setSignalGap] = useState(25)
  const [xtfEnabled, setXtfEnabled] = useState(false)
  const [xtfMinGapPct, setXtfMinGapPct] = useState(15)
  const [xAssetEnabled, setXAssetEnabled] = useState(false)
  const [xAssetMinGapPct, setXAssetMinGapPct] = useState(20)
  const [autoExit, setAutoExit] = useState(false)
  const [buzzerEnabled, setBuzzerEnabled] = useState(false)
  const [buzzerAutoExecute, setBuzzerAutoExecute] = useState(false)
  const [buzzerPositionSize, setBuzzerPositionSize] = useState(1.0)
  const [apiCalls, setApiCalls] = useState<Record<'poly' | 'lim', { total: number; perMin: number }>>({ poly: { total: 0, perMin: 0 }, lim: { total: 0, perMin: 0 } })
  const [sportEnabled, setSportEnabled] = useState(false)
  const [cryptoEnabled, setCryptoEnabled] = useState(true)
  const [sportsData, setSportsData] = useState<SportsSnapshot>({ matched: [], opportunities: [] })
  const [copyTradeEnabled, setCopyTradeEnabled] = useState(false)
  const [copyTradeAutoExecute, setCopyTradeAutoExecute] = useState(false)
  const [copyTradePositionSize, setCopyTradePositionSize] = useState(5.0)
  const [followedWallets, setFollowedWallets] = useState<string[]>([])
  const [copyTradeData, setCopyTradeData] = useState<CopyTradeSnapshot>({ signals: [], stats: {} })
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [leaderboardWindow, setLeaderboardWindow] = useState<'day' | 'week' | 'month'>('day')
  const [leaderboardLoading, setLeaderboardLoading] = useState(false)
  const [windowStatsReady, setWindowStatsReady] = useState<Record<string, boolean>>({})
  const [windowStatsPollTimer, setWindowStatsPollTimer] = useState<ReturnType<typeof setInterval> | null>(null)
  const [leaderboardStats, setLeaderboardStats] = useState<Record<string, TraderStats>>({})
  const [leaderboardStatsLoading, setLeaderboardStatsLoading] = useState<Record<string, boolean>>({})
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null)
  const [lbSortBy, setLbSortBy] = useState<'pnl' | 'vol' | 'winRate' | 'positions' | 'avgSize' | 'windowVol' | 'windowNetFlow' | 'windowTrades'>('pnl')
  const [lbSortDir, setLbSortDir] = useState<'desc' | 'asc'>('desc')
  const [lbFilterMinPnl, setLbFilterMinPnl] = useState('')
  const [lbFilterMinVol, setLbFilterMinVol] = useState('')
  const [lbFilterMinWinRate, setLbFilterMinWinRate] = useState('')
  const [lbFilterMinPositions, setLbFilterMinPositions] = useState('')
  const [lbFilterMaxAvgSize, setLbFilterMaxAvgSize] = useState('')
  const [lbFilterVerifiedOnly, setLbFilterVerifiedOnly] = useState(false)
  const [lbFilterFollowedOnly, setLbFilterFollowedOnly] = useState(false)
  const [lbBulkStatsLoading, setLbBulkStatsLoading] = useState(false)
  const [spreadEnabled, setSpreadEnabled] = useState(false)
  const [spreadAutoExecute, setSpreadAutoExecute] = useState(false)
  const [spreadPositionSize, setSpreadPositionSize] = useState(5.0)
  const [spreadMinGapPct, setSpreadMinGapPct] = useState(2.0)
  const [spreadPlatform, setSpreadPlatform] = useState<'poly' | 'lim' | 'best'>('best')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const logRef = useRef<HTMLDivElement>(null)

  // Initial dashboard fetch + periodic balance + log polling
  useEffect(() => {
    api.get('/dashboard').then(r => {
      const d = r.data as DashboardData
      setDashboard(d)
      setBalances(d.balances)
      setAutoExecute(d.engine?.autoExecute ?? false)
      setMinProfit(d.engine?.minProfitPct ?? 1.5)
      setMaxSize(d.engine?.maxPositionSize ?? 10)
      setMaxOpenTrades((d.engine as { maxOpenTrades?: number })?.maxOpenTrades ?? 3)
      setMode(d.engine?.mode ?? 'arb')
      setSignalGap(d.engine?.signalMinGapPct ?? 25)
      setXtfEnabled((d.engine as { xtfEnabled?: boolean })?.xtfEnabled ?? false)
      setXtfMinGapPct((d.engine as { xtfMinGapPct?: number })?.xtfMinGapPct ?? 15)
      setXAssetEnabled((d.engine as { xAssetEnabled?: boolean })?.xAssetEnabled ?? false)
      setXAssetMinGapPct((d.engine as { xAssetMinGapPct?: number })?.xAssetMinGapPct ?? 20)
      setAutoExit((d.engine as { autoExit?: boolean })?.autoExit ?? false)
      setBuzzerEnabled((d.engine as { buzzerEnabled?: boolean })?.buzzerEnabled ?? false)
      setBuzzerAutoExecute((d.engine as { buzzerAutoExecute?: boolean })?.buzzerAutoExecute ?? false)
      setBuzzerPositionSize((d.engine as { buzzerPositionSize?: number })?.buzzerPositionSize ?? 1.0)
      setSportEnabled(d.engine?.sportEnabled ?? false)
      setCryptoEnabled(d.engine?.cryptoEnabled ?? true)
      setCopyTradeEnabled((d.engine as { copyTradeEnabled?: boolean })?.copyTradeEnabled ?? false)
      setCopyTradeAutoExecute((d.engine as { copyTradeAutoExecute?: boolean })?.copyTradeAutoExecute ?? false)
      setCopyTradePositionSize((d.engine as { copyTradePositionSize?: number })?.copyTradePositionSize ?? 5.0)
      setFollowedWallets((d.engine as { followedWallets?: string[] })?.followedWallets ?? [])
      setSpreadEnabled((d.engine as { spreadEnabled?: boolean })?.spreadEnabled ?? false)
      setSpreadAutoExecute((d.engine as { spreadAutoExecute?: boolean })?.spreadAutoExecute ?? false)
      setSpreadPositionSize((d.engine as { spreadPositionSize?: number })?.spreadPositionSize ?? 5.0)
      setSpreadMinGapPct((d.engine as { spreadMinGapPct?: number })?.spreadMinGapPct ?? 2.0)
      setSpreadPlatform((d.engine as { spreadPlatform?: 'poly' | 'lim' | 'best' })?.spreadPlatform ?? 'best')
      if (d.engine?.apiCalls) setApiCalls(d.engine.apiCalls)
    }).catch(() => {})

    const balanceInterval = setInterval(() => {
      api.get('/balances').then(r => setBalances(r.data as DashboardData['balances'])).catch(() => {})
    }, 3_000)

    const positionsInterval = setInterval(() => {
      api.get('/positions').then(r => {
        setOpenPositions((r.data as { positions: OpenPosition[] }).positions ?? [])
      }).catch(() => {})
    }, 3_000)

    const tradesInterval = setInterval(() => {
      api.get('/trades').then(r => {
        setTradeHistory((r.data as { trades: TradeRecord[] }).trades ?? [])
      }).catch(() => {})
    }, 5_000)
    api.get('/trades').then(r => {
      setTradeHistory((r.data as { trades: TradeRecord[] }).trades ?? [])
    }).catch(() => {})

    const logInterval = setInterval(() => {
      api.get('/logs').then(r => {
        const entries = (r.data as { logs: LogEntry[] }).logs ?? []
        setLogs(entries.slice(-100).reverse())
      }).catch(() => {})
    }, 3_000)
    return () => { clearInterval(balanceInterval); clearInterval(positionsInterval); clearInterval(tradesInterval); clearInterval(logInterval) }
  }, [])

  // Live WS price + arb state
  useChannel('arb.state', useCallback((msg: unknown) => {
    const state = msg as ArbState
    if (state.type !== 'arb.state') return
    setArbState(state)
    // Always sync the AUTO EXECUTE button (it has its own immediate save)
    setAutoExecute(state.engine.autoExecute)
    if (state.apiCalls) setApiCalls(state.apiCalls)
    if (state.sports) setSportsData(state.sports)
    if (state.copyTrade) setCopyTradeData(state.copyTrade)
    // Only sync panel settings from server when the panel is closed —
    // if the panel is open the user may be editing and we must not overwrite their changes
    if (!settingsOpen) {
      setMinProfit(state.engine.minProfitPct)
      if (state.engine.mode) setMode(state.engine.mode)
      if (state.engine.signalMinGapPct != null) setSignalGap(state.engine.signalMinGapPct)
      if (state.engine.xtfEnabled != null) setXtfEnabled(state.engine.xtfEnabled)
      if (state.engine.xtfMinGapPct != null) setXtfMinGapPct(state.engine.xtfMinGapPct)
      if (state.engine.xAssetEnabled != null) setXAssetEnabled(state.engine.xAssetEnabled)
      if (state.engine.xAssetMinGapPct != null) setXAssetMinGapPct(state.engine.xAssetMinGapPct)
      if ((state.engine as { autoExit?: boolean }).autoExit != null) setAutoExit((state.engine as { autoExit?: boolean }).autoExit!)
      if (state.engine.buzzerEnabled != null) setBuzzerEnabled(state.engine.buzzerEnabled)
      if (state.engine.buzzerAutoExecute != null) setBuzzerAutoExecute(state.engine.buzzerAutoExecute)
      if (state.engine.buzzerPositionSize != null) setBuzzerPositionSize(state.engine.buzzerPositionSize)
      if (state.engine.sportEnabled != null) setSportEnabled(state.engine.sportEnabled)
      if (state.engine.cryptoEnabled != null) setCryptoEnabled(state.engine.cryptoEnabled)
      if (state.engine.copyTradeEnabled != null) setCopyTradeEnabled(state.engine.copyTradeEnabled)
      if (state.engine.copyTradeAutoExecute != null) setCopyTradeAutoExecute(state.engine.copyTradeAutoExecute)
      if (state.engine.copyTradePositionSize != null) setCopyTradePositionSize(state.engine.copyTradePositionSize)
      if (state.engine.followedWallets != null) setFollowedWallets(state.engine.followedWallets)
      if (state.engine.spreadEnabled != null) setSpreadEnabled(state.engine.spreadEnabled)
      if (state.engine.spreadAutoExecute != null) setSpreadAutoExecute(state.engine.spreadAutoExecute)
      if (state.engine.spreadPositionSize != null) setSpreadPositionSize(state.engine.spreadPositionSize)
      if (state.engine.spreadMinGapPct != null) setSpreadMinGapPct(state.engine.spreadMinGapPct)
      if (state.engine.spreadPlatform != null) setSpreadPlatform(state.engine.spreadPlatform)
    }
  }, [settingsOpen]))

  // Tick every second for expiry countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [])

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0
  }, [logs])

  // Load the leaderboard once when Copy Trading becomes the active strategy
  useEffect(() => {
    if (copyTradeEnabled && leaderboard.length === 0 && !leaderboardLoading) {
      loadLeaderboard()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copyTradeEnabled])

  const toggleAuto = async () => {
    const next = !autoExecute
    setAutoExecute(next)
    await api.put('/arb/settings', { autoExecute: next, minProfitPct: minProfit, maxPositionSize: maxSize, maxOpenTrades, mode, signalMinGapPct: signalGap, xtfEnabled, xtfMinGapPct, xAssetEnabled, xAssetMinGapPct, autoExit, buzzerEnabled, buzzerAutoExecute, buzzerPositionSize, sportEnabled, cryptoEnabled, spreadEnabled, spreadAutoExecute, spreadPositionSize, spreadMinGapPct, spreadPlatform }).catch(() => {})
  }

  // Buzzer Beater has its own standalone auto-execute switch, decoupled from the master AUTO button above
  const toggleBuzzerAuto = async () => {
    const next = !buzzerAutoExecute
    setBuzzerAutoExecute(next)
    await api.put('/arb/settings', { autoExecute, minProfitPct: minProfit, maxPositionSize: maxSize, maxOpenTrades, mode, signalMinGapPct: signalGap, xtfEnabled, xtfMinGapPct, xAssetEnabled, xAssetMinGapPct, autoExit, buzzerEnabled, buzzerAutoExecute: next, buzzerPositionSize, sportEnabled, cryptoEnabled }).catch(() => {})
  }

  const toggleSpread = async () => {
    const next = !spreadEnabled
    setSpreadEnabled(next)
    await api.put('/arb/settings', { autoExecute, minProfitPct: minProfit, maxPositionSize: maxSize, maxOpenTrades, mode, signalMinGapPct: signalGap, xtfEnabled, xtfMinGapPct, xAssetEnabled, xAssetMinGapPct, autoExit, buzzerEnabled, buzzerAutoExecute, buzzerPositionSize, sportEnabled, cryptoEnabled, spreadEnabled: next, spreadAutoExecute, spreadPositionSize, spreadMinGapPct, spreadPlatform }).catch(() => {})
  }

  // Crypto / Sport-Esport / Copy-Trading are three mutually-exclusive "primary strategy"
  // choices — exactly one (or none) runs at a time. Picking one fully suspends the other
  // two (no fetching, no scanning, no display), which is what makes each "standalone".
  const selectPrimaryStrategy = async (choice: 'crypto' | 'sport' | 'copytrade' | 'none') => {
    const nextCrypto = choice === 'crypto'
    const nextSport = choice === 'sport'
    const nextCopyTrade = choice === 'copytrade'
    setCryptoEnabled(nextCrypto)
    setSportEnabled(nextSport)
    setCopyTradeEnabled(nextCopyTrade)
    await api.put('/arb/settings', { autoExecute, minProfitPct: minProfit, maxPositionSize: maxSize, maxOpenTrades, mode, signalMinGapPct: signalGap, xtfEnabled, xtfMinGapPct, xAssetEnabled, xAssetMinGapPct, autoExit, buzzerEnabled, buzzerAutoExecute, buzzerPositionSize, sportEnabled: nextSport, cryptoEnabled: nextCrypto, copyTradeEnabled: nextCopyTrade }).catch(() => {})
  }

  const toggleSportEnabled = () => selectPrimaryStrategy(sportEnabled ? 'none' : 'sport')
  const toggleCryptoEnabled = () => selectPrimaryStrategy(cryptoEnabled ? 'none' : 'crypto')
  const toggleCopyTradeEnabled = () => selectPrimaryStrategy(copyTradeEnabled ? 'none' : 'copytrade')

  const toggleCopyTradeAutoExecute = async () => {
    const next = !copyTradeAutoExecute
    setCopyTradeAutoExecute(next)
    await api.put('/arb/settings', { copyTradeAutoExecute: next }).catch(() => {})
  }

  const saveCopyTradePositionSize = async (v: number) => {
    setCopyTradePositionSize(v)
    await api.put('/arb/settings', { copyTradePositionSize: v }).catch(() => {})
  }

  const loadLeaderboard = async (window: 'day' | 'week' | 'month' = leaderboardWindow) => {
    setLeaderboardLoading(true)
    if (windowStatsPollTimer) { clearInterval(windowStatsPollTimer); setWindowStatsPollTimer(null) }
    try {
      const r = await api.get('/leaderboard', { params: { window, limit: 50 } })
      const data = r.data as { entries: LeaderboardEntry[]; windowReady?: boolean }
      setLeaderboard(data.entries ?? [])
      if (!data.windowReady) {
        // Window stats are being computed in the background — poll every 4 s until ready
        setWindowStatsReady(s => ({ ...s, [window]: false }))
        const timer = setInterval(async () => {
          try {
            const pr = await api.get('/leaderboard/window-ready', { params: { window } })
            const pd = pr.data as { ready: boolean; entries: LeaderboardEntry[] }
            if (pd.ready && pd.entries.length > 0) {
              setLeaderboard(pd.entries)
              setWindowStatsReady(s => ({ ...s, [window]: true }))
              clearInterval(timer)
              setWindowStatsPollTimer(null)
            }
          } catch { /* ignore */ }
        }, 4_000)
        setWindowStatsPollTimer(timer)
      } else {
        setWindowStatsReady(s => ({ ...s, [window]: true }))
      }
    } catch { /* ignore */ }
    setLeaderboardLoading(false)
  }

  // Bulk-fetches stats for every leaderboard entry sequentially so stat-based filters work.
  const loadAllStats = async (entries: LeaderboardEntry[]) => {
    setLbBulkStatsLoading(true)
    const toFetch = entries.filter(e => !leaderboardStats[e.proxyWallet])
    for (const entry of toFetch) {
      const w = entry.proxyWallet
      setLeaderboardStatsLoading(s => ({ ...s, [w]: true }))
      try {
        const r = await api.get(`/leaderboard/${w}/stats`)
        setLeaderboardStats(s => ({ ...s, [w]: (r.data as { stats: TraderStats }).stats }))
      } catch { /* ignore */ }
      setLeaderboardStatsLoading(s => ({ ...s, [w]: false }))
    }
    setLbBulkStatsLoading(false)
  }

  const filteredLeaderboard = useMemo(() => {
    let list = [...leaderboard]
    if (lbFilterVerifiedOnly) list = list.filter(e => e.verifiedBadge)
    if (lbFilterFollowedOnly) list = list.filter(e => followedWallets.includes(e.proxyWallet))
    if (lbFilterMinPnl !== '') list = list.filter(e => e.pnl >= Number(lbFilterMinPnl))
    if (lbFilterMinVol !== '') list = list.filter(e => e.vol >= Number(lbFilterMinVol))
    if (lbFilterMinWinRate !== '') {
      const thr = Number(lbFilterMinWinRate)
      list = list.filter(e => (leaderboardStats[e.proxyWallet]?.winRate ?? -1) >= thr)
    }
    if (lbFilterMinPositions !== '') {
      const thr = Number(lbFilterMinPositions)
      list = list.filter(e => (leaderboardStats[e.proxyWallet]?.totalPositions ?? -1) >= thr)
    }
    if (lbFilterMaxAvgSize !== '') {
      const thr = Number(lbFilterMaxAvgSize)
      list = list.filter(e => {
        const s = leaderboardStats[e.proxyWallet]
        return s == null || s.avgPositionSize <= thr
      })
    }
    list.sort((a, b) => {
      let av = 0, bv = 0
      switch (lbSortBy) {
        case 'vol':           av = a.vol;  bv = b.vol;  break
        case 'winRate':       av = leaderboardStats[a.proxyWallet]?.winRate ?? -1;         bv = leaderboardStats[b.proxyWallet]?.winRate ?? -1;         break
        case 'positions':     av = leaderboardStats[a.proxyWallet]?.totalPositions ?? -1;  bv = leaderboardStats[b.proxyWallet]?.totalPositions ?? -1;  break
        case 'avgSize':       av = leaderboardStats[a.proxyWallet]?.avgPositionSize ?? -1; bv = leaderboardStats[b.proxyWallet]?.avgPositionSize ?? -1; break
        case 'windowVol':     av = a.windowVol ?? -1;     bv = b.windowVol ?? -1;     break
        case 'windowNetFlow': av = a.windowNetFlow ?? -1; bv = b.windowNetFlow ?? -1; break
        case 'windowTrades':  av = a.windowTradeCount ?? -1; bv = b.windowTradeCount ?? -1; break
        default:              av = a.pnl;  bv = b.pnl
      }
      return lbSortDir === 'desc' ? bv - av : av - bv
    })
    return list
  }, [leaderboard, lbSortBy, lbSortDir, lbFilterMinPnl, lbFilterMinVol, lbFilterMinWinRate, lbFilterMinPositions, lbFilterMaxAvgSize, lbFilterVerifiedOnly, lbFilterFollowedOnly, followedWallets, leaderboardStats])

  // On-demand stats for ANY leaderboard trader (not just followed ones) — click to expand,
  // fetched lazily and cached so browsing the leaderboard doesn't hammer the data-api.
  const toggleTraderStats = async (wallet: string) => {
    const next = expandedWallet === wallet ? null : wallet
    setExpandedWallet(next)
    if (next && !leaderboardStats[wallet] && !leaderboardStatsLoading[wallet]) {
      setLeaderboardStatsLoading(s => ({ ...s, [wallet]: true }))
      try {
        const r = await api.get(`/leaderboard/${wallet}/stats`)
        setLeaderboardStats(s => ({ ...s, [wallet]: (r.data as { stats: TraderStats }).stats }))
      } catch { /* ignore */ }
      setLeaderboardStatsLoading(s => ({ ...s, [wallet]: false }))
    }
  }

  const followTrader = async (entry: LeaderboardEntry) => {
    setFollowedWallets(w => w.includes(entry.proxyWallet) ? w : [...w, entry.proxyWallet])
    try {
      const r = await api.post('/copytrade/follow', { wallet: entry.proxyWallet, userName: entry.userName })
      setFollowedWallets((r.data as { followedWallets: string[] }).followedWallets ?? [])
    } catch { /* ignore */ }
  }

  const unfollowTrader = async (wallet: string) => {
    setFollowedWallets(w => w.filter(x => x !== wallet))
    try {
      const r = await api.post('/copytrade/unfollow', { wallet })
      setFollowedWallets((r.data as { followedWallets: string[] }).followedWallets ?? [])
    } catch { /* ignore */ }
  }

  const saveSettings = async () => {
    await api.put('/arb/settings', { autoExecute, minProfitPct: minProfit, maxPositionSize: maxSize, maxOpenTrades, mode, signalMinGapPct: signalGap, xtfEnabled, xtfMinGapPct, xAssetEnabled, xAssetMinGapPct, autoExit, buzzerEnabled, buzzerAutoExecute, buzzerPositionSize, sportEnabled, cryptoEnabled, spreadEnabled, spreadAutoExecute, spreadPositionSize, spreadMinGapPct, spreadPlatform }).catch(() => {})
    setSettingsOpen(false)
  }

  const fireManual = async (key: string) => {
    await api.post(`/arb/execute/${key}`).catch(() => {})
  }

  const fireSignal = async (key: string) => {
    await api.post(`/signal/execute/${key}`).catch(() => {})
  }

  const fireSpread = async (key: string) => {
    await api.post(`/spread/execute/${key}`).catch(() => {})
  }

  const closeEarly = async (tradeId: string) => {
    await api.post(`/arb/close/${tradeId}`).catch(() => {})
  }

  const engineRunning = arbState?.engine.running ?? dashboard?.engine.running ?? false
  const activeMode = arbState?.engine.mode ?? mode

  // Earliest expiry across all market keys
  const windowExpiry = arbState
    ? Math.min(...Object.values(arbState.assets).map(a => (a as AssetPrice).expiresAt ?? Infinity).filter(t => t < Infinity))
    : Infinity
  const windowMs = windowExpiry < Infinity ? windowExpiry - now : null

  const showArb    = activeMode === 'arb'    || activeMode === 'both'
  const showSignal = activeMode === 'signal' || activeMode === 'both'

  // Clear, independent ON/OFF switches for Arb and Signal, mapped onto the
  // `mode` enum — both can be off simultaneously (mode: 'none').
  const arbOn = mode === 'arb' || mode === 'both'
  const signalOn = mode === 'signal' || mode === 'both'
  const toggleArbSignal = (s: 'arb' | 'signal') => {
    const nextArb = s === 'arb' ? !arbOn : arbOn
    const nextSignal = s === 'signal' ? !signalOn : signalOn
    setMode(nextArb && nextSignal ? 'both' : nextArb ? 'arb' : nextSignal ? 'signal' : 'none')
  }

  // Determine which keys to display: use WS state keys if available, else ALL_KEYS
  const displayKeys = arbState
    ? [...new Set([...ALL_KEYS, ...Object.keys(arbState.assets ?? {})])]
    : ALL_KEYS

  // ── Table sort ───────────────────────────────────────────────────────────────
  const [tableSort, setTableSort] = useState<{ col: string; dir: 'asc' | 'desc' }>({ col: 'arb', dir: 'desc' })

  const keyMetrics = useMemo(() => {
    const map: Record<string, { arb: number; up: number; down: number; ev: number; spread: number }> = {}
    for (const key of displayKeys) {
      const d = arbState?.assets?.[key]
      const poly = d?.poly; const lim = d?.lim
      const up = (lim?.yesBid != null && poly?.yesAsk != null && poly.yesAsk > 0 && lim.yesBid > 0)
        ? ((lim.yesBid - poly.yesAsk - 0.04) / (poly.yesAsk + (1 - lim.yesBid))) * 100 : -999
      const down = (poly?.yesBid != null && lim?.yesAsk != null && poly.yesBid > 0 && lim.yesAsk > 0 && lim.yesAsk < 1)
        ? ((poly.yesBid - lim.yesAsk - 0.04) / ((1 - poly.yesBid) + lim.yesAsk)) * 100 : -999
      const ev = d?.signal?.evPct ?? -999
      const pyA = poly?.yesAsk ?? null
      const pnA = poly?.noAsk ?? (poly?.yesBid != null && poly.yesBid > 0 ? 1 - poly.yesBid : null)
      const lyA = lim?.yesAsk ?? null
      const lnA = lim?.noAsk ?? (lim?.yesBid != null && lim.yesBid > 0 ? 1 - lim.yesBid : null)
      let yA: number | null, nA: number | null
      if (spreadPlatform === 'poly')     { yA = pyA; nA = pnA }
      else if (spreadPlatform === 'lim') { yA = lyA; nA = lnA }
      else { yA = pyA != null && lyA != null ? Math.min(pyA, lyA) : (pyA ?? lyA); nA = pnA != null && lnA != null ? Math.min(pnA, lnA) : (pnA ?? lnA) }
      const total = yA && nA ? yA + nA : null
      const spread = total ? ((1 - total - (yA ?? 0) * 0.02 - (nA ?? 0) * 0.02) / total) * 100 : -999
      map[key] = { arb: d?.opportunity?.profitPct ?? -999, up, down, ev, spread }
    }
    return map
  }, [arbState, displayKeys, spreadPlatform])

  const sortedKeys = useMemo(() => {
    const col = tableSort.col
    return [...displayKeys].sort((a, b) => {
      if (col === 'key') {
        const cmp = a.localeCompare(b)
        return tableSort.dir === 'asc' ? cmp : -cmp
      }
      const ma = keyMetrics[a] ?? {}; const mb = keyMetrics[b] ?? {}
      const va = (ma as Record<string, number>)[col] ?? -999
      const vb = (mb as Record<string, number>)[col] ?? -999
      return tableSort.dir === 'desc' ? vb - va : va - vb
    })
  }, [displayKeys, keyMetrics, tableSort])

  return (
    <div className="min-h-screen flex flex-col" style={{background:'var(--bg0)',color:'var(--txt)'}}>
      <div className="scanline" />

      {/* ── Top bar ── */}
      <header className="flex items-center justify-between px-4 py-2 shrink-0" style={{background:'var(--bg1)',borderBottom:'1px solid var(--bd)'}}>
        {/* Brand */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded flex items-center justify-center text-sm font-bold" style={{background:'rgba(255,51,102,0.15)',border:'1px solid rgba(255,51,102,0.4)',boxShadow:'0 0 10px rgba(255,51,102,0.2)'}}>⚡</div>
            <div>
              <div className="text-white font-bold text-sm tracking-widest">ARB BOT</div>
              <div className="text-[8px] tracking-widest uppercase" style={{color:'var(--ng)'}}>ARBITRAGE v2.0 BOT</div>
            </div>
          </div>
          <div style={{width:'1px',height:'28px',background:'var(--bd2)'}} />
          {/* Live / WS status */}
          <span className={`text-[10px] px-2 py-0.5 rounded font-bold tracking-widest ${engineRunning ? 'btn-ng' : 'btn-nr'}`}
            style={engineRunning ? {background:'rgba(0,255,136,0.1)',border:'1px solid rgba(0,255,136,0.35)',color:'var(--ng)',textShadow:'0 0 6px rgba(0,255,136,0.5)'} : {background:'rgba(255,51,102,0.1)',border:'1px solid rgba(255,51,102,0.35)',color:'var(--nr)'}}>
            {engineRunning ? '● LIVE' : '○ STOPPED'}
          </span>
          <span className="text-[10px] font-mono" style={{color: wsConnected ? 'var(--nc)' : 'var(--dim)'}}>
            {wsConnected ? '◈ WS' : '◇ WS'}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded font-bold tracking-wider"
            style={{background:'rgba(15,28,56,0.8)',border:'1px solid var(--bd2)',color: activeMode==='arb' ? 'var(--ng)' : activeMode==='signal' ? 'var(--np)' : activeMode==='none' ? 'var(--dim)' : 'var(--nc)'}}>
            {activeMode.toUpperCase()}
          </span>
        </div>

        {/* Ticker stats */}
        <div className="flex items-center flex-1 mx-4 overflow-hidden" style={{borderLeft:'1px solid var(--bd)',borderRight:'1px solid var(--bd)'}}>
          <div className="ticker-item">
            <span className="ticker-label">POLY</span>
            <span className="font-bold text-[11px]" style={{color:'var(--ng)'}}>${balances?.polymarket ?? '—'}</span>
          </div>
          <div className="ticker-item">
            <span className="ticker-label">LIM</span>
            <span className="font-bold text-[11px]" style={{color:'var(--nc)'}}>${balances?.limitless ?? '—'}</span>
          </div>
          {dashboard?.stats && (
            <div className="ticker-item">
              <span className="ticker-label">PnL</span>
              <span className="font-bold text-[11px]" style={{color:(dashboard.stats.totalPnl??0)>=0 ? 'var(--ng)' : 'var(--nr)'}}>
                ${dashboard.stats.totalPnl?.toFixed(2) ?? '0.00'}
              </span>
            </div>
          )}
          <div className="ticker-item">
            <span className="ticker-label">POLY API</span>
            <span className="font-mono text-[11px]" style={{color: apiCalls.poly.perMin>=100 ? 'var(--nr)' : apiCalls.poly.perMin>=50 ? 'var(--no)' : 'var(--dim)'}}>{apiCalls.poly.perMin}/min</span>
          </div>
          <div className="ticker-item">
            <span className="ticker-label">LIM API</span>
            <span className="font-mono text-[11px]" style={{color: apiCalls.lim.perMin>=100 ? 'var(--nr)' : apiCalls.lim.perMin>=50 ? 'var(--no)' : 'var(--dim)'}}>{apiCalls.lim.perMin}/min</span>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={toggleAuto}
            className="text-[10px] px-3 py-1.5 rounded font-bold tracking-wider transition-all"
            style={autoExecute ? {background:'rgba(0,255,136,0.12)',border:'1px solid rgba(0,255,136,0.4)',color:'var(--ng)',textShadow:'0 0 6px rgba(0,255,136,0.5)',boxShadow:'0 0 10px rgba(0,255,136,0.1)'} : {background:'rgba(15,28,56,0.8)',border:'1px solid var(--bd2)',color:'var(--dim)'}}>
            AUTO {autoExecute ? 'ON' : 'OFF'}
          </button>
          {buzzerEnabled && (
            <button onClick={toggleBuzzerAuto}
              className="text-[10px] px-3 py-1.5 rounded font-bold tracking-wider transition-all"
              style={buzzerAutoExecute ? {background:'rgba(255,153,0,0.12)',border:'1px solid rgba(255,153,0,0.4)',color:'var(--no)',textShadow:'0 0 6px rgba(255,153,0,0.5)'} : {background:'rgba(15,28,56,0.8)',border:'1px solid var(--bd2)',color:'var(--dim)'}}>
              🔔 {buzzerAutoExecute ? 'ON' : 'OFF'}
            </button>
          )}
          <button onClick={() => setSettingsOpen(s => !s)}
            className="text-[10px] px-3 py-1.5 rounded font-bold tracking-wider transition-all btn-dim"
            style={{background:'rgba(15,28,56,0.8)',border:'1px solid var(--bd2)',color: settingsOpen ? 'var(--nc)' : 'var(--dim)'}}>
            ⚙ CONFIG
          </button>
          <Link to="/settings" className="text-[10px] px-3 py-1.5 rounded font-bold tracking-wider" style={{background:'rgba(15,28,56,0.8)',border:'1px solid var(--bd2)',color:'var(--dim)'}}>
            ↗ CREDS
          </Link>
        </div>
      </header>

      {/* ── Settings / strategy config panel ── */}
      {settingsOpen && (
        <div className="shrink-0" style={{background:'var(--bg1)',borderBottom:'1px solid var(--bd)'}}>
          {/* Row 1 — main arb params */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5" style={{borderBottom:'1px solid var(--bd)'}}>
            <span className="wlabel">Strategies</span>
            {[
              {label:'ARB',    active:arbOn,         color:'var(--ng)', fn:()=>toggleArbSignal('arb'),    title:'Cross-exchange arbitrage'},
              {label:'SIGNAL', active:signalOn,       color:'var(--np)', fn:()=>toggleArbSignal('signal'), title:'Directional signal trades'},
              {label:'XTF',    active:xtfEnabled,     color:'var(--nb)', fn:()=>setXtfEnabled(v=>!v),      title:'Cross-timeframe signals'},
              {label:'XASSET', active:xAssetEnabled,  color:'var(--nc)', fn:()=>setXAssetEnabled(v=>!v),   title:'Cross-asset correlation'},
              {label:'SPREAD', active:spreadEnabled,  color:'var(--ny)', fn:toggleSpread,                   title:'Buy both YES+NO — profit from bid/ask spread'},
            ].map(b=>(
              <button key={b.label} type="button" onClick={b.fn} title={b.title}
                className="text-[10px] px-2.5 py-1 rounded font-bold tracking-wider transition-all"
                style={b.active ? {background:`${b.color}18`,border:`1px solid ${b.color}55`,color:b.color,textShadow:`0 0 6px ${b.color}88`} : {background:'rgba(15,28,56,0.8)',border:'1px solid var(--bd2)',color:'var(--dim)'}}>
                {b.label} {b.active ? 'ON' : 'OFF'}
              </button>
            ))}
            {spreadEnabled && (<>
              <div style={{width:'1px',height:'18px',background:'var(--bd2)'}} />
              <label className="flex items-center gap-1.5 text-[10px] cursor-pointer" style={{color:'var(--dim)'}}>
                <input type="checkbox" checked={spreadAutoExecute} onChange={e=>setSpreadAutoExecute(e.target.checked)} />
                <span style={{color:'var(--ny)'}}>Auto-execute</span>
              </label>
              <label className="flex items-center gap-1.5 text-[10px]" style={{color:'var(--dim)'}}>
                Size $<input type="number" step="0.5" min="0.5" max="10000" value={spreadPositionSize} onChange={e=>setSpreadPositionSize(parseFloat(e.target.value))} className="w-16 px-1.5 py-0.5 text-[11px] font-mono" />
              </label>
              <label className="flex items-center gap-1.5 text-[10px]" style={{color:'var(--dim)'}}>
                Min% <input type="number" step="0.1" min="0.1" max="20" value={spreadMinGapPct} onChange={e=>setSpreadMinGapPct(parseFloat(e.target.value))} className="w-14 px-1.5 py-0.5 text-[11px] font-mono" />
              </label>
              <label className="flex items-center gap-1.5 text-[10px]" style={{color:'var(--dim)'}}>
                Platform
                <select value={spreadPlatform} onChange={e=>setSpreadPlatform(e.target.value as 'poly'|'lim'|'best')}
                  className="px-1.5 py-0.5 text-[11px] font-mono"
                  style={{background:'var(--bg0)',border:'1px solid var(--bd2)',color:'var(--nc)',borderRadius:2,outline:'none'}}>
                  <option value="best">Best (cross-platform)</option>
                  <option value="poly">Polymarket only</option>
                  <option value="lim">Limitless only</option>
                </select>
              </label>
            </>)}
            <div style={{width:'1px',height:'18px',background:'var(--bd2)'}} />
            {[
              {label:'Min profit %', val:minProfit, set:setMinProfit, step:0.1, min:0.1, max:20,   w:'w-16'},
              {label:'Max position $',val:maxSize,  set:setMaxSize,   step:0.01,min:0.01,max:10000,w:'w-20'},
              {label:'Max open trades',val:maxOpenTrades,set:setMaxOpenTrades,step:1,min:1,max:20, w:'w-14'},
            ].map(f=>(
              <label key={f.label} className="flex items-center gap-1.5 text-[10px]" style={{color:'var(--dim)'}}>
                {f.label}
                <input type="number" step={f.step} min={f.min} max={f.max} value={f.val}
                  onChange={e=>f.set(parseFloat(e.target.value) as never)}
                  className={`${f.w} px-1.5 py-0.5 text-[11px] font-mono`} />
              </label>
            ))}
            {signalOn && <label className="flex items-center gap-1.5 text-[10px]" style={{color:'var(--dim)'}}>Signal gap % <input type="number" step="1" min="1" max="99" value={signalGap} onChange={e=>setSignalGap(parseInt(e.target.value))} className="w-14 px-1.5 py-0.5 text-[11px] font-mono" /></label>}
            {xtfEnabled && <label className="flex items-center gap-1.5 text-[10px]" style={{color:'var(--dim)'}}>XTF gap % <input type="number" step="1" min="5" max="50" value={xtfMinGapPct} onChange={e=>setXtfMinGapPct(parseInt(e.target.value))} className="w-12 px-1.5 py-0.5 text-[11px] font-mono" /></label>}
            {xAssetEnabled && <label className="flex items-center gap-1.5 text-[10px]" style={{color:'var(--dim)'}}>XAsset gap % <input type="number" step="1" min="5" max="50" value={xAssetMinGapPct} onChange={e=>setXAssetMinGapPct(parseInt(e.target.value))} className="w-12 px-1.5 py-0.5 text-[11px] font-mono" /></label>}
            <label className="flex items-center gap-1.5 text-[10px] cursor-pointer" style={{color:'var(--dim)'}}>
              <input type="checkbox" checked={autoExit} onChange={e=>setAutoExit(e.target.checked)} />
              Auto-close in profit
            </label>
            <button onClick={saveSettings} className="text-[10px] px-3 py-1 rounded font-bold tracking-wider transition-all"
              style={{background:'rgba(0,153,255,0.12)',border:'1px solid rgba(0,153,255,0.4)',color:'var(--nb)',textShadow:'0 0 6px rgba(0,153,255,0.5)'}}>Save</button>
            <button onClick={()=>setSettingsOpen(false)} className="text-[10px]" style={{color:'var(--dim)'}}>Cancel</button>
          </div>

          {/* Row 2 — standalone strategies */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-0 px-4" style={{borderBottom:'1px solid var(--bd)'}}>
            {/* Buzzer */}
            <div className="flex items-center gap-3 py-2" style={{borderRight:'1px solid var(--bd)',paddingRight:'24px',marginRight:'0'}}>
              <span className="text-[10px] font-bold tracking-wider" style={{color:'var(--no)'}}>🔔 BUZZER BEATER</span>
              <label className="flex items-center gap-1.5 text-[10px] cursor-pointer" style={{color:'var(--dim)'}}>
                <input type="checkbox" checked={buzzerEnabled} onChange={e=>setBuzzerEnabled(e.target.checked)} />
                <span title="Late-window strategy: rests a limit BUY once a side's ask ≥0.95">Enabled</span>
              </label>
              {buzzerEnabled && <>
                <label className="flex items-center gap-1.5 text-[10px] cursor-pointer" style={{color:'var(--dim)'}}>
                  <input type="checkbox" checked={buzzerAutoExecute} onChange={e=>setBuzzerAutoExecute(e.target.checked)} />
                  Auto-execute
                </label>
                <label className="flex items-center gap-1.5 text-[10px]" style={{color:'var(--dim)'}}>
                  Bet $ <input type="number" step="0.01" min="0.01" max="1000" value={buzzerPositionSize} onChange={e=>setBuzzerPositionSize(parseFloat(e.target.value))} className="w-16 px-1.5 py-0.5 text-[11px] font-mono" />
                </label>
              </>}
            </div>
            {/* Sport */}
            <div className="flex items-center gap-3 py-2" style={{borderRight:'1px solid var(--bd)',paddingRight:'24px'}}>
              <span className="text-[10px] font-bold tracking-wider" style={{color:'#4ade80'}}>⚽ SPORT / ESPORT</span>
              <label className="flex items-center gap-1.5 text-[10px] cursor-pointer" style={{color:'var(--dim)'}}>
                <input type="checkbox" checked={sportEnabled} onChange={()=>toggleSportEnabled()} />
                <span title="Polls Poly + Limitless for live sports markets — mutually exclusive with Crypto & CopyTrade">Enabled</span>
              </label>
              <label className="flex items-center gap-1.5 text-[10px] cursor-pointer" style={{color:'var(--dim)'}}>
                <input type="checkbox" checked={cryptoEnabled} onChange={()=>toggleCryptoEnabled()} />
                Crypto pipeline {cryptoEnabled ? <span style={{color:'var(--ng)'}}>ON</span> : <span style={{color:'var(--nr)'}}>OFF</span>}
              </label>
            </div>
            {/* Copy trading */}
            <div className="flex items-center gap-3 py-2">
              <span className="text-[10px] font-bold tracking-wider" style={{color:'var(--nc)'}}>📋 COPY TRADING</span>
              <label className="flex items-center gap-1.5 text-[10px] cursor-pointer" style={{color:'var(--dim)'}}>
                <input type="checkbox" checked={copyTradeEnabled} onChange={()=>toggleCopyTradeEnabled()} />
                <span title="Polls followed wallets every 60s — mutually exclusive with Crypto & Sport">Enabled</span>
              </label>
              {copyTradeEnabled && <>
                <label className="flex items-center gap-1.5 text-[10px] cursor-pointer" style={{color:'var(--dim)'}}>
                  <input type="checkbox" checked={copyTradeAutoExecute} onChange={()=>toggleCopyTradeAutoExecute()} />
                  Auto-copy
                </label>
                <label className="flex items-center gap-1.5 text-[10px]" style={{color:'var(--dim)'}}>
                  Size $ <input type="number" step="0.5" min="1" max="1000" value={copyTradePositionSize} onChange={e=>saveCopyTradePositionSize(parseFloat(e.target.value))} className="w-16 px-1.5 py-0.5 text-[11px] font-mono" />
                </label>
              </>}
            </div>
          </div>
        </div>
      )}


      {/* ── Sport/Esport matched events ── */}
      {sportEnabled && (sportsData.matched.length > 0 || sportsData.opportunities.length > 0) && (
        <div className="shrink-0 px-3 py-2" style={{background:'rgba(0,255,136,0.03)',borderBottom:'1px solid var(--bd)'}}>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] font-bold tracking-wider" style={{color:'#4ade80'}}>⚽ SPORT / ESPORT ARB</span>
            <span className="text-[9px]" style={{color:'var(--dim)'}}>{sportsData.matched.length} matched event{sportsData.matched.length === 1 ? '' : 's'} across both exchanges</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {sportsData.matched.map((ev, i) => {
              const opp = sportsData.opportunities.find(o => o.homeTeam === ev.homeTeam && o.awayTeam === ev.awayTeam)
              const kickoff = fmtKickoff(ev.poly.startTime ?? ev.lim.startTime, ev.poly.isLive || ev.lim.isLive, now)
              return (
                <div key={i} className="text-xs rounded px-2.5 py-1.5" style={opp ? {background:'rgba(0,255,136,0.06)',border:'1px solid rgba(0,255,136,0.25)'} : {background:'var(--bg1)',border:'1px solid var(--bd)'}}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] uppercase px-1 rounded" style={{background:'var(--bg2)',color:'var(--dim)'}}>{ev.kind === 'esports' ? 'ESPORT' : 'SPORT'}</span>
                    <span className="text-[9px] uppercase px-1 rounded" style={kickoff==='LIVE' ? {background:'rgba(255,51,102,0.15)',color:'var(--nr)'} : {background:'var(--bg2)',color:'var(--dim)'}}>{kickoff}</span>
                    <span className="text-[10px]" style={{color:'var(--dim)'}}>{ev.league}</span>
                    <span className="text-white font-medium">{ev.homeTeam} <span style={{color:'var(--dim)'}}>vs</span> {ev.awayTeam}</span>
                    {ev.poly.score && <span className="font-mono text-[10px]" style={{color:'var(--nc)'}}>{ev.poly.score}</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1 font-mono text-[10px]" style={{color:'var(--dim)'}}>
                    <span>POLY home {fmt(ev.poly.homeAsk, 2)} / away {fmt(ev.poly.awayAsk, 2)}</span>
                    <span>LIM home {fmt(ev.lim.homeAsk, 2)} / away {fmt(ev.lim.awayAsk, 2)}</span>
                    {opp && <span className="font-bold neon-g">ARB: buy home@{opp.buyHomeOn.toUpperCase()} {fmt(opp.homeCost,2)} + away@{opp.buyAwayOn.toUpperCase()} {fmt(opp.awayCost,2)} = {fmt(opp.totalCost,2)} → +{opp.profitPct.toFixed(1)}%</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Main body ── */}
      <div className="flex flex-col flex-1 overflow-hidden">

        {/* Crypto sections — hidden while Sport/Esport or Copy Trading active */}
        {!sportEnabled && !copyTradeEnabled && (
        <>
        {/* Arb table */}
        <div className="overflow-x-auto shrink-0">
          <table className="w-full arb-table">
            <thead>
              <tr>
                {(() => {
                  const Th = ({ col, align = 'right', color, children }: { col: string; align?: string; color?: string; children: React.ReactNode }) => {
                    const active = tableSort.col === col
                    return (
                      <th className={`text-${align} cursor-pointer select-none`} title={`Sort by ${col}`}
                        style={{ color: active ? 'var(--nc)' : (color ?? 'var(--dim)'), userSelect: 'none' }}
                        onClick={() => setTableSort(s => s.col === col ? { col, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { col, dir: 'desc' })}>
                        {children}{active ? (tableSort.dir === 'desc' ? ' ▼' : ' ▲') : <span style={{opacity:0.3}}> ▼</span>}
                      </th>
                    )
                  }
                  return (<>
                    <Th col="key" align="left">
                      <span className="flex items-center gap-2">
                        Asset
                        {windowMs != null && (
                          <span className="font-mono normal-case text-[10px] ml-1" style={{color: windowMs<=30000?'var(--nr)':windowMs<=60000?'var(--no)':windowMs<=120000?'var(--ny)':'var(--ng)'}}>
                            ⏱ {fmtCountdown(windowMs)}
                          </span>
                        )}
                      </span>
                    </Th>
                    <th className="text-left">TF</th>
                    <th className="text-right">Poly YES bid/ask</th>
                    <th className="text-right">Lim YES bid/ask</th>
                    {showArb && <Th col="up">UP spread</Th>}
                    {showArb && <Th col="down">DOWN spread</Th>}
                    {showArb && <Th col="arb">Best ARB</Th>}
                    {showSignal && <Th col="ev" color="var(--np)">Signal EV</Th>}
                    {spreadEnabled && <Th col="spread" color="var(--ny)">Spread</Th>}
                    <th className="text-center">Action</th>
                  </>)
                })()}
              </tr>
            </thead>
            <tbody>
              {sortedKeys.map(key => {
                const parts = key.split('-')
                const assetName = parts[0]
                const tf = parts.slice(1).join('-')

                const d = arbState?.assets?.[key]
                const poly = d?.poly
                const lim  = d?.lim
                const opp  = d?.opportunity
                const sig  = d?.signal

                const upSpreadPct  = (lim?.yesBid != null && poly?.yesAsk != null && poly.yesAsk > 0 && lim.yesBid > 0)
                  ? ((lim.yesBid - poly.yesAsk - 0.04) / (poly.yesAsk + (1 - lim.yesBid))) * 100
                  : null
                const downSpreadPct = (poly?.yesBid != null && lim?.yesAsk != null && poly.yesBid > 0 && lim.yesAsk > 0 && lim.yesAsk < 1)
                  ? ((poly.yesBid - lim.yesAsk - 0.04) / ((1 - poly.yesBid) + lim.yesAsk)) * 100
                  : null

                const spreadPctLocal = (() => {
                  const pyA = poly?.yesAsk ?? null
                  const pnA = poly?.noAsk  ?? (poly?.yesBid != null && poly.yesBid > 0 ? 1 - poly.yesBid : null)
                  const lyA = lim?.yesAsk  ?? null
                  const lnA = lim?.noAsk   ?? (lim?.yesBid  != null && lim.yesBid  > 0 ? 1 - lim.yesBid  : null)
                  let yA: number | null, nA: number | null
                  if (spreadPlatform === 'poly')      { yA = pyA; nA = pnA }
                  else if (spreadPlatform === 'lim')  { yA = lyA; nA = lnA }
                  else { // best
                    yA = pyA != null && lyA != null ? Math.min(pyA, lyA) : (pyA ?? lyA)
                    nA = pnA != null && lnA != null ? Math.min(pnA, lnA) : (pnA ?? lnA)
                  }
                  if (yA == null || nA == null || yA <= 0 || nA <= 0) return null
                  const total = yA + nA
                  return ((1 - total - yA * 0.02 - nA * 0.02) / total) * 100
                })()

                const bestPct = (opp?.profitPct ?? null)
                const isHot = (bestPct ?? 0) >= (minProfit ?? 1.5)
                const hasSig = sig != null && sig.evPct >= minProfit
                const assetExpiry = d?.expiresAt
                const assetMs = assetExpiry ? assetExpiry - now : null
                const tooClose = assetMs != null && assetMs < 30_000

                const rowCls = isHot && !tooClose ? 'arb-row-hot' : hasSig && !tooClose ? 'arb-row-sig' : tooClose ? 'arb-row-dim' : ''

                return (
                  <tr key={key} className={rowCls}>
                    <td><span className="font-bold text-white">{assetName}</span></td>
                    <td><span className="font-mono text-[10px]" style={{color:'var(--dim)'}}>{tfLabel(tf)}</span></td>
                    <td className="text-right font-mono text-[11px]">
                      <span style={{color:'var(--ng)'}}>{fmt(poly?.yesBid)}</span>
                      <span style={{color:'var(--bd2)'}}> / </span>
                      <span style={{color:'var(--nr)'}}>{fmt(poly?.yesAsk)}</span>
                    </td>
                    <td className="text-right font-mono text-[11px]">
                      <span style={{color:'var(--ng)'}}>{fmt(lim?.yesBid)}</span>
                      <span style={{color:'var(--bd2)'}}> / </span>
                      <span style={{color:'var(--nr)'}}>{fmt(lim?.yesAsk)}</span>
                    </td>
                    {showArb && <td className="text-right font-mono text-[11px]" style={{color: upSpreadPct!=null&&upSpreadPct>0?'var(--ng)':upSpreadPct!=null&&upSpreadPct<-2?'var(--nr)':'var(--dim)'}}>{upSpreadPct!=null?`${upSpreadPct>=0?'+':''}${upSpreadPct.toFixed(2)}%`:'—'}</td>}
                    {showArb && <td className="text-right font-mono text-[11px]" style={{color: downSpreadPct!=null&&downSpreadPct>0?'var(--ng)':downSpreadPct!=null&&downSpreadPct<-2?'var(--nr)':'var(--dim)'}}>{downSpreadPct!=null?`${downSpreadPct>=0?'+':''}${downSpreadPct.toFixed(2)}%`:'—'}</td>}
                    {showArb && (() => {
                      const p = opp?.profitPct ?? null
                      return (
                        <td className="text-right font-mono text-[11px]" title={opp ? `${opp.direction} @ ${opp.totalCost.toFixed(3)} total cost` : ''}>
                          {p != null
                            ? <span style={{ color: p >= (minProfit??1.5) ? 'var(--ng)' : p > 0 ? 'var(--ny)' : 'var(--dim)', fontWeight: p >= (minProfit??1.5) ? 700 : 400, textShadow: p >= (minProfit??1.5) ? '0 0 6px rgba(0,255,136,0.5)' : 'none' }}>
                                {p >= 0 ? '+' : ''}{p.toFixed(2)}% <span style={{color:'var(--dim)',fontSize:'9px'}}>{opp!.direction}</span>
                              </span>
                            : <span style={{color:'var(--dim)'}}>—</span>}
                        </td>
                      )
                    })()}
                    {showSignal && (
                      <td className="text-right font-mono text-[11px]" style={{color: sig&&sig.evPct>=(minProfit??1.5)?'var(--np)':sig&&sig.evPct>0?'var(--nc)':'var(--dim)'}}>
                        {sig ? <span title={`${sig.direction} on ${sig.exchange.toUpperCase()} | conf ${(sig.confidence*100).toFixed(1)}% | gap ${sig.gapPct.toFixed(1)}%`}>{sig.evPct>=0?'+':''}{sig.evPct.toFixed(1)}% <span style={{color:'var(--dim)',fontSize:'9px'}}>{sig.direction} {sig.exchange.toUpperCase()}</span></span> : '—'}
                      </td>
                    )}
                    {spreadEnabled && (
                      <td className="text-right font-mono text-[11px]">
                        {spreadPctLocal == null
                          ? <span style={{color:'var(--dim)'}}>—</span>
                          : <span
                              title={`Spread P&L after fees | Min: ${spreadMinGapPct}%`}
                              style={{
                                color: spreadPctLocal >= spreadMinGapPct ? 'var(--ny)' : spreadPctLocal >= -10 ? 'rgba(255,230,0,0.35)' : 'var(--dim)',
                                fontWeight: spreadPctLocal >= spreadMinGapPct ? 700 : 400,
                                textShadow: spreadPctLocal >= spreadMinGapPct ? '0 0 6px rgba(255,230,0,0.5)' : 'none',
                              }}>
                              {spreadPctLocal >= 0 ? '+' : ''}{spreadPctLocal.toFixed(1)}%
                            </span>
                        }
                      </td>
                    )}
                    <td className="text-center">
                      {spreadEnabled && !spreadAutoExecute && spreadPctLocal != null ? (
                        <button onClick={()=>fireSpread(key)} className="text-[10px] px-2.5 py-1 rounded font-bold" title={`Enter spread: buy YES+NO simultaneously. ${spreadPctLocal >= 0 ? 'Guaranteed profit at resolution' : 'Directional spread — gain from market movement'} (${spreadPctLocal >= 0 ? '+' : ''}${spreadPctLocal.toFixed(1)}%)`}
                          style={spreadPctLocal >= spreadMinGapPct
                            ? {background:'rgba(255,230,0,0.14)',border:'1px solid rgba(255,230,0,0.5)',color:'var(--ny)',textShadow:'0 0 6px rgba(255,230,0,0.5)'}
                            : {background:'rgba(255,230,0,0.05)',border:'1px solid rgba(255,230,0,0.2)',color:'rgba(255,230,0,0.5)'}}>
                          SPREAD {spreadPctLocal >= 0 ? '+' : ''}{spreadPctLocal.toFixed(1)}%
                        </button>
                      ) : spreadEnabled && spreadAutoExecute && spreadPctLocal != null && spreadPctLocal >= spreadMinGapPct ? (
                        <span className="text-[10px] font-bold neon-y">AUTO SPREAD ✓</span>
                      ) : tooClose && (isHot||hasSig) ? (
                        <span className="font-mono text-[10px]" style={{color:'var(--nr)'}}>⏱ {assetMs!=null?fmtCountdown(assetMs):'—'}</span>
                      ) : isHot && !autoExecute && showArb ? (
                        <button onClick={()=>fireManual(key)} className="text-[10px] px-2.5 py-1 rounded font-bold" style={{background:'rgba(0,255,136,0.12)',border:'1px solid rgba(0,255,136,0.4)',color:'var(--ng)',textShadow:'0 0 6px rgba(0,255,136,0.5)'}}>FIRE {opp?.direction}</button>
                      ) : isHot && showArb ? (
                        <span className="text-[10px] font-bold neon-g">AUTO ✓</span>
                      ) : hasSig && !autoExecute && showSignal ? (
                        <button onClick={()=>fireSignal(key)} className="text-[10px] px-2.5 py-1 rounded font-bold" style={{background:'rgba(191,95,255,0.12)',border:'1px solid rgba(191,95,255,0.4)',color:'var(--np)'}} title={`EV ${sig!.evPct.toFixed(1)}% | ${sig!.direction}`}>SIGNAL {sig!.direction}</button>
                      ) : hasSig && showSignal ? (
                        <span className="text-[10px] font-bold neon-p">AUTO ✓</span>
                      ) : assetMs!=null ? (
                        <span className="text-[10px] font-mono" style={{color: assetMs<=30000?'var(--nr)':assetMs<=60000?'var(--no)':assetMs<=120000?'var(--ny)':'var(--dim)'}}>{fmtCountdown(assetMs)}</span>
                      ) : <span style={{color:'var(--bd2)'}}>—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* ── XTF opportunities banner ── */}
        {arbState?.xtf && arbState.xtf.length > 0 && (
          <div className="shrink-0 px-4 py-2 text-[11px]" style={{background:'rgba(0,153,255,0.04)',borderBottom:'1px solid rgba(0,153,255,0.15)'}}>
            <span className="font-bold tracking-wider mr-3" style={{color:'var(--nb)'}}>XTF</span>
            {arbState.xtf.map((x, i) => (
              <span key={i} className="mr-4" style={{color:'rgba(0,153,255,0.8)'}}>
                {x.asset}: {x.shortKey.split('-')[1]}→{x.longKey.split('-')[1]} {x.shortOutcome}/{x.longOutcome} gap={x.gapPct.toFixed(1)}% EV={x.profitPct.toFixed(1)}%
              </span>
            ))}
          </div>
        )}

        {/* ── XAsset opportunities banner ── */}
        {arbState?.xasset && arbState.xasset.length > 0 && (
          <div className="shrink-0 px-4 py-2 text-[11px]" style={{background:'rgba(191,95,255,0.04)',borderBottom:'1px solid rgba(191,95,255,0.15)'}}>
            <span className="font-bold tracking-wider mr-3" style={{color:'var(--np)'}}>XAsset</span>
            {arbState.xasset.map((x, i) => (
              <span key={i} className="mr-4" style={{color:'rgba(191,95,255,0.8)'}}>
                <span style={{color: x.direction==='UP'?'var(--ng)':'var(--nr)'}}>{x.direction}</span>
                {' '}{x.leaderAsset}({(x.leaderMid*100).toFixed(0)}%)→{x.followerAsset}({(x.followerMid*100).toFixed(0)}%) {x.timeframe} gap={x.gapPct.toFixed(1)}% EV={x.evPct.toFixed(1)}% @{x.exchange}
              </span>
            ))}
          </div>
        )}

        {/* ── Spread opportunities banner ── */}
        {spreadEnabled && arbState?.spread && arbState.spread.length > 0 && (
          <div className="shrink-0 px-4 py-2 text-[11px]" style={{background:'rgba(255,230,0,0.03)',borderBottom:'1px solid rgba(255,230,0,0.15)'}}>
            <span className="font-bold tracking-wider mr-3" style={{color:'var(--ny)'}}>SPREAD</span>
            {arbState.spread.map((s, i) => (
              <span key={i} className="mr-3 inline-flex items-center gap-1">
                <span style={{color:'var(--ny)',fontWeight:700}}>{s.asset}</span>
                <span style={{color:'var(--dim)'}}>{s.timeframe}</span>
                <span style={{color:'var(--ng)'}}>YES</span>
                <span style={{color:'var(--dim)'}}>@{s.yesPlatform}</span>
                <span style={{color:'rgba(255,230,0,0.8)'}}>{(s.yesAsk*100).toFixed(0)}¢</span>
                <span style={{color:'var(--dim)'}}>+</span>
                <span style={{color:'var(--nr)'}}>NO</span>
                <span style={{color:'var(--dim)'}}>@{s.noPlatform}</span>
                <span style={{color:'rgba(255,230,0,0.8)'}}>{(s.noAsk*100).toFixed(0)}¢</span>
                <span style={{color:'var(--dim)'}}>=</span>
                <span style={{color:'rgba(255,230,0,0.7)'}}>{(s.totalCost*100).toFixed(0)}¢</span>
                <span className="font-bold neon-y">+{s.spreadPct.toFixed(1)}%</span>
                <span style={{color:'var(--dim)'}}>{s.secsToExpiry}s</span>
              </span>
            ))}
          </div>
        )}
        </>
        )}

        {/* ── Copy Trading: leaderboard widget grid + followed traders + signal feed ── */}
        {copyTradeEnabled && (
          <div className="flex flex-1 overflow-hidden min-h-0">

            {/* Leaderboard — card grid, the main widget */}
            <div className="flex-1 flex flex-col overflow-hidden" style={{borderRight:'1px solid var(--bd)'}}>
              {/* Title bar */}
              <div className="ph shrink-0">
                <div className="flex items-center gap-2">
                  <span className="wlabel">Leaderboard</span>
                  <span className="text-[10px]" style={{color:'var(--dim)'}}>
                    {filteredLeaderboard.length !== leaderboard.length ? `${filteredLeaderboard.length}/${leaderboard.length}` : leaderboard.length} traders · click card for stats
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center p-0.5 gap-0.5" style={{background:'rgba(15,28,56,0.8)',border:'1px solid var(--bd2)',borderRadius:3}}>
                    {(['day', 'week', 'month'] as const).map(w => (
                      <button
                        key={w}
                        onClick={() => { setLeaderboardWindow(w); loadLeaderboard(w) }}
                        className="text-[10px] px-2.5 py-1 font-semibold uppercase transition-all"
                        style={leaderboardWindow === w
                          ? {background:'rgba(0,212,255,0.15)',color:'var(--nc)',border:'1px solid rgba(0,212,255,0.3)',borderRadius:2,textShadow:'0 0 6px rgba(0,212,255,0.6)'}
                          : {color:'var(--dim)',border:'1px solid transparent',borderRadius:2}}
                      >{w}</button>
                    ))}
                  </div>
                  <button onClick={() => loadLeaderboard()} title="Refresh" className="btn-dim text-xs w-7 h-7 flex items-center justify-center" style={{borderRadius:3}}>↻</button>
                </div>
              </div>

              {/* Quick-glance summary chips */}
              {leaderboard.length > 0 && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 shrink-0 font-mono text-[10px] flex-wrap" style={{borderBottom:'1px solid var(--bd)',background:'rgba(4,7,16,0.5)'}}>
                  <span className="px-2 py-0.5" style={{background:'rgba(15,28,56,0.7)',border:'1px solid var(--bd2)',borderRadius:2,color:'var(--dim)'}}>Top PnL <span className="neon-g font-bold">${leaderboard[0]?.pnl.toFixed(0)}</span></span>
                  <span className="px-2 py-0.5" style={{background:'rgba(15,28,56,0.7)',border:'1px solid var(--bd2)',borderRadius:2,color:'var(--dim)'}}>Vol <span style={{color:'var(--txt)'}} className="font-bold">${leaderboard.reduce((s, e) => s + e.vol, 0).toFixed(0)}</span></span>
                  <span className="px-2 py-0.5" style={{background:'rgba(15,28,56,0.7)',border:'1px solid var(--bd2)',borderRadius:2,color:'var(--dim)'}}>Verified <span className="neon-c font-bold">{leaderboard.filter(e => e.verifiedBadge).length}</span></span>
                  <span className="px-2 py-0.5" style={{background:'rgba(15,28,56,0.7)',border:'1px solid var(--bd2)',borderRadius:2,color:'var(--dim)'}}>Following <span className="neon-g font-bold">{followedWallets.length}</span></span>
                  {Object.keys(leaderboardStats).length > 0 && (
                    <span className="px-2 py-0.5" style={{background:'rgba(15,28,56,0.7)',border:'1px solid var(--bd2)',borderRadius:2,color:'var(--dim)'}}>Stats <span style={{color:'var(--txt)'}} className="font-bold">{Object.keys(leaderboardStats).length}/{leaderboard.length}</span></span>
                  )}
                  {windowStatsReady[leaderboardWindow] === false && (
                    <span className="px-2 py-0.5 npulse" style={{background:'rgba(191,95,255,0.08)',border:'1px solid rgba(191,95,255,0.3)',borderRadius:2,color:'var(--np)'}}>Computing {leaderboardWindow}…</span>
                  )}
                  {windowStatsReady[leaderboardWindow] === true && leaderboard.some(e => e.windowVol != null) && (
                    <span className="px-2 py-0.5" style={{background:'rgba(0,255,136,0.06)',border:'1px solid rgba(0,255,136,0.25)',borderRadius:2,color:'var(--dim)'}}>
                      {leaderboardWindow} <span className="neon-g font-bold">ready</span>
                    </span>
                  )}
                </div>
              )}

              {/* Filter + sort toolbar */}
              {leaderboard.length > 0 && (
                <div className="shrink-0 px-3 py-2 space-y-1.5" style={{borderBottom:'1px solid var(--bd)',background:'rgba(4,7,16,0.4)'}}>
                  {/* Sort row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="wlabel w-8 shrink-0">Sort</span>
                    <div className="flex items-center gap-0.5 flex-wrap">
                      {([
                        { key: 'pnl',           label: 'PnL' },
                        { key: 'vol',           label: 'Vol' },
                        { key: 'winRate',       label: 'Win%' },
                        { key: 'positions',     label: 'Pos' },
                        { key: 'avgSize',       label: 'AvgSz' },
                        { key: 'windowVol',     label: `${leaderboardWindow[0].toUpperCase()}Vol` },
                        { key: 'windowNetFlow', label: `${leaderboardWindow[0].toUpperCase()}Net` },
                        { key: 'windowTrades',  label: `${leaderboardWindow[0].toUpperCase()}Tx` },
                      ] as const).map(opt => (
                        <button
                          key={opt.key}
                          onClick={() => {
                            if (lbSortBy === opt.key) setLbSortDir(d => d === 'desc' ? 'asc' : 'desc')
                            else { setLbSortBy(opt.key); setLbSortDir('desc') }
                          }}
                          className="text-[10px] px-2 py-0.5 font-semibold transition-all flex items-center gap-0.5"
                          style={lbSortBy === opt.key
                            ? {background:'rgba(0,212,255,0.12)',border:'1px solid rgba(0,212,255,0.4)',color:'var(--nc)',borderRadius:2,textShadow:'0 0 5px rgba(0,212,255,0.5)'}
                            : {background:'rgba(15,28,56,0.6)',border:'1px solid var(--bd2)',color:'var(--dim)',borderRadius:2}}
                        >
                          {opt.label}{lbSortBy === opt.key && <span>{lbSortDir === 'desc' ? '↓' : '↑'}</span>}
                        </button>
                      ))}
                    </div>
                    <label className="flex items-center gap-1 cursor-pointer text-[10px]" style={{color:'var(--dim)'}}>
                      <input type="checkbox" checked={lbFilterVerifiedOnly} onChange={e => setLbFilterVerifiedOnly(e.target.checked)} />
                      Verified
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer text-[10px]" style={{color:'var(--dim)'}}>
                      <input type="checkbox" checked={lbFilterFollowedOnly} onChange={e => setLbFilterFollowedOnly(e.target.checked)} />
                      Following
                    </label>
                  </div>
                  {/* Filter row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="wlabel w-8 shrink-0">Filter</span>
                    {[
                      { label: 'Min PnL$',    value: lbFilterMinPnl,       set: setLbFilterMinPnl,       placeholder: '0',   hint: '' },
                      { label: 'Min Vol$',    value: lbFilterMinVol,       set: setLbFilterMinVol,       placeholder: '0',   hint: '' },
                      { label: 'Win%≥',       value: lbFilterMinWinRate,   set: setLbFilterMinWinRate,   placeholder: '50',  hint: '⚠ load stats' },
                      { label: 'Pos≥',        value: lbFilterMinPositions, set: setLbFilterMinPositions, placeholder: '10',  hint: '⚠ load stats' },
                      { label: 'AvgSz≤$',     value: lbFilterMaxAvgSize,   set: setLbFilterMaxAvgSize,   placeholder: '500', hint: '⚠ load stats' },
                    ].map(f => (
                      <div key={f.label} className="flex items-center gap-1 relative">
                        <span className="text-[9px] font-semibold whitespace-nowrap uppercase" style={{color:'var(--dim)'}}>{f.label}</span>
                        <input
                          type="number"
                          value={f.value}
                          onChange={e => f.set(e.target.value)}
                          placeholder={f.placeholder}
                          className="w-14 px-1.5 py-0.5 text-[10px] font-mono"
                          style={{borderRadius:2}}
                        />
                        {f.hint && f.value !== '' && Object.keys(leaderboardStats).length < leaderboard.length && (
                          <span className="absolute -top-5 left-0 text-[9px] whitespace-nowrap pointer-events-none" style={{color:'var(--no)'}}>{f.hint}</span>
                        )}
                      </div>
                    ))}
                    <button
                      onClick={() => loadAllStats(leaderboard)}
                      disabled={lbBulkStatsLoading}
                      title="Pre-fetch stats for all traders"
                      className="btn-dim text-[10px] px-2.5 py-0.5 font-semibold disabled:opacity-50 disabled:cursor-wait"
                      style={{borderRadius:2}}
                    >
                      {lbBulkStatsLoading ? 'Loading…' : `Load stats (${Object.keys(leaderboardStats).length}/${leaderboard.length})`}
                    </button>
                    {(lbFilterMinPnl || lbFilterMinVol || lbFilterMinWinRate || lbFilterMinPositions || lbFilterMaxAvgSize || lbFilterVerifiedOnly || lbFilterFollowedOnly) && (
                      <button
                        onClick={() => { setLbFilterMinPnl(''); setLbFilterMinVol(''); setLbFilterMinWinRate(''); setLbFilterMinPositions(''); setLbFilterMaxAvgSize(''); setLbFilterVerifiedOnly(false); setLbFilterFollowedOnly(false) }}
                        className="btn-nr text-[10px] px-2 py-0.5 font-semibold"
                        style={{borderRadius:2}}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-3">
                {leaderboardLoading && leaderboard.length === 0 ? (
                  <p className="text-xs text-center pt-8" style={{color:'var(--dim)'}}>Loading leaderboard…</p>
                ) : leaderboard.length === 0 ? (
                  <p className="text-xs text-center pt-8" style={{color:'var(--dim)'}}>No leaderboard data — try refreshing</p>
                ) : filteredLeaderboard.length === 0 ? (
                  <p className="text-xs text-center pt-8" style={{color:'var(--dim)'}}>No traders match the current filters</p>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-2">
                    {filteredLeaderboard.map(entry => {
                      const isFollowed = followedWallets.includes(entry.proxyWallet)
                      const isExpanded = expandedWallet === entry.proxyWallet
                      const stats = leaderboardStats[entry.proxyWallet]
                      const rankCls = entry.rank === 1 ? 'rank-1' : entry.rank === 2 ? 'rank-2' : entry.rank === 3 ? 'rank-3' : 'rank-n'
                      return (
                        <div key={entry.proxyWallet} className={`trader-card${isExpanded?' expanded':''}${isFollowed?' followed':''}`}>
                          <div className="flex items-center gap-2 px-3 py-2.5 cursor-pointer" onClick={() => toggleTraderStats(entry.proxyWallet)}>
                            <span className={`flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold shrink-0 ${rankCls}`}>{entry.rank}</span>
                            {entry.profileImage ? (
                              <img src={entry.profileImage} alt="" className="w-8 h-8 rounded-full shrink-0 object-cover" style={{border:'1px solid var(--bd2)'}} />
                            ) : (
                              <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-xs font-bold" style={{background:'var(--bg2)',border:'1px solid var(--bd2)',color:'var(--dim)'}}>
                                {(entry.userName || entry.proxyWallet).charAt(0).toUpperCase()}
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-semibold truncate" style={{color:'var(--txt)'}}>{entry.userName || shortWallet(entry.proxyWallet)}</span>
                                {entry.verifiedBadge && <span className="neon-c text-[10px]" title="Verified">✓</span>}
                              </div>
                              <div className="flex items-center gap-1 mt-1 flex-wrap">
                                <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold" style={entry.pnl >= 0 ? {background:'rgba(0,255,136,0.08)',border:'1px solid rgba(0,255,136,0.25)',color:'var(--ng)',borderRadius:2} : {background:'rgba(255,51,102,0.08)',border:'1px solid rgba(255,51,102,0.25)',color:'var(--nr)',borderRadius:2}}>
                                  PnL ${entry.pnl.toFixed(0)}
                                </span>
                                <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold" style={{background:'rgba(15,28,56,0.7)',border:'1px solid var(--bd2)',color:'var(--dim)',borderRadius:2}}>
                                  Vol ${entry.vol.toFixed(0)}
                                </span>
                                {entry.windowVol != null && (
                                  <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold" title={`Volume in past ${leaderboardWindow}`} style={{background:'rgba(191,95,255,0.08)',border:'1px solid rgba(191,95,255,0.3)',color:'var(--np)',borderRadius:2}}>
                                    {leaderboardWindow[0].toUpperCase()}V ${entry.windowVol.toFixed(0)}
                                  </span>
                                )}
                                {entry.windowTradeCount != null && entry.windowTradeCount > 0 && (
                                  <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold" title={`Trades in past ${leaderboardWindow}`} style={{background:'rgba(15,28,56,0.6)',border:'1px solid var(--bd)',color:'var(--dim)',borderRadius:2}}>
                                    {entry.windowTradeCount}tx
                                  </span>
                                )}
                                {entry.windowNetFlow != null && (
                                  <span className="px-1.5 py-0.5 text-[10px] font-mono font-semibold" title={`Net flow in past ${leaderboardWindow}`} style={entry.windowNetFlow >= 0 ? {background:'rgba(0,255,136,0.06)',border:'1px solid rgba(0,255,136,0.2)',color:'var(--ng)',borderRadius:2} : {background:'rgba(255,51,102,0.06)',border:'1px solid rgba(255,51,102,0.2)',color:'var(--nr)',borderRadius:2}}>
                                    {entry.windowNetFlow >= 0 ? '+' : ''}${entry.windowNetFlow.toFixed(0)}
                                  </span>
                                )}
                              </div>
                            </div>
                            <button
                              onClick={e => { e.stopPropagation(); isFollowed ? unfollowTrader(entry.proxyWallet) : followTrader(entry) }}
                              className={`text-[10px] px-2.5 py-1 font-bold transition-all shrink-0 ${isFollowed ? 'btn-nr' : 'btn-ng'}`}
                              style={{borderRadius:2}}
                            >
                              {isFollowed ? 'Unfollow' : '+Follow'}
                            </button>
                          </div>
                          {isExpanded && (
                            <div className="px-3 pb-3 pt-2" style={{borderTop:'1px solid var(--bd)',background:'rgba(4,7,16,0.5)'}}>
                              {leaderboardStatsLoading[entry.proxyWallet] ? (
                                <p className="text-[11px]" style={{color:'var(--dim)'}}>Loading stats…</p>
                              ) : stats ? (
                                <TraderStatsGrid stats={stats} />
                              ) : (
                                <p className="text-[11px]" style={{color:'var(--dim)'}}>No stats available</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Sidebar: following + signal feed widgets */}
            <div className="w-[23rem] shrink-0 flex flex-col overflow-hidden">

              {/* Following widget */}
              <div className="shrink-0 max-h-[45%] flex flex-col overflow-hidden" style={{borderBottom:'1px solid var(--bd)'}}>
                <div className="ph shrink-0">
                  <span className="wlabel">Following</span>
                  <span className="text-[10px] font-mono" style={{color:'var(--dim)'}}>{followedWallets.length}</span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                  {followedWallets.length === 0 ? (
                    <p className="text-[11px] text-center px-2 py-4" style={{color:'var(--dim)'}}>Follow traders from the leaderboard to mirror their trades</p>
                  ) : (
                    followedWallets.map(wallet => {
                      const stats = copyTradeData.stats[wallet]
                      const entry = leaderboard.find(e => e.proxyWallet === wallet)
                      return (
                        <div key={wallet} className="trader-card followed px-2.5 py-2">
                          <div className="flex items-center justify-between mb-1 gap-2">
                            <span className="text-xs font-semibold truncate" style={{color:'var(--txt)'}}>{entry?.userName || shortWallet(wallet)}</span>
                            <button onClick={() => unfollowTrader(wallet)} title="Unfollow" className="btn-nr text-[10px] w-5 h-5 flex items-center justify-center shrink-0" style={{borderRadius:2}}>✗</button>
                          </div>
                          {stats ? <TraderStatsGrid stats={stats} /> : <p className="text-[10px]" style={{color:'var(--dim)'}}>Stats syncing…</p>}
                        </div>
                      )
                    })
                  )}
                </div>
              </div>

              {/* Signal feed widget */}
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="ph shrink-0">
                  <span className="wlabel">Signal Feed</span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                  {copyTradeData.signals.length === 0 ? (
                    <p className="text-[11px] text-center px-2 py-4" style={{color:'var(--dim)'}}>No signals yet — follow traders to mirror their BUY/SELL activity in real time</p>
                  ) : (
                    copyTradeData.signals.map(sig => (
                      <div key={sig.id} className={`rounded p-2 text-xs ${sig.status === 'executed' ? 'sig-executed' : sig.status === 'failed' ? 'sig-failed' : sig.status === 'detected' ? 'sig-detected' : 'sig-skipped'}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold truncate" style={{color:'var(--txt)'}}>{sig.traderName || shortWallet(sig.wallet)}</span>
                          <span className="px-1.5 py-0.5 text-[10px] font-bold shrink-0" style={sig.side === 'BUY' ? {background:'rgba(0,153,255,0.12)',border:'1px solid rgba(0,153,255,0.3)',color:'var(--nb)',borderRadius:2} : {background:'rgba(255,153,0,0.1)',border:'1px solid rgba(255,153,0,0.3)',color:'var(--no)',borderRadius:2}}>{sig.side}</span>
                        </div>
                        <p className="truncate mt-0.5" style={{color:'var(--dim)'}} title={sig.title}>{sig.title}</p>
                        <div className="flex items-center justify-between mt-1.5 font-mono text-[10px]" style={{color:'var(--dim)'}}>
                          <span>{fmtAgo(sig.ts, now)}</span>
                          <span>{sig.size.toFixed(0)} @ {sig.price.toFixed(2)}</span>
                          <span style={sig.status === 'executed' ? {color:'var(--ng)'} : sig.status === 'failed' ? {color:'var(--nr)'} : sig.status === 'detected' ? {color:'var(--ny)'} : {color:'var(--dim)'}}>
                            {sig.status}{sig.copiedSize ? ` $${sig.copiedSize.toFixed(0)}` : ''}{sig.error ? ` — ${sig.error.slice(0, 28)}` : ''}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Bottom split: positions left, log right ── */}
        <div className="flex flex-1 overflow-hidden min-h-0" style={{borderTop:'1px solid var(--bd)'}}>

          {/* Left panel: Positions / History tabs — 75% width */}
          <div className="flex flex-col overflow-hidden" style={{flex:'3 1 0%', minWidth:0, borderRight:'1px solid var(--bd)'}}>
            {/* Tab header */}
            <div className="flex shrink-0" style={{borderBottom:'1px solid var(--bd)',background:'var(--bg1)'}}>
              <button
                onClick={() => setLeftTab('positions')}
                className="flex-1 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide transition-all"
                style={leftTab === 'positions'
                  ? {color:'var(--nc)',borderBottom:'2px solid var(--nc)',background:'rgba(0,212,255,0.05)'}
                  : {color:'var(--dim)',borderBottom:'2px solid transparent'}}
              >
                Positions {openPositions.length > 0 && <span className="ml-1 font-mono">{openPositions.length}</span>}
              </button>
              <button
                onClick={() => setLeftTab('history')}
                className="flex-1 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide transition-all"
                style={leftTab === 'history'
                  ? {color:'var(--nc)',borderBottom:'2px solid var(--nc)',background:'rgba(0,212,255,0.05)'}
                  : {color:'var(--dim)',borderBottom:'2px solid transparent'}}
              >
                History {tradeHistory.length > 0 && <span className="ml-1 font-mono">{tradeHistory.length}</span>}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {leftTab === 'positions' ? (
                <>
                  {openPositions.length === 0 ? (
                    <p className="text-xs text-center pt-4" style={{color:'var(--dim)'}}>No open positions</p>
                  ) : (
                    openPositions.map(pos => {
                      const canClose = pos.exitPnLPct != null && pos.exitPnLPct >= (minProfit ?? 1.5)
                      const exitStyle = pos.exitPnLPct == null ? {color:'var(--dim)'}
                        : pos.exitPnLPct >= (minProfit ?? 1.5) ? {color:'var(--ng)',fontWeight:700,textShadow:'0 0 6px rgba(0,255,136,0.5)'}
                        : pos.exitPnLPct >= 0 ? {color:'var(--ny)'}
                        : {color:'var(--nr)'}
                      return (
                        <div key={pos.tradeId} className="rounded p-2.5 text-xs" style={canClose ? {background:'rgba(0,255,136,0.06)',border:'1px solid rgba(0,255,136,0.25)'} : {background:'var(--bg2)',border:'1px solid var(--bd)'}}>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="font-bold" style={{color:'var(--txt)'}}>
                              {pos.asset}
                              {pos.timeframe && <span className="font-normal ml-1 text-[10px]" style={{color:'var(--dim)'}}>{pos.timeframe}</span>}
                            </span>
                            <span className="px-1.5 py-0.5 text-[10px] font-bold" style={
                              pos.type==='spread' ? {background:'rgba(255,230,0,0.12)',border:'1px solid rgba(255,230,0,0.3)',color:'var(--ny)',borderRadius:2}
                              : pos.type==='xtf' ? {background:'rgba(0,153,255,0.12)',border:'1px solid rgba(0,153,255,0.3)',color:'var(--nb)',borderRadius:2}
                              : pos.type==='xasset' ? {background:'rgba(191,95,255,0.12)',border:'1px solid rgba(191,95,255,0.3)',color:'var(--np)',borderRadius:2}
                              : pos.type==='buzzer' ? {background:'rgba(255,153,0,0.12)',border:'1px solid rgba(255,153,0,0.3)',color:'var(--no)',borderRadius:2}
                              : pos.direction==='UP' ? {background:'rgba(0,255,136,0.1)',border:'1px solid rgba(0,255,136,0.3)',color:'var(--ng)',borderRadius:2}
                              : {background:'rgba(255,51,102,0.1)',border:'1px solid rgba(255,51,102,0.3)',color:'var(--nr)',borderRadius:2}
                            }>
                              {pos.type==='spread' ? 'SPR' : pos.type==='xtf' ? 'XTF' : pos.type==='xasset' ? 'XA' : pos.type==='buzzer' ? pos.direction+' BUZZ' : pos.direction+' '+(pos.type==='signal'?'SIG':'ARB')}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[11px]">
                            <span style={{color:'var(--dim)'}}>Size</span>
                            <span className="text-right" style={{color:'var(--txt)'}}>${pos.positionSize.toFixed(2)}</span>
                            {pos.type==='spread' && (<>
                              <span style={{color:'var(--dim)'}}>YES leg</span>
                              <span className="text-right" style={{color:'var(--ny)'}}>{pos.spreadYesPlatform ? (pos.spreadYesPlatform === 'poly' ? 'POLY' : 'LIM') : '—'}</span>
                              <span style={{color:'var(--dim)'}}>NO leg</span>
                              <span className="text-right" style={{color:'var(--ny)'}}>{pos.spreadNoPlatform ? (pos.spreadNoPlatform === 'poly' ? 'POLY' : 'LIM') : '—'}</span>
                            </>)}
                            {pos.type==='xtf' && pos.xtfShortKey && pos.xtfLongKey && (<>
                              <span style={{color:'var(--dim)'}}>Short</span>
                              <span className="text-right" style={{color:'var(--nb)'}}>{pos.xtfShortKey.split('-')[1]} {pos.xtfShortOutcome?.toUpperCase()}</span>
                              <span style={{color:'var(--dim)'}}>Long</span>
                              <span className="text-right" style={{color:'var(--nb)'}}>{pos.xtfLongKey.split('-')[1]} {pos.xtfLongOutcome?.toUpperCase()}</span>
                            </>)}
                            <span style={{color:'var(--dim)'}}>Entry EV</span>
                            <span className="text-right neon-y">+{pos.projectedProfitPct.toFixed(2)}%</span>
                            <span style={{color:'var(--dim)'}}>Exit now</span>
                            <span className="text-right" style={exitStyle}>
                              {pos.exitPnLPct != null ? `${pos.exitPnLPct>=0?'+':''}${pos.exitPnLPct.toFixed(2)}%` : '—'}
                            </span>
                            <span style={{color:'var(--dim)'}}>Expires</span>
                            <span className="text-right font-mono" style={pos.expiresIn<30?{color:'var(--nr)'}:pos.expiresIn<60?{color:'var(--no)'}:{color:'var(--dim)'}}>
                              {pos.expiresIn>0 ? `${Math.floor(pos.expiresIn/60)}:${String(pos.expiresIn%60).padStart(2,'0')}` : 'expired'}
                            </span>
                          </div>
                          <div className="mt-2 flex gap-1">
                            {canClose ? (
                              <button onClick={() => closeEarly(pos.tradeId)} className="btn-ng flex-1 text-[11px] py-1 font-bold" style={{borderRadius:2}}>
                                CLOSE +{pos.exitPnLPct!.toFixed(2)}%
                              </button>
                            ) : (
                              <button onClick={() => closeEarly(pos.tradeId)} className="btn-nr flex-1 text-[11px] py-1 font-bold" style={{borderRadius:2}} title="Force close">
                                FORCE CLOSE
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })
                  )}
                </>
              ) : (
                /* History tab */
                <>
                  {dashboard?.stats && (
                    <div className="flex gap-3 pb-2 mb-1" style={{borderBottom:'1px solid var(--bd)'}}>
                      <div className="flex-1 text-center">
                        <div className="text-[10px] wlabel">Trades</div>
                        <div className="text-xs font-mono" style={{color:'var(--txt)'}}>{dashboard.stats.totalTrades}</div>
                      </div>
                      <div className="flex-1 text-center">
                        <div className="text-[10px] wlabel">Win rate</div>
                        <div className="text-xs font-mono" style={{color:'var(--txt)'}}>{dashboard.stats.winRate}%</div>
                      </div>
                      <div className="flex-1 text-center">
                        <div className="text-[10px] wlabel">P&amp;L</div>
                        <div className="text-xs font-mono" style={(dashboard.stats.totalPnl??0)>=0?{color:'var(--ng)'}:{color:'var(--nr)'}}>
                          ${dashboard.stats.totalPnl?.toFixed(2) ?? '0.00'}
                        </div>
                      </div>
                    </div>
                  )}
                  {tradeHistory.length === 0 ? (
                    <p className="text-xs text-center pt-4" style={{color:'var(--dim)'}}>No trade history</p>
                  ) : (
                    tradeHistory.map(t => {
                      const typeLabel = t.type==='xtf'?'XTF':t.type==='xasset'?'XA':t.type==='buzzer'?'BUZZ':t.type==='signal'?'SIG':t.type==='spread'?'SPR':'ARB'
                      const timeStr = new Date(t.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })
                      const tfLabel = (t as TradeRecord & { timeframe?: string }).timeframe ?? ''
                      return (
                        <div key={t.id} className="rounded p-2 text-xs" style={t.success ? {background:'var(--bg2)',border:'1px solid var(--bd)'} : {background:'rgba(255,51,102,0.04)',border:'1px solid rgba(255,51,102,0.2)'}}>
                          <div className="flex items-center justify-between">
                            <span className="font-bold" style={{color:'var(--txt)'}}>
                              {t.asset}
                              {tfLabel && <span className="font-normal ml-1 text-[10px]" style={{color:'var(--dim)'}}>{tfLabel}</span>}
                            </span>
                            <div className="flex items-center gap-1">
                              <span className="px-1 py-0.5 text-[10px] font-bold" style={
                                t.type==='spread'?{background:'rgba(255,230,0,0.12)',border:'1px solid rgba(255,230,0,0.3)',color:'var(--ny)',borderRadius:2}
                                :t.type==='xtf'?{background:'rgba(0,153,255,0.12)',border:'1px solid rgba(0,153,255,0.3)',color:'var(--nb)',borderRadius:2}
                                :t.type==='xasset'?{background:'rgba(191,95,255,0.12)',border:'1px solid rgba(191,95,255,0.3)',color:'var(--np)',borderRadius:2}
                                :t.type==='buzzer'?{background:'rgba(255,153,0,0.12)',border:'1px solid rgba(255,153,0,0.3)',color:'var(--no)',borderRadius:2}
                                :t.direction==='UP'?{background:'rgba(0,255,136,0.1)',border:'1px solid rgba(0,255,136,0.25)',color:'var(--ng)',borderRadius:2}
                                :{background:'rgba(255,51,102,0.1)',border:'1px solid rgba(255,51,102,0.25)',color:'var(--nr)',borderRadius:2}
                              }>
                                {t.type==='spread' ? typeLabel : `${t.direction} ${typeLabel}`}
                              </span>
                              <span className="text-[10px] font-bold" style={t.success?{color:'var(--ng)'}:{color:'var(--nr)'}}>{t.success?'✓':'✗'}</span>
                            </div>
                          </div>
                          <div className="flex items-center justify-between mt-1 font-mono text-[10px]">
                            <span style={{color:'var(--dim)'}}>{timeStr}</span>
                            <span style={{color:'var(--txt)'}}>${t.positionSize.toFixed(2)}</span>
                            <span style={t.success?{color:'var(--ng)'}:{color:'var(--dim)'}}>
                              {t.success ? `+${t.profitPct.toFixed(2)}%` : (t.error ? t.error.slice(0,20) : 'failed')}
                            </span>
                          </div>
                        </div>
                      )
                    })
                  )}
                </>
              )}
            </div>
          </div>

          {/* Live log — 25% width */}
          <div className="flex flex-col overflow-hidden" style={{flex:'1 1 0%', minWidth:0}}>
            <div className="ph shrink-0">
              <span className="wlabel">Live Log</span>
            </div>
            <div ref={logRef} className="flex-1 overflow-y-auto p-2 space-y-0">
              {logs.length === 0 ? (
                <p className="text-center pt-4" style={{color:'var(--dim)',fontSize:11}}>No log entries yet</p>
              ) : (
                logs.map((entry, i) => (
                  <div key={i} className={`log-line${entry.level==='error'?' log-error':entry.level==='warn'?' log-warn':''}`}>
                    <span className="log-ts">{new Date(entry.ts).toLocaleTimeString()}</span>
                    <span className="log-tag">{entry.tag}</span>
                    <span className="log-msg">{entry.msg}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
