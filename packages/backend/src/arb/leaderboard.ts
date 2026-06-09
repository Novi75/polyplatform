/**
 * Leaderboard Copy-Trading — fully independent of the crypto/sports pipelines.
 *
 * Pulls Polymarket's public leaderboard (top traders by PnL), lets the user
 * "follow" specific wallets, polls those wallets' recent trade activity, and
 * (optionally) replicates their BUY entries on our own Polymarket account.
 *
 * Also derives per-trader performance statistics from their position history
 * so the dashboard can visualize who's actually worth following.
 */
import { log } from '../logger.js'

const DATA_API = 'https://data-api.polymarket.com'

const DATA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://polymarket.com',
  'Referer': 'https://polymarket.com/',
}

export type LeaderboardWindow = 'day' | 'week' | 'month'

export interface LeaderboardEntry {
  rank: number
  proxyWallet: string
  userName: string
  xUsername: string | null
  verifiedBadge: boolean
  vol: number       // all-time volume from the Polymarket snapshot
  pnl: number       // all-time PnL from the Polymarket snapshot
  profileImage: string | null
  windowVol?: number         // volume traded within the selected window (computed from trades)
  windowTradeCount?: number  // number of trades within the selected window
  windowNetFlow?: number     // sell proceeds minus buy cost in window (≈ realised cash flow)
  windowRank?: number        // re-rank position for the selected window (by windowVol desc)
}

export const WINDOW_SECONDS: Record<LeaderboardWindow, number> = {
  day:   86_400,
  week:  604_800,
  month: 2_592_000,
}

export interface TraderTrade {
  proxyWallet: string
  side: 'BUY' | 'SELL'
  asset: string        // CLOB token id
  conditionId: string
  size: number
  price: number
  timestamp: number    // unix seconds
  title: string
  slug: string
  icon: string | null
}

export interface TraderPosition {
  asset: string
  conditionId: string
  title: string
  outcome: string
  size: number
  avgPrice: number
  curPrice: number
  initialValue: number
  currentValue: number
  cashPnl: number
  percentPnl: number
  totalBought: number
  realizedPnl: number
  percentRealizedPnl: number
  redeemable: boolean
  endDate: string | null
}

export interface TraderStats {
  wallet: string
  totalPositions: number
  winningPositions: number
  winRate: number          // % of positions currently/finally in profit (cashPnl > 0)
  totalPnl: number         // sum of cashPnl (realized + unrealized) across all positions
  totalRealizedPnl: number
  totalVolume: number      // sum of totalBought — cumulative $ deployed
  avgPositionSize: number
  bestTrade: { title: string; pnl: number } | null
  worstTrade: { title: string; pnl: number } | null
  updatedAt: number
}

export interface CopyTradeSignal {
  id: string
  wallet: string
  traderName: string
  ts: number              // ms epoch when we detected the trade
  side: 'BUY' | 'SELL'
  asset: string
  conditionId: string
  title: string
  size: number
  price: number
  status: 'detected' | 'executed' | 'failed' | 'skipped'
  error?: string
  copiedSize?: number     // USD amount we spent replicating it
}

async function dataApiGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params)
  const url = `${DATA_API}${path}?${qs}`
  const resp = await fetch(url, { headers: DATA_HEADERS })
  if (!resp.ok) throw new Error(`Polymarket data-api ${path} ${resp.status}`)
  return (await resp.json()) as T
}

export async function fetchLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  // Polymarket's public API returns the same all-time snapshot regardless of any `window`
  // param — windowed stats must be computed separately via fetchLeaderboardWindowStats.
  const raw = await dataApiGet<Array<Record<string, unknown>>>('/v1/leaderboard', { limit: String(limit) })
  return raw.map((e, i) => ({
    rank: typeof e.rank === 'number' ? e.rank : i + 1,
    proxyWallet: String(e.proxyWallet ?? ''),
    userName: String(e.userName ?? e.proxyWallet ?? 'unknown'),
    xUsername: typeof e.xUsername === 'string' ? e.xUsername : null,
    verifiedBadge: e.verifiedBadge === true,
    vol: typeof e.vol === 'number' ? e.vol : Number(e.vol ?? 0),
    pnl: typeof e.pnl === 'number' ? e.pnl : Number(e.pnl ?? 0),
    profileImage: typeof e.profileImage === 'string' ? e.profileImage : null,
  })).filter(e => e.proxyWallet)
}

/**
 * Enriches a leaderboard with per-window trade stats computed from each trader's
 * recent trade history. Fetches traders sequentially to avoid rate-limiting.
 * Returns entries re-ranked by windowVol descending for the given window.
 */
export async function fetchLeaderboardWindowStats(
  entries: LeaderboardEntry[],
  window: LeaderboardWindow,
): Promise<LeaderboardEntry[]> {
  const cutoff = Math.floor(Date.now() / 1000) - WINDOW_SECONDS[window]
  const tradeLimit = window === 'month' ? 200 : window === 'week' ? 100 : 50

  const enriched: LeaderboardEntry[] = []
  for (const entry of entries) {
    try {
      const trades = await fetchTraderTrades(entry.proxyWallet, tradeLimit)
      const inWindow = trades.filter(t => t.timestamp >= cutoff)
      const windowVol = inWindow.reduce((s, t) => s + t.size * t.price, 0)
      const windowNetFlow = inWindow.reduce((s, t) =>
        t.side === 'SELL' ? s + t.size * t.price : s - t.size * t.price, 0)
      enriched.push({ ...entry, windowVol, windowTradeCount: inWindow.length, windowNetFlow })
    } catch {
      enriched.push({ ...entry, windowVol: 0, windowTradeCount: 0, windowNetFlow: 0 })
    }
    // small delay to avoid hammering the data-api
    await new Promise(r => setTimeout(r, 120))
  }

  // Re-rank by window volume descending and attach windowRank
  enriched.sort((a, b) => (b.windowVol ?? 0) - (a.windowVol ?? 0))
  return enriched.map((e, i) => ({ ...e, windowRank: i + 1 }))
}

export async function fetchTraderTrades(wallet: string, limit = 20): Promise<TraderTrade[]> {
  const raw = await dataApiGet<Array<Record<string, unknown>>>('/trades', { user: wallet, limit: String(limit) })
  return raw.map(t => ({
    proxyWallet: String(t.proxyWallet ?? wallet),
    side: (t.side === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
    asset: String(t.asset ?? ''),
    conditionId: String(t.conditionId ?? ''),
    size: Number(t.size ?? 0),
    price: Number(t.price ?? 0),
    timestamp: Number(t.timestamp ?? 0),
    title: String(t.title ?? ''),
    slug: String(t.slug ?? ''),
    icon: typeof t.icon === 'string' ? t.icon : null,
  })).filter(t => t.asset && t.conditionId)
}

export async function fetchTraderPositions(wallet: string, limit = 100): Promise<TraderPosition[]> {
  const raw = await dataApiGet<Array<Record<string, unknown>>>('/positions', { user: wallet, limit: String(limit), sortBy: 'CURRENT' })
  return raw.map(p => ({
    asset: String(p.asset ?? ''),
    conditionId: String(p.conditionId ?? ''),
    title: String(p.title ?? ''),
    outcome: String(p.outcome ?? ''),
    size: Number(p.size ?? 0),
    avgPrice: Number(p.avgPrice ?? 0),
    curPrice: Number(p.curPrice ?? 0),
    initialValue: Number(p.initialValue ?? 0),
    currentValue: Number(p.currentValue ?? 0),
    cashPnl: Number(p.cashPnl ?? 0),
    percentPnl: Number(p.percentPnl ?? 0),
    totalBought: Number(p.totalBought ?? 0),
    realizedPnl: Number(p.realizedPnl ?? 0),
    percentRealizedPnl: Number(p.percentRealizedPnl ?? 0),
    redeemable: p.redeemable === true,
    endDate: typeof p.endDate === 'string' ? p.endDate : null,
  })).filter(p => p.asset)
}

/** Derives an at-a-glance performance profile for a trader from their position history. */
export async function computeTraderStats(wallet: string): Promise<TraderStats> {
  const positions = await fetchTraderPositions(wallet, 200)

  const totalPositions = positions.length
  const winningPositions = positions.filter(p => p.cashPnl > 0).length
  const winRate = totalPositions > 0 ? Math.round((winningPositions / totalPositions) * 100) : 0
  const totalPnl = positions.reduce((sum, p) => sum + p.cashPnl, 0)
  const totalRealizedPnl = positions.reduce((sum, p) => sum + p.realizedPnl, 0)
  const totalVolume = positions.reduce((sum, p) => sum + p.totalBought, 0)
  const avgPositionSize = totalPositions > 0 ? totalVolume / totalPositions : 0

  let bestTrade: { title: string; pnl: number } | null = null
  let worstTrade: { title: string; pnl: number } | null = null
  for (const p of positions) {
    if (!p.title) continue
    if (!bestTrade || p.cashPnl > bestTrade.pnl) bestTrade = { title: p.title, pnl: p.cashPnl }
    if (!worstTrade || p.cashPnl < worstTrade.pnl) worstTrade = { title: p.title, pnl: p.cashPnl }
  }

  return {
    wallet,
    totalPositions,
    winningPositions,
    winRate,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalRealizedPnl: Math.round(totalRealizedPnl * 100) / 100,
    totalVolume: Math.round(totalVolume * 100) / 100,
    avgPositionSize: Math.round(avgPositionSize * 100) / 100,
    bestTrade,
    worstTrade,
    updatedAt: Date.now(),
  }
}

export function logLeaderboardError(context: string, err: unknown): void {
  log('warn', 'CopyTrade', `${context}: ${(err as Error).message}`)
}
