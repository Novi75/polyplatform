/**
 * Arbitrage engine — crypto markets for all timeframes (5min, 15min, 1h).
 *
 * Monitors live WS prices from both exchanges. When a cross-side arb is
 * detected above the configured threshold, auto-executes both legs simultaneously
 * and broadcasts the state to all frontend clients.
 */
import { wsHub } from '../ws/server.js'
import { log } from '../logger.js'
import { rGet, rSet } from '../db/redis.js'
import {
  CRYPTO_ASSETS, type CryptoAsset,
  TIMEFRAMES, type MarketTimeframe, detectTimeframe,
  fetchPolyMarkets, startPolyWs, stopPolyWs, getPolyMarkets, getPolyAssetPrice,
  getPolyBalance, getPolyPositions, getPolyTokenToKeyMap, placePolyOrder, redeemPolyPositions, type PolyOrderResult,
  placePolyLimitOrder, cancelPolyOrder, getPolyOrder, type PolyMarketInfo, checkPolyLiquidity, type PolyLiquidityCheck,
} from '../exchanges/poly.js'
import {
  fetchLimMarkets, startLimWs, stopLimWs, getLimMarkets, getLimAssetPrice,
  getLimBalance, placeLimOrder, closeLimPosition, getLimMarketExpiry, redeemLimPositions,
  getLimPositionShares,
  type LimLivePrice,
} from '../exchanges/lim.js'
import { getPolyMarketExpiry } from '../exchanges/poly.js'
import { getApiCallStats } from '../exchanges/apiCallTracker.js'
import { scanSports, type MatchedSportsEvent, type SportsArbOpportunity } from './sports.js'
import {
  fetchLeaderboard, fetchTraderTrades, fetchLeaderboardWindowStats,
  computeTraderStats, logLeaderboardError,
  type LeaderboardEntry, type LeaderboardWindow, type TraderStats, type CopyTradeSignal,
} from './leaderboard.js'

// All active market keys: "BTC-5min", "BTC-15min", "BTC-1h", "ETH-5min", ... (21 total: 7 assets × 3 TFs)
const ALL_MARKET_KEYS = CRYPTO_ASSETS.flatMap(a => TIMEFRAMES.map(tf => `${a}-${tf}` as string))
function assetFromKey(key: string): CryptoAsset { return key.split('-')[0] as CryptoAsset }
function tfFromKey(key: string): MarketTimeframe { return key.split('-').slice(1).join('-') as MarketTimeframe }

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ArbOpportunity {
  key: string
  asset: CryptoAsset
  timeframe: MarketTimeframe
  direction: 'UP' | 'DOWN'
  polyAsk: number
  limOpposite: number   // lim cost for the other side
  totalCost: number
  netProfit: number
  profitPct: number
  polyTokenId: string
  limSlug: string
  secsToExpiry: number  // seconds until the closer of the two market windows closes
  expiresAt: number     // unix ms of the closer expiry
}

export interface ArbSettings {
  minProfitPct: number
  autoExecute: boolean
  maxPositionSize: number
  maxOpenTrades: number
  mode: 'arb' | 'signal' | 'both' | 'none'
  signalMinGapPct: number   // minimum probability gap between exchanges to trigger a signal bet
  xtfEnabled: boolean        // master switch for cross-timeframe signals
  xtfMinGapPct: number       // minimum YES-mid gap between TFs to trigger (default 15)
  xAssetEnabled: boolean     // master switch for cross-asset correlation signals
  xAssetMinGapPct: number    // minimum gap between leader and follower mid to trigger (default 20)
  autoExit: boolean          // automatically close positions early when exit PnL >= minProfitPct
  buzzerEnabled: boolean      // master switch for the "Buzzer Beater" late-window strategy — fully standalone, independent of `mode`/`autoExecute`
  buzzerAutoExecute: boolean  // Buzzer's own auto-execute gate, decoupled from the shared `autoExecute` switch used by arb/signal
  buzzerPositionSize: number  // BET_SIZE_USD — target spend per market (actual spend may be higher: Polymarket enforces a 5-share minimum per order)
  sportEnabled: boolean       // master switch for the Sports/Esports cross-exchange scanner — fully standalone, doesn't touch crypto markets
  cryptoEnabled: boolean      // master switch for the crypto market pipeline (REST refresh + WS feeds + ARB/Signal/XTF/XAsset/Buzzer). Turn off to run Sport/Esport only without fetching crypto.
  copyTradeEnabled: boolean       // master switch for the Leaderboard Copy-Trading strategy — fully standalone, polls followed wallets on its own schedule
  copyTradeAutoExecute: boolean   // Copy-Trade's own auto-execute gate, decoupled from the shared `autoExecute` switch — when off, signals are only detected/displayed
  copyTradePositionSize: number   // target USD spend per replicated trade (independent of the trader's own position size)
  followedWallets: string[]       // proxyWallet addresses of leaderboard traders the user has chosen to follow/copy
  spreadEnabled: boolean          // master switch for the Spread strategy — buys YES+NO on same market, profits from bid/ask spread
  spreadAutoExecute: boolean      // Spread's own auto-execute gate
  spreadPositionSize: number      // target USD spend per spread trade (split equally across both legs)
  spreadMinGapPct: number         // minimum guaranteed profit % required to execute (after fees)
  spreadPlatform: 'poly' | 'lim' | 'best'  // 'poly' = both legs on Polymarket; 'lim' = both on Limitless; 'best' = cross-platform (cheapest YES + cheapest NO)
  spreadTimeframes: MarketTimeframe[]  // which market timeframes the Spread strategy scans/trades (5min, 15min, 1h)
}

export interface XtfOpportunity {
  asset: CryptoAsset
  shortKey: string           // e.g. "ETH-5min"
  longKey: string            // e.g. "ETH-15min"
  shortExchange: 'poly' | 'lim'
  longExchange: 'poly' | 'lim'
  shortOutcome: 'yes' | 'no'    // what to BUY on the short TF leg
  longOutcome: 'yes' | 'no'     // what to BUY on the long TF leg
  shortAsk: number               // entry ask price for short leg
  longAsk: number                // entry ask price for long leg
  shortTokenId: string           // poly token id for short leg (empty if lim)
  shortLimSlug: string           // lim slug for short leg (empty if poly)
  longTokenId: string
  longLimSlug: string
  gapPct: number                 // abs(shortMid - longMid) * 100
  profitPct: number              // estimated profit if both converge to 0.5: (1 - totalCost) / totalCost * 100
  totalCost: number              // shortAsk + longAsk
  secsToExpiry: number           // short leg's seconds to expiry
  expiresAt: number              // short leg's expiry ms
}

export interface XAssetOpportunity {
  timeframe: MarketTimeframe
  leaderAsset: CryptoAsset
  leaderKey: string
  leaderMid: number          // leader YES mid price (0–1)
  followerAsset: CryptoAsset
  followerKey: string
  followerMid: number        // follower YES mid price (0–1)
  direction: 'UP' | 'DOWN'  // direction to bet on follower
  exchange: 'poly' | 'lim'  // cheaper exchange for the entry
  entryPrice: number
  evPct: number              // (leaderImpliedProb - entryPrice) / entryPrice * 100
  gapPct: number             // |leaderMid - followerMid| * 100
  tokenId: string
  limSlug: string
  secsToExpiry: number
  expiresAt: number
}

export interface SpreadOpportunity {
  key: string
  asset: CryptoAsset
  timeframe: MarketTimeframe
  yesPlatform: 'poly' | 'lim'   // exchange to buy YES on
  noPlatform:  'poly' | 'lim'   // exchange to buy NO on
  yesAsk: number                 // ask price for YES leg
  noAsk:  number                 // ask price for NO leg
  yesTokenId:  string            // Poly YES token id (empty when yesPlatform === 'lim')
  yesLimSlug:  string            // Lim slug for YES leg (empty when yesPlatform === 'poly')
  noTokenId:   string            // Poly NO token id (empty when noPlatform === 'lim')
  noLimSlug:   string            // Lim slug for NO leg (empty when noPlatform === 'poly')
  totalCost:  number             // yesAsk + noAsk
  spreadPct:  number             // guaranteed ROI after fees: (1 - totalCost - fees) / totalCost * 100
  secsToExpiry: number
  expiresAt:  number
}

export interface SignalOpportunity {
  key: string
  asset: CryptoAsset
  timeframe: MarketTimeframe
  direction: 'UP' | 'DOWN'
  exchange: 'poly' | 'lim'  // which exchange to buy on (the pessimistic / cheaper one)
  entryPrice: number         // price paid per token on the buying exchange
  confidence: number         // other exchange's implied probability (our signal)
  evPct: number              // (confidence - entryPrice - fee) / entryPrice * 100
  gapPct: number             // |polyMid - limMid| * 100
  tokenId: string            // poly token ID (empty string when buying on LIM)
  limSlug: string
  secsToExpiry: number
  expiresAt: number
}

export interface TradeRecord {
  id: string
  ts: number
  asset: CryptoAsset
  timeframe?: MarketTimeframe
  direction: 'UP' | 'DOWN'
  profitPct: number
  positionSize: number
  polyTokenId: string
  limSlug: string
  expiresAt: number
  success: boolean
  type?: 'arb' | 'signal' | 'xtf' | 'xasset' | 'buzzer' | 'spread'
  // Spread trade fields (type === 'spread')
  spreadYesPlatform?: 'poly' | 'lim'
  spreadNoPlatform?:  'poly' | 'lim'
  spreadYesAsk?: number
  spreadNoAsk?:  number
  spreadYesShares?: number
  spreadNoShares?:  number
  spreadNoTokenId?: string   // poly NO token id when noPlatform === 'poly'
  signalExchange?: 'poly' | 'lim'
  // Cross-timeframe signal fields (type === 'xtf')
  xtfShortKey?: string
  xtfLongKey?: string
  xtfShortExchange?: 'poly' | 'lim'
  xtfLongExchange?: 'poly' | 'lim'
  xtfShortOutcome?: 'yes' | 'no'
  xtfLongOutcome?: 'yes' | 'no'
  xtfShortEntryPrice?: number
  xtfLongEntryPrice?: number
  xtfShortSharesHeld?: number
  xtfLongSharesHeld?: number
  xtfShortTokenId?: string
  xtfShortLimSlug?: string
  xtfLongTokenId?: string
  xtfLongLimSlug?: string
  // Entry prices per leg — used as fallback for share calculation
  polyEntryPrice?: number
  limEntryPrice?: number
  // Actual tokens received on each leg (from order fill — more accurate than price-derived)
  polySharesHeld?: number
  limSharesHeld?: number
  // Early exit
  earlyExited?: boolean
  earlyExitPnLPct?: number
  exitCooldownUntil?: number  // don't retry before this timestamp after a failed exit attempt
  // Redemption
  conditionId?: string    // Poly condition ID — stored at trade time for post-expiry auto-redeem
  polyRedeemed?: boolean
  error?: string
  polyResult?: unknown
  limResult?: unknown
  hedgeStatus?: 'pending' | 'closed' | 'expired' | 'failed'
  hedgeError?: string
  // Spread orphan-leg watchdog — true once both legs have been confirmed against
  // live exchange/on-chain positions (or the orphan has been queued for hedging)
  legsVerified?: boolean
}

interface PendingHedge {
  tradeId: string
  openLeg: 'poly' | 'lim'
  asset: CryptoAsset
  polyTokenId: string
  limSlug: string
  limOutcome: 'yes' | 'no'
  polyEntryPrice: number
  limEntryPrice: number
  polySharesHeld?: number   // actual tokens from fill — preferred over price-derived
  limSharesHeld?: number
  positionSize: number
  expiresAt: number
  retries: number
  firstAttemptTs: number
  // When set, sell exactly this many shares (a verified on-chain/API balance) instead
  // of estimating from positionSize/entry prices — used by the spread orphan watchdog.
  directShares?: number
}

// ── State ──────────────────────────────────────────────────────────────────────

let _running = false
let _settings: ArbSettings = { minProfitPct: 1.5, autoExecute: false, maxPositionSize: 10, maxOpenTrades: 3, mode: 'arb', signalMinGapPct: 25, xtfEnabled: false, xtfMinGapPct: 15, xAssetEnabled: false, xAssetMinGapPct: 20, autoExit: false, buzzerEnabled: false, buzzerAutoExecute: false, buzzerPositionSize: 1.0, sportEnabled: false, cryptoEnabled: true, copyTradeEnabled: false, copyTradeAutoExecute: false, copyTradePositionSize: 5.0, followedWallets: [], spreadEnabled: false, spreadAutoExecute: false, spreadPositionSize: 5.0, spreadMinGapPct: 2.0, spreadPlatform: 'best', spreadTimeframes: ['5min', '15min', '1h'] }
let _tradeLog: TradeRecord[] = []
let _broadcastTimer: ReturnType<typeof setTimeout> | null = null
let _refreshTimer: ReturnType<typeof setInterval> | null = null
let _polyRedeemTimer: ReturnType<typeof setInterval> | null = null
const _executing = new Set<string>()  // guard against concurrent execution per market key
let _pendingTradeCount = 0            // trades that passed the openCount check but haven't committed yet

const TRADE_LOG_KEY = 'poly:trade-log'

async function saveTradeLog(): Promise<void> {
  await rSet(TRADE_LOG_KEY, JSON.stringify(_tradeLog)).catch(() => {})
}

async function loadTradeLog(): Promise<void> {
  try {
    const raw = await rGet(TRADE_LOG_KEY)
    if (raw) {
      _tradeLog = JSON.parse(raw) as TradeRecord[]
      log('info', 'ArbEngine', `loaded ${_tradeLog.length} trades from persistence`)
    }
  } catch { /* start fresh */ }
}

const POLY_FEE = 0.02
const LIM_FEE  = 0.02
const TOTAL_FEE = POLY_FEE + LIM_FEE

// ── Price helpers ─────────────────────────────────────────────────────────────

function getAskPrice(key: string, exchange: 'poly' | 'lim', outcome: 'yes' | 'no'): number | null {
  if (exchange === 'poly') {
    const p = getPolyAssetPrice(key)
    if (!p?.yes) return null
    if (outcome === 'yes') return p.yes.ask ?? null
    return p.no?.ask ?? (p.yes.bid != null && p.yes.bid > 0 ? 1 - p.yes.bid : null)
  } else {
    const l = getLimAssetPrice(key)
    if (!l) return null
    if (outcome === 'yes') return l.ask > 0 ? l.ask : null
    return l.noAsk ?? (l.bid > 0 ? 1 - l.bid : null)
  }
}

function getBidPrice(key: string, exchange: 'poly' | 'lim', outcome: 'yes' | 'no'): number | null {
  if (exchange === 'poly') {
    const p = getPolyAssetPrice(key)
    if (!p?.yes) return null
    if (outcome === 'yes') return p.yes.bid ?? null
    return p.no?.bid ?? (p.yes.ask != null && p.yes.ask < 1 ? 1 - p.yes.ask : null)
  } else {
    const l = getLimAssetPrice(key)
    if (!l) return null
    if (outcome === 'yes') return l.bid > 0 ? l.bid : null
    return l.noBid ?? (l.ask > 0 && l.ask < 1 ? 1 - l.ask : null)
  }
}

function getYesMid(key: string, exchange: 'poly' | 'lim'): number | null {
  if (exchange === 'poly') {
    const p = getPolyAssetPrice(key)
    const bid = p?.yes?.bid ?? 0, ask = p?.yes?.ask ?? 0
    return bid > 0 && ask > 0 ? (bid + ask) / 2 : null
  } else {
    const l = getLimAssetPrice(key)
    return l && l.bid > 0 && l.ask > 0 ? (l.bid + l.ask) / 2 : null
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings(): Promise<ArbSettings> {
  try {
    const raw = await rGet('poly:settings:arb')
    if (raw) _settings = { ..._settings, ...JSON.parse(raw) as Partial<ArbSettings> }
  } catch { /* use defaults */ }
  return _settings
}

export async function getArbSettings(): Promise<ArbSettings> { return _settings }

// ── Arb detection ──────────────────────────────────────────────────────────────

function detectArb(key: string): ArbOpportunity | null {
  const poly = getPolyAssetPrice(key)
  const lim  = getLimAssetPrice(key)
  if (!poly || !lim) return null

  const polyMarket = getPolyMarkets().get(key)
  const limMarket  = getLimMarkets().get(key)
  if (!polyMarket || !limMarket) return null

  // Guard: only arb if markets expire within the window tolerance of each other
  const polyExp = getPolyMarketExpiry(key)
  const limExp  = getLimMarketExpiry(key)
  const tf = tfFromKey(key)
  const windowToleranceMs = tf === '5min' ? 2*60_000 : tf === '15min' ? 5*60_000 : tf === '1h' ? 10*60_000 : 20*60_000
  if (polyExp && limExp && Math.abs(polyExp - limExp) > windowToleranceMs) return null

  // Compute time remaining in the closer window
  const now = Date.now()
  const expiresAt = polyExp && limExp ? Math.min(polyExp, limExp) : (polyExp || limExp || 0)
  const secsToExpiry = expiresAt ? Math.floor((expiresAt - now) / 1000) : 9999

  // Don't surface opportunities on markets that have already closed
  if (expiresAt && secsToExpiry < 0) return null

  // Minimum leg price: reject if either side is priced below 3¢ per contract.
  // This filters near-expiry distortion where one exchange has already priced in the
  // outcome (leg cost → $0) while the other hasn't caught up yet — the phantom "arb"
  // results in a $0 order on one side and a losing position on the other.
  const MIN_LEG = 0.03

  const asset = assetFromKey(key)

  // UP arb: buy YES on Poly + buy NO on Lim
  // limNoCost: use direct NO ask if available (more accurate); fall back to 1 - yesBid approximation
  if (poly.yes?.ask && lim.bid > 0) {
    const limNoCost = lim.noAsk ?? (1 - lim.bid)
    const totalCost = poly.yes.ask + limNoCost
    const netProfit = 1 - totalCost - TOTAL_FEE
    if (poly.yes.ask >= MIN_LEG && limNoCost >= MIN_LEG && netProfit > 0 && (netProfit / totalCost) * 100 >= _settings.minProfitPct) {
      return {
        key, asset, timeframe: tf, direction: 'UP',
        polyAsk: poly.yes.ask, limOpposite: limNoCost,
        totalCost, netProfit, profitPct: (netProfit / totalCost) * 100,
        polyTokenId: polyMarket.yesTokenId, limSlug: limMarket.slug,
        secsToExpiry, expiresAt,
      }
    }
  }

  // DOWN arb: buy NO on Poly + buy YES on Lim
  // Prefer actual NO ask from WS feed; fall back to 1 - yesBid only when unavailable
  if (poly.yes?.bid && lim.ask > 0) {
    const polyNoCost = poly.no?.ask ?? (1 - poly.yes.bid)
    const totalCost = polyNoCost + lim.ask
    const netProfit = 1 - totalCost - TOTAL_FEE
    if (polyNoCost >= MIN_LEG && lim.ask >= MIN_LEG && netProfit > 0 && (netProfit / totalCost) * 100 >= _settings.minProfitPct) {
      const noTokenId = polyMarket.noTokenId ?? polyMarket.yesTokenId
      return {
        key, asset, timeframe: tf, direction: 'DOWN',
        polyAsk: polyNoCost, limOpposite: lim.ask,
        totalCost, netProfit, profitPct: (netProfit / totalCost) * 100,
        polyTokenId: noTokenId, limSlug: limMarket.slug,
        secsToExpiry, expiresAt,
      }
    }
  }

  return null
}

export function scanOpportunities(): ArbOpportunity[] {
  const opps: ArbOpportunity[] = []
  for (const key of ALL_MARKET_KEYS) {
    const opp = detectArb(key)
    if (opp) opps.push(opp)
  }
  return opps.sort((a, b) => b.profitPct - a.profitPct)
}

// ── Signal detection ──────────────────────────────────────────────────────────
//
// A signal bet is a single-leg directional trade: buy the underpriced token on
// the pessimistic exchange, using the other exchange's implied probability as
// confidence (signal). EV = (confidence - entryPrice - fee) / entryPrice.
//
// Four scenarios per market key (two per gap direction, pick highest EV):
//  limMid > polyMid: LIM is bullish  → buy YES on Poly (cheap) | buy NO on LIM (cheap)
//  polyMid > limMid: Poly is bullish → buy YES on LIM (cheap)  | buy NO on Poly (cheap)

function detectSignal(key: string): SignalOpportunity | null {
  if (_settings.mode !== 'signal' && _settings.mode !== 'both') return null

  const poly = getPolyAssetPrice(key)
  const lim  = getLimAssetPrice(key)
  if (!poly?.yes || !lim) return null

  const polyBid = poly.yes.bid ?? 0
  const polyAsk = poly.yes.ask ?? 0
  const limBid  = lim.bid
  const limAsk  = lim.ask
  if (polyBid <= 0 || polyAsk <= 0 || limBid <= 0 || limAsk <= 0) return null

  const polyMid = (polyBid + polyAsk) / 2
  const limMid  = (limBid + limAsk) / 2
  const gap     = Math.abs(polyMid - limMid)
  if (gap < _settings.signalMinGapPct / 100) return null

  const polyMarket = getPolyMarkets().get(key)
  const limMarket  = getLimMarkets().get(key)
  if (!polyMarket || !limMarket) return null

  const polyExp = getPolyMarketExpiry(key)
  const limExp  = getLimMarketExpiry(key)
  const tf = tfFromKey(key)
  const windowToleranceMs = tf === '5min' ? 2*60_000 : tf === '15min' ? 5*60_000 : tf === '1h' ? 10*60_000 : 20*60_000
  // Guard: only signal if both markets are in the same window
  if (polyExp && limExp && Math.abs(polyExp - limExp) > windowToleranceMs) return null
  const now = Date.now()
  const expiresAt = polyExp && limExp ? Math.min(polyExp, limExp) : (polyExp || limExp || 0)
  const secsToExpiry = expiresAt ? Math.floor((expiresAt - now) / 1000) : 9999
  if (expiresAt && secsToExpiry < 0) return null

  const asset = assetFromKey(key)
  const gapPct = gap * 100
  const candidates: SignalOpportunity[] = []

  if (limMid > polyMid) {
    // LIM is more bullish: Poly YES is cheap, LIM NO is cheap

    // Buy YES on Poly — confidence = limMid
    if (polyAsk > 0 && polyAsk < 1) {
      const evPct = ((limMid - polyAsk - POLY_FEE) / polyAsk) * 100
      candidates.push({ key, asset, timeframe: tf, direction: 'UP', exchange: 'poly', entryPrice: polyAsk, confidence: limMid, evPct, gapPct, tokenId: polyMarket.yesTokenId, limSlug: limMarket.slug, secsToExpiry, expiresAt })
    }
    // Buy NO on LIM — confidence = Poly's DOWN probability (1 - polyMid)
    const limNoAsk = lim.noAsk ?? (1 - limBid)
    if (limNoAsk > 0 && limNoAsk < 1) {
      const confidence = 1 - polyMid
      const evPct = ((confidence - limNoAsk - LIM_FEE) / limNoAsk) * 100
      candidates.push({ key, asset, timeframe: tf, direction: 'DOWN', exchange: 'lim', entryPrice: limNoAsk, confidence, evPct, gapPct, tokenId: '', limSlug: limMarket.slug, secsToExpiry, expiresAt })
    }
  } else {
    // Poly is more bullish: LIM YES is cheap, Poly NO is cheap

    // Buy YES on LIM — confidence = polyMid
    if (limAsk > 0 && limAsk < 1) {
      const evPct = ((polyMid - limAsk - LIM_FEE) / limAsk) * 100
      candidates.push({ key, asset, timeframe: tf, direction: 'UP', exchange: 'lim', entryPrice: limAsk, confidence: polyMid, evPct, gapPct, tokenId: '', limSlug: limMarket.slug, secsToExpiry, expiresAt })
    }
    // Buy NO on Poly — confidence = LIM's DOWN probability (1 - limMid)
    if (polyBid > 0) {
      const polyNoAsk = 1 - polyBid
      const confidence = 1 - limMid
      const noTokenId = polyMarket.noTokenId ?? polyMarket.yesTokenId
      const evPct = ((confidence - polyNoAsk - POLY_FEE) / polyNoAsk) * 100
      candidates.push({ key, asset, timeframe: tf, direction: 'DOWN', exchange: 'poly', entryPrice: polyNoAsk, confidence, evPct, gapPct, tokenId: noTokenId, limSlug: limMarket.slug, secsToExpiry, expiresAt })
    }
  }

  const best = candidates.sort((a, b) => b.evPct - a.evPct)[0] ?? null
  return best && best.evPct >= _settings.minProfitPct ? best : null
}

export function scanSignals(): SignalOpportunity[] {
  if (_settings.mode !== 'signal' && _settings.mode !== 'both') return []
  const sigs: SignalOpportunity[] = []
  for (const key of ALL_MARKET_KEYS) {
    const sig = detectSignal(key)
    if (sig) sigs.push(sig)
  }
  return sigs.sort((a, b) => b.evPct - a.evPct)
}

// ── Cross-timeframe detection ─────────────────────────────────────────────────

const XTF_PAIRS: Array<[string, string]> = [
  ['5min', '15min'], ['5min', '1h'], ['15min', '1h'],
]

function detectXtfOpportunities(asset: CryptoAsset): XtfOpportunity[] {
  if (!_settings.xtfEnabled) return []

  const now = Date.now()
  const MIN_SECS = 60
  const MIN_LEG = 0.05
  const results: XtfOpportunity[] = []

  for (const [shortTf, longTf] of XTF_PAIRS) {
    const shortKey = `${asset}-${shortTf}`
    const longKey = `${asset}-${longTf}`

    const shortPolyMkt = getPolyMarkets().get(shortKey)
    const shortLimMkt  = getLimMarkets().get(shortKey)
    const longPolyMkt  = getPolyMarkets().get(longKey)
    const longLimMkt   = getLimMarkets().get(longKey)

    if (!shortPolyMkt && !shortLimMkt) continue
    if (!longPolyMkt && !longLimMkt) continue

    const shortExp = getPolyMarketExpiry(shortKey) || getLimMarketExpiry(shortKey)
    if (!shortExp || (shortExp - now) / 1000 < MIN_SECS) continue

    // Compute YES mid for short and long TFs across exchanges
    const shortPolyMid = getYesMid(shortKey, 'poly')
    const shortLimMid  = getYesMid(shortKey, 'lim')
    const longPolyMid  = getYesMid(longKey, 'poly')
    const longLimMid   = getYesMid(longKey, 'lim')

    // Best YES mid for short TF (highest across exchanges = most overpriced)
    const shortHighMid = Math.max(shortPolyMid ?? 0, shortLimMid ?? 0)
    // Best YES mid for long TF (lowest across exchanges = most underpriced)
    const longLowMid   = Math.min(longPolyMid ?? 1, longLimMid ?? 1)
    // Also check reverse
    const shortLowMid  = Math.min(shortPolyMid ?? 1, shortLimMid ?? 1)
    const longHighMid  = Math.max(longPolyMid ?? 0, longLimMid ?? 0)

    // Case 1: short TF overpriced vs long TF → buy NO on short + YES on long
    if (shortHighMid > 0 && longLowMid > 0 && longLowMid < 1) {
      const gapPct = (shortHighMid - longLowMid) * 100
      if (gapPct >= _settings.xtfMinGapPct) {
        // Cheapest NO ask on short TF
        const shortPolyNoAsk = getAskPrice(shortKey, 'poly', 'no')
        const shortLimNoAsk  = getAskPrice(shortKey, 'lim', 'no')
        // Cheapest YES ask on long TF
        const longPolyYesAsk = getAskPrice(longKey, 'poly', 'yes')
        const longLimYesAsk  = getAskPrice(longKey, 'lim', 'yes')

        const shortAsk = Math.min(
          shortPolyNoAsk != null && shortPolyNoAsk >= MIN_LEG ? shortPolyNoAsk : Infinity,
          shortLimNoAsk  != null && shortLimNoAsk  >= MIN_LEG ? shortLimNoAsk  : Infinity,
        )
        const longAsk = Math.min(
          longPolyYesAsk != null && longPolyYesAsk >= MIN_LEG ? longPolyYesAsk : Infinity,
          longLimYesAsk  != null && longLimYesAsk  >= MIN_LEG ? longLimYesAsk  : Infinity,
        )

        if (isFinite(shortAsk) && isFinite(longAsk)) {
          const shortExchange: 'poly' | 'lim' = (shortPolyNoAsk != null && shortPolyNoAsk >= MIN_LEG && shortPolyNoAsk <= shortAsk && shortPolyMkt) ? 'poly' : 'lim'
          const longExchange:  'poly' | 'lim' = (longPolyYesAsk != null && longPolyYesAsk >= MIN_LEG && longPolyYesAsk <= longAsk && longPolyMkt) ? 'poly' : 'lim'
          const totalCost = shortAsk + longAsk
          const profitPct = ((1 - totalCost) / totalCost) * 100
          if (profitPct > 0) {
            results.push({
              asset, shortKey, longKey,
              shortExchange, longExchange,
              shortOutcome: 'no', longOutcome: 'yes',
              shortAsk, longAsk, totalCost, gapPct, profitPct,
              shortTokenId: shortExchange === 'poly' ? (shortPolyMkt?.noTokenId ?? '') : '',
              shortLimSlug: shortExchange === 'lim'  ? (shortLimMkt?.slug ?? '') : '',
              longTokenId: longExchange === 'poly' ? (longPolyMkt?.yesTokenId ?? '') : '',
              longLimSlug: longExchange === 'lim'  ? (longLimMkt?.slug ?? '') : '',
              secsToExpiry: Math.floor((shortExp - now) / 1000),
              expiresAt: shortExp,
            })
          }
        }
      }
    }

    // Case 2: short TF underpriced vs long TF → buy YES on short + NO on long
    if (longHighMid > 0 && shortLowMid > 0 && shortLowMid < 1) {
      const gapPct = (longHighMid - shortLowMid) * 100
      if (gapPct >= _settings.xtfMinGapPct) {
        const shortPolyYesAsk = getAskPrice(shortKey, 'poly', 'yes')
        const shortLimYesAsk  = getAskPrice(shortKey, 'lim', 'yes')
        const longPolyNoAsk   = getAskPrice(longKey, 'poly', 'no')
        const longLimNoAsk    = getAskPrice(longKey, 'lim', 'no')

        const shortAsk = Math.min(
          shortPolyYesAsk != null && shortPolyYesAsk >= MIN_LEG ? shortPolyYesAsk : Infinity,
          shortLimYesAsk  != null && shortLimYesAsk  >= MIN_LEG ? shortLimYesAsk  : Infinity,
        )
        const longAsk = Math.min(
          longPolyNoAsk != null && longPolyNoAsk >= MIN_LEG ? longPolyNoAsk : Infinity,
          longLimNoAsk  != null && longLimNoAsk  >= MIN_LEG ? longLimNoAsk  : Infinity,
        )

        if (isFinite(shortAsk) && isFinite(longAsk)) {
          const shortExchange: 'poly' | 'lim' = (shortPolyYesAsk != null && shortPolyYesAsk >= MIN_LEG && shortPolyYesAsk <= shortAsk && shortPolyMkt) ? 'poly' : 'lim'
          const longExchange:  'poly' | 'lim' = (longPolyNoAsk   != null && longPolyNoAsk   >= MIN_LEG && longPolyNoAsk   <= longAsk  && longPolyMkt)  ? 'poly' : 'lim'
          const totalCost = shortAsk + longAsk
          const profitPct = ((1 - totalCost) / totalCost) * 100
          if (profitPct > 0) {
            results.push({
              asset, shortKey, longKey,
              shortExchange, longExchange,
              shortOutcome: 'yes', longOutcome: 'no',
              shortAsk, longAsk, totalCost, gapPct, profitPct,
              shortTokenId: shortExchange === 'poly' ? (shortPolyMkt?.yesTokenId ?? '') : '',
              shortLimSlug: shortExchange === 'lim'  ? (shortLimMkt?.slug ?? '') : '',
              longTokenId: longExchange === 'poly' ? (longPolyMkt?.noTokenId ?? '') : '',
              longLimSlug: longExchange === 'lim'  ? (longLimMkt?.slug ?? '') : '',
              secsToExpiry: Math.floor((shortExp - now) / 1000),
              expiresAt: shortExp,
            })
          }
        }
      }
    }
  }

  // Return sorted by profitPct descending
  return results.sort((a, b) => b.profitPct - a.profitPct)
}

export function scanXtfOpportunities(): XtfOpportunity[] {
  if (!_settings.xtfEnabled) return []
  return CRYPTO_ASSETS.flatMap(a => detectXtfOpportunities(a)).sort((a, b) => b.profitPct - a.profitPct)
}

async function executeSignal(sig: SignalOpportunity): Promise<void> {
  if (_executing.has(sig.key)) return
  if (sig.secsToExpiry < 60) {
    log('info', 'ArbEngine', `skip signal ${sig.key} — only ${sig.secsToExpiry}s to expiry`)
    return
  }

  const now = Date.now()
  const openCount = _tradeLog.filter(t =>
    (t.success || t.hedgeStatus === 'pending') && !t.earlyExited && t.expiresAt > now
  ).length + _pendingTradeCount
  if (openCount >= _settings.maxOpenTrades) {
    log('info', 'ArbEngine', `skip signal ${sig.key} — ${openCount}/${_settings.maxOpenTrades} trades open`)
    return
  }

  _executing.add(sig.key)
  _pendingTradeCount++
  const id = `${sig.key}-SIG-${Date.now()}`
  log('info', 'ArbEngine', `signal ${sig.key} ${sig.direction} on ${sig.exchange}: EV ${sig.evPct.toFixed(2)}% | entry ${sig.entryPrice.toFixed(3)} | confidence ${(sig.confidence * 100).toFixed(1)}% gap ${sig.gapPct.toFixed(1)}% | ${sig.secsToExpiry}s left`)

  const record: TradeRecord = {
    id, ts: Date.now(), asset: sig.asset, timeframe: sig.timeframe, direction: sig.direction,
    profitPct: sig.evPct, positionSize: _settings.maxPositionSize,
    polyTokenId: sig.tokenId, limSlug: sig.limSlug,
    expiresAt: sig.expiresAt, success: false,
    type: 'signal', signalExchange: sig.exchange,
  }

  const t0 = Date.now()
  try {
    const outcome = sig.direction === 'UP' ? 'yes' : 'no'
    let result: unknown
    if (sig.exchange === 'poly') {
      result = await placePolyOrder(sig.tokenId, 'BUY', _settings.maxPositionSize)
      record.polyResult = result
    } else {
      result = await placeLimOrder(sig.limSlug, outcome, _settings.maxPositionSize)
      record.limResult = result
    }
    record.success = true
    log('info', 'ArbEngine', `signal success — ${sig.key} ${sig.direction} ${sig.exchange} +EV ${sig.evPct.toFixed(2)}% [${Date.now() - t0}ms]`)
  } catch (err) {
    record.error = (err as Error).message
    log('warn', 'ArbEngine', `signal failed — ${record.error} [${Date.now() - t0}ms]`)
  } finally {
    _executing.delete(sig.key)
    _pendingTradeCount--
    _tradeLog.unshift(record)
    if (_tradeLog.length > 200) _tradeLog = _tradeLog.slice(0, 200)
    saveTradeLog().catch(() => {})
    broadcastState()
  }
}

export async function triggerManualSignal(key: string): Promise<{ ok: boolean; error?: string }> {
  const sig = detectSignal(key)
  if (!sig) return { ok: false, error: 'No signal opportunity for this market right now' }
  executeSignal(sig).catch(() => {})
  return { ok: true }
}

// ── Cross-asset correlation detection ────────────────────────────────────────
// Identifies assets in the same timeframe where one (the "leader") has strong
// directional conviction and another (the "follower") hasn't repriced yet.

function detectXAssetOpportunities(): XAssetOpportunity[] {
  if (!_settings.xAssetEnabled) return []

  const now = Date.now()
  const MIN_SECS = 60
  const MIN_LEG = 0.05
  const results: XAssetOpportunity[] = []

  for (const tf of TIMEFRAMES) {
    // Collect best YES mid for each asset, averaging across available exchanges
    const assetMids: Array<{ asset: CryptoAsset; key: string; mid: number }> = []
    for (const asset of CRYPTO_ASSETS) {
      const key = `${asset}-${tf}`
      const polyMid = getYesMid(key, 'poly')
      const limMid  = getYesMid(key, 'lim')
      const available = ([polyMid, limMid]).filter((m): m is number => m !== null)
      if (available.length === 0) continue
      const mid = available.reduce((a, b) => a + b, 0) / available.length
      assetMids.push({ asset, key, mid })
    }
    if (assetMids.length < 2) continue

    for (const leader of assetMids) {
      for (const follower of assetMids) {
        if (leader.asset === follower.asset) continue
        const rawGap = leader.mid - follower.mid  // positive = leader bullish vs follower
        if (Math.abs(rawGap) * 100 < _settings.xAssetMinGapPct) continue

        const direction: 'UP' | 'DOWN' = rawGap > 0 ? 'UP' : 'DOWN'
        const outcome: 'yes' | 'no'    = direction === 'UP' ? 'yes' : 'no'

        // Find cheapest ask on the follower for this outcome
        const polyAsk = getAskPrice(follower.key, 'poly', outcome)
        const limAsk  = getAskPrice(follower.key, 'lim',  outcome)
        const polyMkt = getPolyMarkets().get(follower.key)
        const limMkt  = getLimMarkets().get(follower.key)

        let exchange: 'poly' | 'lim'
        let entryPrice: number
        let tokenId = ''
        let limSlug = ''

        const polyValid = polyAsk !== null && polyAsk >= MIN_LEG && polyMkt != null
        const limValid  = limAsk  !== null && limAsk  >= MIN_LEG && limMkt  != null

        if (polyValid && (!limValid || polyAsk! <= limAsk!)) {
          exchange = 'poly'; entryPrice = polyAsk!
          tokenId = outcome === 'yes' ? polyMkt!.yesTokenId : (polyMkt!.noTokenId ?? polyMkt!.yesTokenId)
        } else if (limValid) {
          exchange = 'lim'; entryPrice = limAsk!
          limSlug = limMkt!.slug
        } else {
          continue
        }

        // EV: use leader's implied probability for the follower outcome
        const impliedProb = direction === 'UP' ? leader.mid : (1 - leader.mid)
        const evPct = (impliedProb - entryPrice) / entryPrice * 100
        if (evPct <= 0) continue

        const expiresAt = getPolyMarketExpiry(follower.key) || getLimMarketExpiry(follower.key) || 0
        if (expiresAt && (expiresAt - now) / 1000 < MIN_SECS) continue

        results.push({
          timeframe: tf as MarketTimeframe,
          leaderAsset: leader.asset, leaderKey: leader.key, leaderMid: leader.mid,
          followerAsset: follower.asset, followerKey: follower.key, followerMid: follower.mid,
          direction, exchange, entryPrice, evPct,
          gapPct: Math.abs(rawGap) * 100,
          tokenId, limSlug,
          secsToExpiry: expiresAt ? Math.floor((expiresAt - now) / 1000) : 9999,
          expiresAt,
        })
      }
    }
  }

  // Deduplicate: per followerKey+direction keep only the highest-EV leader signal
  const best = new Map<string, XAssetOpportunity>()
  for (const opp of results) {
    const k = `${opp.followerKey}-${opp.direction}`
    const cur = best.get(k)
    if (!cur || opp.evPct > cur.evPct) best.set(k, opp)
  }

  return [...best.values()].sort((a, b) => b.evPct - a.evPct).slice(0, 15)
}

export function scanXAssetOpportunities(): XAssetOpportunity[] {
  return detectXAssetOpportunities()
}

async function executeXAssetTrade(opp: XAssetOpportunity): Promise<void> {
  const execKey = `xasset-${opp.followerKey}`
  if (_executing.has(execKey) || _executing.has(opp.followerKey)) return
  if (opp.secsToExpiry < 60) return

  const now = Date.now()
  const openCount = _tradeLog.filter(t =>
    (t.success || t.hedgeStatus === 'pending') && !t.earlyExited && t.expiresAt > now
  ).length + _pendingTradeCount
  if (openCount >= _settings.maxOpenTrades) {
    log('info', 'ArbEngine', `skip xasset ${opp.followerKey} — ${openCount}/${_settings.maxOpenTrades} trades open`)
    return
  }

  _executing.add(execKey)
  _pendingTradeCount++

  const POLY_MIN_ORDER = 1.00
  let positionSize = _settings.maxPositionSize
  if (opp.exchange === 'poly' && positionSize < POLY_MIN_ORDER) {
    log('info', 'ArbEngine', `xasset ${opp.followerKey} — bumping to $${POLY_MIN_ORDER} (Poly min)`)
    positionSize = POLY_MIN_ORDER
  }

  log('info', 'ArbEngine', `xasset ${opp.leaderAsset}→${opp.followerAsset} ${opp.timeframe} ${opp.direction} on ${opp.exchange}: leader=${opp.leaderMid.toFixed(3)} follower=${opp.followerMid.toFixed(3)} gap=${opp.gapPct.toFixed(1)}% EV=${opp.evPct.toFixed(1)}% entry=${opp.entryPrice.toFixed(3)}`)

  const record: TradeRecord = {
    id: `${opp.followerKey}-XA-${Date.now()}`, ts: Date.now(),
    asset: opp.followerAsset, timeframe: opp.timeframe, direction: opp.direction,
    profitPct: opp.evPct, positionSize,
    polyTokenId: opp.tokenId, limSlug: opp.limSlug,
    expiresAt: opp.expiresAt, success: false,
    type: 'xasset', signalExchange: opp.exchange,
  }

  const t0 = Date.now()
  try {
    const outcome = opp.direction === 'UP' ? 'yes' : 'no'
    if (opp.exchange === 'poly') {
      record.polyResult = await placePolyOrder(opp.tokenId, 'BUY', positionSize)
    } else {
      record.limResult = await placeLimOrder(opp.limSlug, outcome, positionSize)
    }
    record.success = true
    log('info', 'ArbEngine', `xasset success — ${opp.followerAsset} ${opp.direction} +EV ${opp.evPct.toFixed(2)}% [${Date.now() - t0}ms]`)
  } catch (err) {
    record.error = (err as Error).message
    log('warn', 'ArbEngine', `xasset failed — ${record.error} [${Date.now() - t0}ms]`)
  } finally {
    _executing.delete(execKey)
    _pendingTradeCount--
    _tradeLog.unshift(record)
    if (_tradeLog.length > 200) _tradeLog = _tradeLog.slice(0, 200)
    saveTradeLog().catch(() => {})
    broadcastState()
  }
}

// ── Spread detection & execution ─────────────────────────────────────────────
//
// A spread trade buys YES + NO on the same market simultaneously.  At resolution,
// exactly one token pays $1 — so the guaranteed payout is always $1 per contract
// regardless of outcome.  Profit = $1 − (yesAsk + noAsk) − fees.
//
// Platform modes:
//   'poly'  — both legs on Polymarket
//   'lim'   — both legs on Limitless
//   'best'  — cross-platform: cheapest available YES + cheapest available NO

function detectSpread(key: string, force = false): SpreadOpportunity | null {
  const polyMkt = getPolyMarkets().get(key)
  const limMkt  = getLimMarkets().get(key)
  if (!polyMkt && !limMkt) return null

  const now = Date.now()
  const polyExp = getPolyMarketExpiry(key)
  const limExp  = getLimMarketExpiry(key)
  const expiresAt = polyExp && limExp ? Math.min(polyExp, limExp) : (polyExp || limExp || 0)
  const secsToExpiry = expiresAt ? Math.floor((expiresAt - now) / 1000) : 9999
  if (secsToExpiry < 0) return null

  const MIN_LEG = 0.03
  const asset = assetFromKey(key)
  const tf = tfFromKey(key)
  const mode = _settings.spreadPlatform

  const polyYesAsk = polyMkt ? getAskPrice(key, 'poly', 'yes') : null
  const polyNoAsk  = polyMkt ? getAskPrice(key, 'poly', 'no')  : null
  const limYesAsk  = limMkt  ? getAskPrice(key, 'lim',  'yes') : null
  const limNoAsk   = limMkt  ? getAskPrice(key, 'lim',  'no')  : null

  let best: SpreadOpportunity | null = null

  const tryCandidate = (yesPl: 'poly' | 'lim', noPl: 'poly' | 'lim', yesAsk: number, noAsk: number, force = false) => {
    if (yesAsk < MIN_LEG || noAsk < MIN_LEG) return
    if (yesPl === 'poly' && !polyMkt) return
    if (noPl  === 'poly' && !polyMkt) return
    if (yesPl === 'lim'  && !limMkt)  return
    if (noPl  === 'lim'  && !limMkt)  return
    const totalCost = yesAsk + noAsk
    const feeCost = (yesPl === 'poly' ? POLY_FEE : LIM_FEE) + (noPl === 'poly' ? POLY_FEE : LIM_FEE)
    const netProfit = 1 - totalCost - feeCost
    const spreadPct = totalCost > 0 ? (netProfit / totalCost) * 100 : 0
    if (!force && (netProfit <= 0 || spreadPct < _settings.spreadMinGapPct)) return
    // Pre-flight: check that the budget is large enough to satisfy Polymarket's $1 min per leg.
    // contracts = budget / totalCost; if any Poly leg USDC < $1, this can't be executed.
    const POLY_MIN = 1.00
    const contracts = _settings.spreadPositionSize / totalCost
    if (yesPl === 'poly' && contracts * yesAsk < POLY_MIN) return
    if (noPl  === 'poly' && contracts * noAsk  < POLY_MIN) return
    const opp: SpreadOpportunity = {
      key, asset, timeframe: tf,
      yesPlatform: yesPl, noPlatform: noPl,
      yesAsk, noAsk, totalCost, spreadPct, secsToExpiry, expiresAt,
      yesTokenId:  yesPl === 'poly' ? (polyMkt?.yesTokenId ?? '') : '',
      yesLimSlug:  yesPl === 'lim'  ? (limMkt?.slug ?? '') : '',
      noTokenId:   noPl  === 'poly' ? (polyMkt?.noTokenId ?? polyMkt?.yesTokenId ?? '') : '',
      noLimSlug:   noPl  === 'lim'  ? (limMkt?.slug ?? '') : '',
    }
    if (!best || opp.spreadPct > best.spreadPct) best = opp
  }

  // Poly-only
  if (mode === 'poly' && polyYesAsk && polyNoAsk) {
    tryCandidate('poly', 'poly', polyYesAsk, polyNoAsk, force)
  }
  // Lim-only
  if (mode === 'lim' && limYesAsk && limNoAsk) {
    tryCandidate('lim', 'lim', limYesAsk, limNoAsk, force)
  }
  // Cross-platform ('best'): always one leg per exchange — try both permutations
  if (mode === 'best' && polyYesAsk && limYesAsk && polyNoAsk && limNoAsk) {
    tryCandidate('poly', 'lim', polyYesAsk, limNoAsk, force)
    tryCandidate('lim', 'poly', limYesAsk, polyNoAsk, force)
  }

  return best
}

export function scanSpreadOpportunities(): SpreadOpportunity[] {
  if (!_settings.spreadEnabled) return []
  const opps: SpreadOpportunity[] = []
  for (const key of ALL_MARKET_KEYS) {
    if (!_settings.spreadTimeframes.includes(tfFromKey(key))) continue
    const opp = detectSpread(key)
    if (opp) opps.push(opp)
  }
  return opps.sort((a, b) => b.spreadPct - a.spreadPct)
}

async function executeSpreadTrade(opp: SpreadOpportunity): Promise<void> {
  const execKey = `spread-${opp.key}`
  if (_executing.has(execKey) || _executing.has(opp.key)) return
  if (opp.secsToExpiry < 60) {
    log('info', 'ArbEngine', `spread skip ${opp.key} — only ${opp.secsToExpiry}s to expiry`)
    return
  }
  if (opp.yesAsk < 0.03 || opp.noAsk < 0.03) {
    log('warn', 'ArbEngine', `spread skip ${opp.key} — near-zero leg price`)
    return
  }

  const now = Date.now()

  // Guard: no duplicate spread on the same key in this window
  const alreadyOpen = _tradeLog.some(t =>
    t.type === 'spread' && (t.success || t.hedgeStatus === 'pending') && !t.earlyExited &&
    `${t.asset}-${t.timeframe}` === opp.key && t.expiresAt > now
  )
  if (alreadyOpen) return

  const openCount = _tradeLog.filter(t =>
    (t.success || t.hedgeStatus === 'pending') && !t.earlyExited && t.expiresAt > now
  ).length + _pendingTradeCount
  if (openCount >= _settings.maxOpenTrades) {
    log('info', 'ArbEngine', `spread skip ${opp.key} — ${openCount}/${_settings.maxOpenTrades} trades open`)
    return
  }

  _executing.add(execKey)
  _pendingTradeCount++

  const id = `${opp.key}-SPREAD-${Date.now()}`

  // Equal-contract sizing: N contracts of YES + N contracts of NO.
  // spreadPositionSize is the hard cap for the combined trade (both legs).
  const POLY_MIN = 1.00
  const contracts = _settings.spreadPositionSize / opp.totalCost
  const yesUSDC = Math.round(contracts * opp.yesAsk * 1e6) / 1e6
  const noUSDC  = Math.round(contracts * opp.noAsk  * 1e6) / 1e6
  // Poly enforces a $1 minimum per order — skip rather than exceed the budget
  if (opp.yesPlatform === 'poly' && yesUSDC < POLY_MIN) {
    log('info', 'ArbEngine', `spread skip ${opp.key} — YES@poly leg $${yesUSDC.toFixed(2)} < $${POLY_MIN} min (increase spreadPositionSize)`)
    _executing.delete(execKey)
    _pendingTradeCount--
    return
  }
  if (opp.noPlatform === 'poly' && noUSDC < POLY_MIN) {
    log('info', 'ArbEngine', `spread skip ${opp.key} — NO@poly leg $${noUSDC.toFixed(2)} < $${POLY_MIN} min (increase spreadPositionSize)`)
    _executing.delete(execKey)
    _pendingTradeCount--
    return
  }

  // Pre-flight depth + price check: confirm the Poly orderbook can fill each Poly leg
  // AT ROUGHLY THE EXPECTED PRICE before committing to either leg. Polymarket market
  // orders are FAK — if the book can't match at all, the order is killed outright,
  // but even when it CAN match, a thin book beyond the best price fills at a much
  // worse average price, returning far fewer shares than the equal-contract sizing
  // assumed and breaking the hedge. Checking first avoids placing the Lim leg only to
  // have the Poly leg fail or fill at a hedge-breaking price.
  const polyChecks: Promise<{ leg: 'YES' | 'NO'; check: PolyLiquidityCheck }>[] = []
  if (opp.yesPlatform === 'poly') polyChecks.push(checkPolyLiquidity(opp.yesTokenId, yesUSDC, opp.yesAsk).then(check => ({ leg: 'YES' as const, check })))
  if (opp.noPlatform  === 'poly') polyChecks.push(checkPolyLiquidity(opp.noTokenId, noUSDC, opp.noAsk).then(check => ({ leg: 'NO' as const, check })))
  if (polyChecks.length > 0) {
    const results = await Promise.all(polyChecks)
    const failed = results.find(r => !r.check.ok)
    if (failed) {
      log('info', 'ArbEngine', `spread skip ${opp.key} — Poly ${failed.leg} leg: ${failed.check.reason}`)
      _executing.delete(execKey)
      _pendingTradeCount--
      return
    }
  }

  const totalSpend = yesUSDC + noUSDC

  log('info', 'ArbEngine', `spread ${opp.key}: YES@${opp.yesPlatform}($${yesUSDC.toFixed(2)}@${opp.yesAsk.toFixed(3)}) + NO@${opp.noPlatform}($${noUSDC.toFixed(2)}@${opp.noAsk.toFixed(3)}) spread=${opp.spreadPct.toFixed(2)}% ${opp.secsToExpiry}s left`)

  const record: TradeRecord = {
    id, ts: Date.now(), asset: opp.asset, timeframe: opp.timeframe,
    direction: 'UP',  // sentinel — spread holds both directions
    profitPct: opp.spreadPct, positionSize: totalSpend,
    polyTokenId: opp.yesTokenId || opp.noTokenId,
    limSlug: opp.yesLimSlug || opp.noLimSlug,
    expiresAt: opp.expiresAt, success: false,
    type: 'spread',
    spreadYesPlatform: opp.yesPlatform, spreadNoPlatform: opp.noPlatform,
    spreadYesAsk: opp.yesAsk, spreadNoAsk: opp.noAsk,
    spreadNoTokenId: opp.noTokenId,
    conditionId: getPolyMarkets().get(opp.key)?.conditionId,
  }

  const t0 = Date.now()
  try {
    let yesResult: unknown, noResult: unknown
    let yesSharesHeld: number | undefined, noSharesHeld: number | undefined

    const crossPlatform = opp.yesPlatform !== opp.noPlatform

    if (crossPlatform) {
      // Sequential execution: Poly leg first, Lim leg only if Poly succeeds.
      // Parallel (allSettled) causes one-sided Lim positions when Poly FAK orders
      // fail — the Lim leg runs and fills regardless, leaving an unhedged position.
      const polyIsYes = opp.yesPlatform === 'poly'
      let polyFailed = false

      try {
        if (polyIsYes) {
          const r = await placePolyOrder(opp.yesTokenId, 'BUY', yesUSDC)
          yesResult = r.raw
          if (r.tokensReceived != null && r.tokensReceived > 0) yesSharesHeld = r.tokensReceived
        } else {
          const r = await placePolyOrder(opp.noTokenId, 'BUY', noUSDC)
          noResult = r.raw
          if (r.tokensReceived != null && r.tokensReceived > 0) noSharesHeld = r.tokensReceived
        }
      } catch (polyErr) {
        polyFailed = true
        const msg = (polyErr as Error).message
        record.error = msg
        if (polyIsYes) yesResult = msg; else noResult = msg
        log('warn', 'ArbEngine', `spread abort ${opp.key} — poly FAK failed, lim leg NOT placed: ${msg} [${Date.now() - t0}ms]`)
      }

      if (!polyFailed) {
        try {
          if (polyIsYes) {
            noResult = await placeLimOrder(opp.noLimSlug, 'no', noUSDC)
          } else {
            yesResult = await placeLimOrder(opp.yesLimSlug, 'yes', yesUSDC)
          }
          record.success = true
          log('info', 'ArbEngine', `spread success — ${opp.key} +${opp.spreadPct.toFixed(2)}% [${Date.now() - t0}ms]`)
        } catch (limErr) {
          const msg = (limErr as Error).message
          record.error = `poly ok, lim failed: ${msg} — ONE-SIDED POLY POSITION`
          if (polyIsYes) noResult = msg; else yesResult = msg
          log('warn', 'ArbEngine', `spread ONE-SIDED ${opp.key} — poly filled but lim FAILED: ${msg} [${Date.now() - t0}ms]`)
        }
      }

      record.polyResult = polyIsYes ? yesResult : noResult
      record.limResult  = polyIsYes ? noResult  : yesResult
      record.spreadYesShares = yesSharesHeld
      record.spreadNoShares  = noSharesHeld
    } else {
      // Same-platform: parallel is safe — a failure on one doesn't orphan a position on the other
      const yesPromise = opp.yesPlatform === 'poly'
        ? placePolyOrder(opp.yesTokenId, 'BUY', yesUSDC).then(r => {
            yesResult = r.raw
            if (r.tokensReceived != null && r.tokensReceived > 0) yesSharesHeld = r.tokensReceived
          })
        : placeLimOrder(opp.yesLimSlug, 'yes', yesUSDC).then(r => { yesResult = r })

      const noPromise = opp.noPlatform === 'poly'
        ? placePolyOrder(opp.noTokenId, 'BUY', noUSDC).then(r => {
            noResult = r.raw
            if (r.tokensReceived != null && r.tokensReceived > 0) noSharesHeld = r.tokensReceived
          })
        : placeLimOrder(opp.noLimSlug, 'no', noUSDC).then(r => { noResult = r })

      const [yesSettled, noSettled] = await Promise.allSettled([yesPromise, noPromise])
      const yesOk = yesSettled.status === 'fulfilled'
      const noOk  = noSettled.status  === 'fulfilled'

      if (!yesOk) yesResult = (yesSettled as PromiseRejectedResult).reason?.message ?? 'failed'
      if (!noOk)  noResult  = (noSettled  as PromiseRejectedResult).reason?.message ?? 'failed'

      if (opp.yesPlatform === 'poly') record.polyResult = yesResult
      else record.limResult = yesResult
      if (noOk && opp.noPlatform === 'poly') record.polyResult = noResult
      else if (!yesOk && opp.noPlatform === 'lim') record.limResult = noResult

      record.spreadYesShares = yesSharesHeld
      record.spreadNoShares  = noSharesHeld

      if (yesOk && noOk) {
        record.success = true
        log('info', 'ArbEngine', `spread success — ${opp.key} +${opp.spreadPct.toFixed(2)}% [${Date.now() - t0}ms]`)
      } else {
        const yesErr = !yesOk ? String((yesSettled as PromiseRejectedResult).reason?.message ?? 'yes failed') : null
        const noErr  = !noOk  ? String((noSettled  as PromiseRejectedResult).reason?.message ?? 'no failed')  : null
        record.error = [yesErr, noErr].filter(Boolean).join(' / ')
        log('warn', 'ArbEngine', `spread partial/failed — ${record.error} [${Date.now() - t0}ms]`)
      }
    }
  } catch (err) {
    record.error = (err as Error).message
    log('error', 'ArbEngine', `spread error — ${record.error} [${Date.now() - t0}ms]`)
  } finally {
    _executing.delete(execKey)
    _pendingTradeCount--
    _tradeLog.unshift(record)
    if (_tradeLog.length > 200) _tradeLog = _tradeLog.slice(0, 200)
    saveTradeLog().catch(() => {})
    broadcastState()
  }
}

// ── Buzzer Beater ─────────────────────────────────────────────────────────────
//
// Single-exchange (Polymarket), single-leg, late-window strategy for 5-min markets:
//  1. Sits idle until ≤60s left in the window.
//  2. Locks onto a side only once its ask ≥ 0.95 ("decided").
//  3. Rests a GTC limit BUY at min(best_bid, 0.95) — never crosses the spread,
//     never market-orders. If it fills, cost ≤ 95¢ → ≥5.26% if it resolves to $1.
//  4. Stand-down guard: if the locked side's ask drops back below 0.95 before
//     filling (no longer "decided"), cancels the resting order and stands down
//     instead of buying into a fading market.
//  5. One decision per market window — once filled or stood down, leaves it alone
//     until the next window (detected via a change in expiresAt).

const BUZZER_LOCK_THRESHOLD = 0.95
const BUZZER_WINDOW_SECS = 60
const BUZZER_MIN_SHARES = 5   // Polymarket's per-order share minimum

interface BuzzerState {
  expiresAt: number   // window this state belongs to — a change means the market rotated
  side: 'yes' | 'no' | null
  tokenId: string | null
  orderId: string | null
  status: 'idle' | 'resting' | 'filled' | 'stood_down'
  entryPrice: number | null
  shares: number | null
}

const _buzzerState = new Map<string, BuzzerState>()
const _buzzerExecuting = new Set<string>()

// Polymarket enforces a 5-share minimum per order. At a 95¢ entry, 5 shares ≈ $4.75 —
// so the configured BET_SIZE_USD is a target, not a ceiling: we always buy at least
// BUZZER_MIN_SHARES shares even if that costs more than the configured size.
function calculateBuzzerShares(usdSize: number, price: number): number {
  if (price <= 0) return 0
  return Math.max(usdSize / price, BUZZER_MIN_SHARES)
}

function freshBuzzerState(expiresAt: number): BuzzerState {
  return { expiresAt, side: null, tokenId: null, orderId: null, status: 'idle', entryPrice: null, shares: null }
}

function recordBuzzerFill(key: string, market: PolyMarketInfo, state: BuzzerState): void {
  const asset = assetFromKey(key)
  const direction: 'UP' | 'DOWN' = state.side === 'yes' ? 'UP' : 'DOWN'
  const positionSize = (state.entryPrice ?? 0) * (state.shares ?? 0)
  const record: TradeRecord = {
    id: `${key}-BUZZ-${Date.now()}`, ts: Date.now(), asset, timeframe: '5min', direction,
    profitPct: state.entryPrice ? ((1 - state.entryPrice) / state.entryPrice) * 100 : 0,
    positionSize,
    polyTokenId: state.tokenId ?? '', limSlug: '',
    expiresAt: state.expiresAt, success: true, type: 'buzzer',
    polyEntryPrice: state.entryPrice ?? undefined,
    polySharesHeld: state.shares ?? undefined,
    conditionId: market.conditionId,
  }
  _tradeLog.unshift(record)
  if (_tradeLog.length > 500) _tradeLog.length = 500
  saveTradeLog().catch(() => {})
  log('info', 'ArbEngine', `buzzer ${key}: FILLED — bought ${(state.shares ?? 0).toFixed(2)} ${state.side?.toUpperCase()} @ ${(state.entryPrice ?? 0).toFixed(3)} (~$${positionSize.toFixed(2)}), holding to expiry`)
}

async function runBuzzerCheck(key: string): Promise<void> {
  if (!_settings.buzzerEnabled) return
  if (tfFromKey(key) !== '5min') return
  if (_buzzerExecuting.has(key)) return

  const market = getPolyMarkets().get(key)
  const poly = getPolyAssetPrice(key)
  if (!market || !poly?.yes) return

  const expiresAt = getPolyMarketExpiry(key)
  if (!expiresAt) return
  const now = Date.now()
  const secsToExpiry = Math.floor((expiresAt - now) / 1000)
  if (secsToExpiry < 0) return  // window already closed — wait for rotation

  let state = _buzzerState.get(key)
  if (!state || state.expiresAt !== expiresAt) {
    state = freshBuzzerState(expiresAt)
    _buzzerState.set(key, state)
  }

  // One decision per market — once filled or stood down, leave it alone
  if (state.status === 'filled' || state.status === 'stood_down') return

  // Sits idle until ≤60s left
  if (secsToExpiry > BUZZER_WINDOW_SECS) return

  const yesAsk = poly.yes.ask ?? 0
  const yesBid = poly.yes.bid ?? 0
  const noAsk  = poly.no?.ask ?? (yesBid > 0 ? 1 - yesBid : 0)
  const noBid  = poly.no?.bid ?? (poly.yes.ask != null && poly.yes.ask < 1 ? 1 - poly.yes.ask : 0)

  if (state.status === 'resting') {
    if (!state.orderId || !state.side) { state.status = 'idle'; return }

    // Anti-duplicate: verify the resting order's real status via get_order before acting on it
    const order = await getPolyOrder(state.orderId)
    if (order) {
      if (order.sizeMatched >= order.originalSize - 1e-9 && order.originalSize > 0) {
        state.status = 'filled'
        recordBuzzerFill(key, market, state)
        broadcastState()
        return
      }
      if (/cancel/i.test(order.status)) {
        // Externally cancelled — re-evaluate fresh on the next tick
        state.status = 'idle'
        state.orderId = null
        return
      }
    }

    // Stand-down guard: locked side no longer "decided" — cancel and stand down
    const lockedAsk = state.side === 'yes' ? yesAsk : noAsk
    if (lockedAsk > 0 && lockedAsk < BUZZER_LOCK_THRESHOLD) {
      _buzzerExecuting.add(key)
      try {
        await cancelPolyOrder(state.orderId)
        log('info', 'ArbEngine', `buzzer ${key}: STAND DOWN — ${state.side.toUpperCase()} ask fell to ${lockedAsk.toFixed(3)} (< ${BUZZER_LOCK_THRESHOLD}), cancelled resting order`)
      } catch (err) {
        log('warn', 'ArbEngine', `buzzer ${key}: cancel failed — ${(err as Error).message}`)
      } finally {
        _buzzerExecuting.delete(key)
      }
      state.status = 'stood_down'
      state.orderId = null
      broadcastState()
    }
    return
  }

  // status === 'idle' — look for a side that has become "decided" (ask ≥ 0.95)
  let side: 'yes' | 'no' | null = null
  let ask = 0, bid = 0
  if (yesAsk >= BUZZER_LOCK_THRESHOLD) { side = 'yes'; ask = yesAsk; bid = yesBid }
  else if (noAsk >= BUZZER_LOCK_THRESHOLD) { side = 'no'; ask = noAsk; bid = noBid }
  if (!side) return

  const tokenId = side === 'yes' ? market.yesTokenId : (market.noTokenId ?? market.yesTokenId)
  // Rest the BUY at min(best_bid, 0.95) — never cross the spread, never market-order.
  // Also clamp strictly below the live ask: when the spread is razor-thin near the
  // 0.95 trigger, bid can equal/exceed ask and a postOnly order at that price gets
  // rejected as "crosses book" (it would immediately match the resting sell).
  const restPrice = Math.min(bid > 0 ? bid : BUZZER_LOCK_THRESHOLD, BUZZER_LOCK_THRESHOLD, ask - 0.01)
  if (restPrice <= 0) return
  const shares = calculateBuzzerShares(_settings.buzzerPositionSize, restPrice)
  if (shares <= 0) return

  _buzzerExecuting.add(key)
  try {
    const result = await placePolyLimitOrder(tokenId, 'BUY', restPrice, shares)
    if (result.ok && result.orderId) {
      state.side = side
      state.tokenId = tokenId
      state.orderId = result.orderId
      state.entryPrice = restPrice
      state.shares = shares
      state.status = 'resting'
      log('info', 'ArbEngine', `buzzer ${key}: LOCKED ${side.toUpperCase()} (ask ${ask.toFixed(3)} ≥ ${BUZZER_LOCK_THRESHOLD}) — resting BUY ${shares.toFixed(2)} shares @ ${restPrice.toFixed(3)} (~$${(shares * restPrice).toFixed(2)}), order ${result.orderId.slice(0, 10)}…, ${secsToExpiry}s left`)
    } else {
      log('warn', 'ArbEngine', `buzzer ${key}: limit order rejected — ${JSON.stringify(result.raw).slice(0, 200)}`)
    }
  } catch (err) {
    const msg = (err as Error).message
    // "crosses book" here means our resting BUY (e.g. YES @ 0.01) is mechanically
    // equivalent to a SELL on the complementary token (NO @ 0.99) and matched a
    // resting order there — an independent book whose state we can't see/predict
    // from the YES-side prices we used to compute restPrice. It's a normal
    // collision in this fast-moving final-60s window; we just retry next tick
    // (state stays 'idle'), and LOCKED entries above show it frequently succeeds.
    const benign = /crosses book/i.test(msg)
    log(benign ? 'info' : 'warn', 'ArbEngine', `buzzer ${key}: order ${benign ? 'retry (book moved)' : 'error'} — ${msg}`)
  } finally {
    _buzzerExecuting.delete(key)
    broadcastState()
  }
}

function getBuzzerSnapshot(): Record<string, { status: string; side: string | null; entryPrice: number | null; shares: number | null; secsToExpiry: number }> {
  const now = Date.now()
  const snap: Record<string, { status: string; side: string | null; entryPrice: number | null; shares: number | null; secsToExpiry: number }> = {}
  for (const [key, s] of _buzzerState) {
    if (s.expiresAt < now - 60_000) continue   // drop stale prior-window entries
    snap[key] = { status: s.status, side: s.side, entryPrice: s.entryPrice, shares: s.shares, secsToExpiry: Math.floor((s.expiresAt - now) / 1000) }
  }
  return snap
}

// ── Sports / Esports scanner ──────────────────────────────────────────────────
// Fully standalone discovery pipeline — does not touch crypto markets at all.
// Periodically polls both exchanges for match-winner markets starting soon (or
// already under way), cross-checks candidates by kickoff time + team/player name
// across exchanges, and surfaces two-sided arb opportunities for display (no
// auto-execution — sports markets don't fit the crypto trade-record/redeem/hedge
// pipeline).

let _sportsScanTimer: ReturnType<typeof setInterval> | null = null
let _sportsScanning = false
let _sportsMatched: MatchedSportsEvent[] = []
let _sportsOpportunities: SportsArbOpportunity[] = []

async function runSportsScan(): Promise<void> {
  if (_sportsScanning) return
  _sportsScanning = true
  try {
    const result = await scanSports()
    _sportsMatched = result.matched
    _sportsOpportunities = result.opportunities
    log('info', 'Sports', `scan: poly=${result.polyCount} lim=${result.limCount} matched=${result.matched.length} arbs=${result.opportunities.length}`)
    broadcastState()
  } catch (err) {
    log('warn', 'Sports', `scan error: ${(err as Error).message}`)
  } finally {
    _sportsScanning = false
  }
}

function getSportsSnapshot(): { matched: MatchedSportsEvent[]; opportunities: SportsArbOpportunity[] } {
  return { matched: _sportsMatched, opportunities: _sportsOpportunities }
}

const SPORTS_SCAN_INTERVAL_MS = 30_000

function startSportsScanner(): void {
  if (_sportsScanTimer) return
  runSportsScan().catch(() => {})
  _sportsScanTimer = setInterval(() => runSportsScan().catch(() => {}), SPORTS_SCAN_INTERVAL_MS)
  log('info', 'Sports', 'scanner started')
}

function stopSportsScanner(): void {
  if (_sportsScanTimer) { clearInterval(_sportsScanTimer); _sportsScanTimer = null }
  _sportsMatched = []
  _sportsOpportunities = []
}

// ── Leaderboard Copy-Trading ───────────────────────────────────────────────────
// Fully standalone strategy: the user follows specific wallets from Polymarket's
// public leaderboard, we poll their recent trade activity, surface each new BUY
// as a "signal", and (only when copyTradeAutoExecute is on) replicate it on our
// own account at a fixed USD size. SELL/exit trades are detected but never
// auto-copied — we won't generally hold a matching position to close.

let _copyTradeScanTimer: ReturnType<typeof setInterval> | null = null
let _copyTradeScanning = false
const _copyTradeLastSeen = new Map<string, number>()  // wallet -> latest trade timestamp (unix secs) already processed
const _copyTradeExecuting = new Set<string>()         // in-flight dedupe keys "wallet-asset-timestamp"
let _copyTradeSignals: CopyTradeSignal[] = []
const _traderStatsCache = new Map<string, TraderStats>()
const _traderNameCache = new Map<string, string>()

const COPY_TRADE_STATS_TTL_MS = 5 * 60_000

async function refreshTraderStats(wallet: string): Promise<void> {
  const cached = _traderStatsCache.get(wallet)
  if (cached && Date.now() - cached.updatedAt < COPY_TRADE_STATS_TTL_MS) return
  try {
    _traderStatsCache.set(wallet, await computeTraderStats(wallet))
  } catch (err) {
    logLeaderboardError(`stats ${wallet.slice(0, 10)}…`, err)
  }
}

async function copyTradeReplicate(wallet: string, traderName: string, trade: { side: 'BUY' | 'SELL'; asset: string; conditionId: string; title: string; size: number; price: number; timestamp: number }): Promise<CopyTradeSignal> {
  const signal: CopyTradeSignal = {
    id: `${wallet}-${trade.asset}-${trade.timestamp}`,
    wallet, traderName, ts: Date.now(),
    side: trade.side, asset: trade.asset, conditionId: trade.conditionId,
    title: trade.title, size: trade.size, price: trade.price,
    status: 'detected',
  }

  if (trade.side !== 'BUY') {
    signal.status = 'skipped'
    signal.error = 'sell/exit signals are not auto-copied (no matching position to close)'
    return signal
  }

  if (!_settings.copyTradeAutoExecute) return signal

  try {
    await placePolyOrder(trade.asset, 'BUY', _settings.copyTradePositionSize)
    signal.status = 'executed'
    signal.copiedSize = _settings.copyTradePositionSize
    log('info', 'CopyTrade', `replicated ${traderName} BUY "${trade.title}" — spent $${_settings.copyTradePositionSize.toFixed(2)} on token ${trade.asset.slice(0, 12)}…`)
  } catch (err) {
    signal.status = 'failed'
    signal.error = (err as Error).message
    log('warn', 'CopyTrade', `replicate failed for ${traderName} "${trade.title}": ${(err as Error).message}`)
  }
  return signal
}

async function runCopyTradeScan(): Promise<void> {
  if (_copyTradeScanning) return
  _copyTradeScanning = true
  try {
    for (const wallet of _settings.followedWallets) {
      await refreshTraderStats(wallet)

      let trades: Awaited<ReturnType<typeof fetchTraderTrades>>
      try {
        trades = await fetchTraderTrades(wallet, 15)
      } catch (err) {
        logLeaderboardError(`trades ${wallet.slice(0, 10)}…`, err)
        continue
      }
      if (trades.length === 0) continue

      const traderName = _traderNameCache.get(wallet) ?? `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
      const lastSeen = _copyTradeLastSeen.get(wallet) ?? 0
      // First sighting of this wallet: baseline to its newest trade so we don't
      // replay its whole history as a wave of "new" signals.
      if (lastSeen === 0) {
        _copyTradeLastSeen.set(wallet, Math.max(...trades.map(t => t.timestamp)))
        continue
      }

      const fresh = trades.filter(t => t.timestamp > lastSeen).sort((a, b) => a.timestamp - b.timestamp)
      if (fresh.length === 0) continue
      _copyTradeLastSeen.set(wallet, Math.max(lastSeen, ...fresh.map(t => t.timestamp)))

      for (const trade of fresh) {
        const dedupeKey = `${wallet}-${trade.asset}-${trade.timestamp}`
        if (_copyTradeExecuting.has(dedupeKey)) continue
        _copyTradeExecuting.add(dedupeKey)
        try {
          const signal = await copyTradeReplicate(wallet, traderName, trade)
          _copyTradeSignals.unshift(signal)
          if (_copyTradeSignals.length > 200) _copyTradeSignals.length = 200
        } finally {
          _copyTradeExecuting.delete(dedupeKey)
        }
      }
      broadcastState()
    }
  } catch (err) {
    log('warn', 'CopyTrade', `scan error: ${(err as Error).message}`)
  } finally {
    _copyTradeScanning = false
  }
}

function getCopyTradeSnapshot(): { signals: CopyTradeSignal[]; stats: Record<string, TraderStats> } {
  const stats: Record<string, TraderStats> = {}
  for (const [wallet, s] of _traderStatsCache) stats[wallet] = s
  return { signals: _copyTradeSignals.slice(0, 50), stats }
}

const COPY_TRADE_SCAN_INTERVAL_MS = 60_000

function startCopyTradeScanner(): void {
  if (_copyTradeScanTimer) return
  runCopyTradeScan().catch(() => {})
  _copyTradeScanTimer = setInterval(() => runCopyTradeScan().catch(() => {}), COPY_TRADE_SCAN_INTERVAL_MS)
  log('info', 'CopyTrade', 'scanner started')
}

function stopCopyTradeScanner(): void {
  if (_copyTradeScanTimer) { clearInterval(_copyTradeScanTimer); _copyTradeScanTimer = null }
}

/** Registers (or refreshes) a leaderboard entry's display name for use in copy-trade signals/UI. */
export function cacheTraderName(wallet: string, name: string): void {
  if (wallet && name) _traderNameCache.set(wallet, name)
}

// ── Hedge (close orphaned leg) ────────────────────────────────────────────────

function updateTradeHedgeStatus(id: string, status: TradeRecord['hedgeStatus'], error?: string): void {
  const rec = _tradeLog.find(t => t.id === id)
  if (rec) { rec.hedgeStatus = status; if (error) rec.hedgeError = error }
}

// Returns the best available share count for selling:
// prefers recorded fill (actual tokens received), falls back to price-derived estimate minus fee buffer
// Both legs buy the same number of contracts (N = budget / totalCost).
// Fallback derives N from entry prices when sharesHeld is unavailable (old trades).
function polySharesForSell(positionSize: number, polyEntryPrice: number, limEntryPrice: number, sharesHeld?: number): number {
  const estimate = positionSize / (polyEntryPrice + limEntryPrice)
  // Only use sharesHeld if it's within a reasonable range of the estimate — guards against
  // unit-conversion bugs where tokensReceived comes back 1e6 times too small.
  if (sharesHeld != null && sharesHeld > estimate * 0.1 && sharesHeld < estimate * 5) {
    return sharesHeld * 0.98  // 2% buffer for rounding/partial fills
  }
  return estimate * 0.95  // 5% buffer for fallback estimate
}
function limSharesForSell(positionSize: number, polyEntryPrice: number, limEntryPrice: number, sharesHeld?: number): number {
  const estimate = positionSize / (polyEntryPrice + limEntryPrice)
  // limSharesHeld is always our pre-fee estimate — always apply LIM_FEE so we don't
  // try to sell more tokens than the exchange actually credited after fee deduction.
  const base = (sharesHeld != null && sharesHeld > estimate * 0.1 && sharesHeld < estimate * 5)
    ? sharesHeld : estimate
  return base * (1 - LIM_FEE) * 0.98  // fee + small buffer
}

async function closeOpenLeg(hedge: PendingHedge): Promise<boolean> {
  try {
    if (hedge.openLeg === 'poly') {
      const shares = hedge.directShares != null
        ? hedge.directShares * 0.98
        : polySharesForSell(hedge.positionSize, hedge.polyEntryPrice, hedge.limEntryPrice, hedge.polySharesHeld)
      await placePolyOrder(hedge.polyTokenId, 'SELL', shares)
      // For directShares (spread orphan), limOutcome IS the poly leg's own outcome.
      // For arb hedges, limOutcome is the (failed) lim attempt — poly holds the opposite.
      const polyOutcomeLabel = hedge.directShares != null
        ? hedge.limOutcome.toUpperCase()
        : (hedge.limOutcome === 'no' ? 'YES' : 'NO')
      log('info', 'ArbEngine', `hedge: sold ${shares.toFixed(4)} poly shares (${hedge.asset} ${polyOutcomeLabel})`)
    } else {
      const shares = hedge.directShares != null
        ? hedge.directShares * (1 - LIM_FEE) * 0.98
        : limSharesForSell(hedge.positionSize, hedge.polyEntryPrice, hedge.limEntryPrice, hedge.limSharesHeld)
      await closeLimPosition(hedge.limSlug, hedge.limOutcome, shares)
      log('info', 'ArbEngine', `hedge: sold ${shares.toFixed(4)} lim ${hedge.limOutcome} shares (${hedge.asset})`)
    }
    return true
  } catch (err) {
    log('warn', 'ArbEngine', `hedge attempt failed (${hedge.openLeg}, retry ${hedge.retries}): ${(err as Error).message}`)
    return false
  }
}

async function runHedgeWatchdog(): Promise<void> {
  if (_pendingHedges.length === 0) return
  const now = Date.now()
  const batch = _pendingHedges.splice(0)   // take all, re-add failures below

  for (const hedge of batch) {
    // Market expired — auto-redeem will handle winning tokens; stop retrying
    if (hedge.expiresAt > 0 && now > hedge.expiresAt + 5_000) {
      log('info', 'ArbEngine', `hedge: ${hedge.asset} market expired — leaving for auto-redeem`)
      updateTradeHedgeStatus(hedge.tradeId, 'expired')
      continue
    }
    // Stop retrying 90s before expiry — let auto-redeem handle the winning token
    if (hedge.expiresAt > 0 && now > hedge.expiresAt - 90_000) {
      log('warn', 'ArbEngine', `hedge: ${hedge.asset} <90s to expiry — leaving for auto-redeem`)
      updateTradeHedgeStatus(hedge.tradeId, 'expired')
      continue
    }

    hedge.retries++
    const ok = await closeOpenLeg(hedge)
    if (ok) {
      updateTradeHedgeStatus(hedge.tradeId, 'closed')
    } else {
      _pendingHedges.push(hedge)  // re-queue for next watchdog tick
    }
  }
  if (_pendingHedges.length > 0) broadcastState()
}

// ── Spread orphan-leg watchdog ──────────────────────────────────────────────────
//
// Cross-platform spread trades place the Poly leg first, then the Lim leg — but
// Limitless FOK orders don't reliably confirm a fill (placeLimOrder can return a
// non-throwing response even when nothing actually filled). When that happens,
// `record.success = true` is set even though only one leg is real, leaving an
// unhedged ("orphaned") position that breaks the spread's risk profile.
//
// This periodically re-checks recently-executed open spread trades against the
// real exchange/on-chain balance for each leg. If one leg is empty while the
// other holds a real position, it queues the real leg to be sold via the
// existing hedge-retry mechanism (closeOpenLeg / _pendingHedges / runHedgeWatchdog).

const SPREAD_VERIFY_DELAY_MS = 15_000        // give fills time to settle before checking
const SPREAD_VERIFY_FILL_THRESHOLD = 0.3     // a leg counts as "filled" at >=30% of expected shares

async function verifySpreadTradeLegs(record: TradeRecord, polyPositions: Map<string, number> | null, now: number): Promise<void> {
  // Once the market is close to expiry, stop checking — leave the trade alone and
  // let auto-redeem handle the winning side rather than placing a risky last-second sell.
  if (record.expiresAt > 0 && now > record.expiresAt - 30_000) {
    record.legsVerified = true
    return
  }

  const totalCost = (record.spreadYesAsk ?? 0) + (record.spreadNoAsk ?? 0)
  const estimatedShares = totalCost > 0 ? record.positionSize / totalCost : 0
  const yesExpected = record.spreadYesShares ?? estimatedShares
  const noExpected  = record.spreadNoShares  ?? estimatedShares
  if (yesExpected <= 0.01 && noExpected <= 0.01) {
    record.legsVerified = true  // no reliable expectation to compare against
    return
  }

  const yesTokenId = record.spreadYesPlatform === 'poly' ? record.polyTokenId : ''
  const noTokenId  = record.spreadNoPlatform  === 'poly' ? (record.spreadNoTokenId ?? record.polyTokenId) : ''

  const getActual = async (platform: 'poly' | 'lim' | undefined, tokenId: string, limOutcome: 'yes' | 'no'): Promise<number | null> => {
    if (platform === 'poly') return polyPositions?.get(tokenId) ?? 0
    if (platform === 'lim') return getLimPositionShares(record.limSlug, limOutcome)
    return null
  }

  const [yesActual, noActual] = await Promise.all([
    getActual(record.spreadYesPlatform, yesTokenId, 'yes'),
    getActual(record.spreadNoPlatform, noTokenId, 'no'),
  ])

  // Couldn't determine one of the legs (RPC error, etc.) — try again next tick
  if (yesActual == null || noActual == null) return

  const yesFilled = yesExpected <= 0.01 || yesActual >= yesExpected * SPREAD_VERIFY_FILL_THRESHOLD
  const noFilled  = noExpected  <= 0.01 || noActual  >= noExpected  * SPREAD_VERIFY_FILL_THRESHOLD

  if (yesFilled && noFilled) {
    record.legsVerified = true
    return
  }
  if (!yesFilled && !noFilled) {
    log('warn', 'ArbEngine', `spread ${record.id} (${record.asset}): neither leg shows a real position (expected YES≈${yesExpected.toFixed(3)}, NO≈${noExpected.toFixed(3)}) — leaving as-is`)
    record.legsVerified = true
    return
  }

  // Exactly one leg is missing — the other holds a real, unhedged position. Close it.
  const orphanLeg    = !yesFilled ? 'NO' : 'YES'
  const realPlatform = !yesFilled ? record.spreadNoPlatform : record.spreadYesPlatform
  const realShares   = !yesFilled ? noActual : yesActual
  const realOutcome: 'yes' | 'no' = !yesFilled ? 'no' : 'yes'
  const realTokenId  = !yesFilled ? noTokenId : yesTokenId

  record.legsVerified = true

  if (realShares <= 0.01 || !realPlatform) {
    record.hedgeStatus = 'expired'
    record.hedgeError = `${orphanLeg} leg never filled, and the other leg holds no position either`
    log('warn', 'ArbEngine', `spread ${record.id} (${record.asset}): ${orphanLeg} leg never filled, but the other leg also holds no position — nothing to hedge`)
    return
  }

  log('warn', 'ArbEngine', `spread ${record.id} (${record.asset}): ORPHAN detected — ${orphanLeg} leg never filled, closing real ${realPlatform.toUpperCase()} ${realOutcome.toUpperCase()} position (${realShares.toFixed(4)} shares)`)
  record.hedgeStatus = 'pending'
  record.hedgeError = `${orphanLeg} leg has no position — closing orphaned ${realPlatform} leg`

  const hedge: PendingHedge = {
    tradeId: record.id,
    openLeg: realPlatform,
    asset: record.asset,
    polyTokenId: realTokenId,
    limSlug: record.limSlug,
    limOutcome: realOutcome,
    polyEntryPrice: record.spreadYesAsk ?? 0,
    limEntryPrice: record.spreadNoAsk ?? 0,
    positionSize: record.positionSize,
    expiresAt: record.expiresAt,
    retries: 0,
    firstAttemptTs: now,
    directShares: realShares,
  }

  const closed = await closeOpenLeg(hedge)
  if (closed) {
    updateTradeHedgeStatus(record.id, 'closed')
    log('info', 'ArbEngine', `spread ${record.id}: orphaned ${realPlatform} leg closed`)
  } else {
    _pendingHedges.push(hedge)
    log('warn', 'ArbEngine', `spread ${record.id}: orphan hedge queued for watchdog retry`)
  }
}

async function verifySpreadLegs(): Promise<void> {
  const now = Date.now()
  const candidates = _tradeLog.filter(t =>
    t.type === 'spread' && t.success && !t.earlyExited && !t.legsVerified &&
    now - t.ts >= SPREAD_VERIFY_DELAY_MS
  )
  if (candidates.length === 0) return

  let polyPositions: Map<string, number> | null = null
  if (candidates.some(t => t.spreadYesPlatform === 'poly' || t.spreadNoPlatform === 'poly')) {
    polyPositions = new Map()
    for (const p of await getPolyPositions()) {
      const raw = p as Record<string, unknown>
      const tokenId = String(raw['tokenId'] ?? raw['asset_id'] ?? raw['asset'] ?? '')
      if (tokenId) polyPositions.set(tokenId, parseFloat(String(raw['size'] ?? '0')))
    }
  }

  for (const record of candidates) {
    try {
      await verifySpreadTradeLegs(record, polyPositions, now)
    } catch (err) {
      log('warn', 'ArbEngine', `verifySpreadLegs ${record.id}: ${(err as Error).message}`)
    }
  }
  saveTradeLog().catch(() => {})
  broadcastState()
}

// ── Execution ──────────────────────────────────────────────────────────────────

async function executeArb(opp: ArbOpportunity): Promise<void> {
  if (_executing.has(opp.key)) return

  // Don't enter a trade with less than 60 seconds left in the window
  if (opp.secsToExpiry < 60) {
    log('info', 'ArbEngine', `skip ${opp.key} — only ${opp.secsToExpiry}s to expiry`)
    return
  }

  // Safety net: reject zero/near-zero leg prices (should have been caught by detectArb,
  // but guards against stale data races between detection and execution)
  if (opp.polyAsk < 0.03 || opp.limOpposite < 0.03) {
    log('warn', 'ArbEngine', `skip ${opp.key} — near-zero leg price (poly=${opp.polyAsk.toFixed(3)}, lim=${opp.limOpposite.toFixed(3)}) — expiry distortion`)
    return
  }

  const now = Date.now()

  // Don't enter if we already hold an open arb on this exact market key in this window
  const alreadyOpen = _tradeLog.some(t => {
    const tradeKey = t.timeframe ? `${t.asset}-${t.timeframe}` : `${t.asset}-5min`
    return (t.success || t.hedgeStatus === 'pending') && !t.earlyExited &&
           tradeKey === opp.key && t.expiresAt > now && !t.type
  })
  if (alreadyOpen) return

  // Enforce max concurrent open trades — also count partial fills (hedgeStatus==='pending')
  const openCount = _tradeLog.filter(t =>
    (t.success || t.hedgeStatus === 'pending') && !t.earlyExited && t.expiresAt > now
  ).length + _pendingTradeCount
  if (openCount >= _settings.maxOpenTrades) {
    log('info', 'ArbEngine', `skip ${opp.key} — ${openCount}/${_settings.maxOpenTrades} trades already open`)
    return
  }

  _executing.add(opp.key)
  _pendingTradeCount++

  const id = `${opp.key}-${Date.now()}`
  // UP arb: buy YES on Poly + buy NO on Lim (both resolve to $1 total)
  // DOWN arb: buy NO on Poly + buy YES on Lim (both resolve to $1 total)
  const limOutcome = opp.direction === 'UP' ? 'no' : 'yes'

  // Equal-token sizing: buy the same number of contracts on each exchange so one side
  // always pays back the full budget regardless of which outcome wins.
  // Poly enforces a $1 minimum per order — scale up contracts to meet it if needed.
  const POLY_MIN_ORDER = 1.00
  const contractsFromBudget = _settings.maxPositionSize / opp.totalCost
  const contractsForPolyMin = POLY_MIN_ORDER / opp.polyAsk
  const contracts = Math.max(contractsFromBudget, contractsForPolyMin)
  // Clamp to at least POLY_MIN_ORDER — floating-point multiply can give 0.9999... instead of 1.00
  const polyUSDC  = Math.max(Math.round(contracts * opp.polyAsk * 1e6) / 1e6, POLY_MIN_ORDER)
  const limUSDC   = Math.round(contracts * opp.limOpposite * 1e6) / 1e6  // Lim: max 6 decimal places

  const totalSpend = polyUSDC + limUSDC
  if (totalSpend > _settings.maxPositionSize) {
    log('info', 'ArbEngine', `${opp.key} — bumping position to $${totalSpend.toFixed(2)} (Poly $1 min forces ${contracts.toFixed(2)} contracts, budget was $${_settings.maxPositionSize})`)
  }

  const expiryUTC = opp.expiresAt ? new Date(opp.expiresAt).toISOString().slice(11, 16) + 'Z' : '?'
  log('info', 'ArbEngine', `executing ${opp.key} ${opp.direction}: profit ${opp.profitPct.toFixed(2)}% | ${opp.secsToExpiry}s left | window ${expiryUTC} | ${contracts.toFixed(3)} contracts (poly $${polyUSDC.toFixed(2)} @ ${opp.polyAsk.toFixed(3)} / lim $${limUSDC.toFixed(2)} @ ${opp.limOpposite.toFixed(3)}) total $${totalSpend.toFixed(2)}`)

  const record: TradeRecord = {
    id, ts: Date.now(), asset: opp.asset, timeframe: opp.timeframe, direction: opp.direction,
    profitPct: opp.profitPct, positionSize: totalSpend,  // actual spend across both legs
    polyTokenId: opp.polyTokenId, limSlug: opp.limSlug,
    expiresAt: opp.expiresAt, success: false,
    polyEntryPrice: opp.polyAsk,
    limEntryPrice: opp.limOpposite,
    conditionId: getPolyMarkets().get(opp.key)?.conditionId,
    polySharesHeld: contracts,   // initial estimate — overridden by actual fill below
    limSharesHeld: contracts,
  }

  const t0 = Date.now()
  try {
    // Place both legs concurrently — cuts total order latency roughly in half
    const [polySettled, limSettled] = await Promise.allSettled([
      placePolyOrder(opp.polyTokenId, 'BUY', polyUSDC),
      placeLimOrder(opp.limSlug, limOutcome, limUSDC),
    ])

    const polyOk = polySettled.status === 'fulfilled'
    const limOk  = limSettled.status === 'fulfilled'

    if (polyOk) {
      const polyFill = (polySettled as PromiseFulfilledResult<PolyOrderResult>).value
      record.polyResult = polyFill.raw
      if (polyFill.tokensReceived != null && polyFill.tokensReceived > 0)
        record.polySharesHeld = polyFill.tokensReceived
    } else {
      record.polyResult = ((polySettled as PromiseRejectedResult).reason as Error).message
    }
    if (limOk) {
      record.limResult = (limSettled as PromiseFulfilledResult<unknown>).value
    } else {
      record.limResult = ((limSettled as PromiseRejectedResult).reason as Error).message
    }

    const elapsedMs = Date.now() - t0

    if (polyOk && limOk) {
      record.success = true
      log('info', 'ArbEngine', `trade success — ${opp.key} ${opp.direction} +${opp.profitPct.toFixed(2)}% [${elapsedMs}ms]`)
    } else if (!polyOk && !limOk) {
      record.error = `both legs failed — Poly: ${record.polyResult} / Lim: ${record.limResult}`
      log('warn', 'ArbEngine', `trade aborted — ${record.error} [${elapsedMs}ms]`)
    } else if (polyOk && !limOk) {
      record.error = `Lim: ${record.limResult}`
      record.hedgeStatus = 'pending'
      log('warn', 'ArbEngine', `trade failed — Poly filled, Lim failed: ${record.error} — hedging Poly [${elapsedMs}ms]`)
      const hedge: PendingHedge = {
        tradeId: id, openLeg: 'poly', asset: opp.asset,
        polyTokenId: opp.polyTokenId, limSlug: opp.limSlug, limOutcome,
        polyEntryPrice: opp.polyAsk, limEntryPrice: opp.limOpposite,
        polySharesHeld: record.polySharesHeld ?? contracts, limSharesHeld: contracts,
        positionSize: _settings.maxPositionSize, expiresAt: opp.expiresAt,
        retries: 0, firstAttemptTs: Date.now(),
      }
      const closed = await closeOpenLeg(hedge)
      if (closed) { record.hedgeStatus = 'closed'; log('info', 'ArbEngine', `hedge: Poly leg closed immediately`) }
      else { _pendingHedges.push(hedge); log('warn', 'ArbEngine', `hedge: queued for watchdog retry`) }
    } else {
      // !polyOk && limOk — Poly failed, Lim filled → hedge Lim
      record.error = `Poly: ${record.polyResult}`
      record.hedgeStatus = 'pending'
      log('warn', 'ArbEngine', `trade failed — Lim filled, Poly failed: ${record.error} — hedging Lim [${elapsedMs}ms]`)
      const hedge: PendingHedge = {
        tradeId: id, openLeg: 'lim', asset: opp.asset,
        polyTokenId: opp.polyTokenId, limSlug: opp.limSlug, limOutcome,
        polyEntryPrice: opp.polyAsk, limEntryPrice: opp.limOpposite,
        polySharesHeld: contracts, limSharesHeld: contracts,
        positionSize: _settings.maxPositionSize, expiresAt: opp.expiresAt,
        retries: 0, firstAttemptTs: Date.now(),
      }
      const closed = await closeOpenLeg(hedge)
      if (closed) { record.hedgeStatus = 'closed'; log('info', 'ArbEngine', `hedge: Lim leg closed immediately`) }
      else { _pendingHedges.push(hedge); log('warn', 'ArbEngine', `hedge: queued for watchdog retry`) }
    }
  } catch (err) {
    record.error = (err as Error).message
    log('error', 'ArbEngine', `trade error — ${record.error} [${Date.now() - t0}ms]`)
  } finally {
    _executing.delete(opp.key)
    _pendingTradeCount--
    _tradeLog.unshift(record)
    if (_tradeLog.length > 200) _tradeLog = _tradeLog.slice(0, 200)
    saveTradeLog().catch(() => {})
    broadcastState()
  }
}

// ── Early exit ────────────────────────────────────────────────────────────────
//
// For an open arb, we hold polyShares = positionSize / polyEntryPrice on Poly
// and limShares = positionSize / limEntryPrice on Lim.  If we sell both legs at
// current bid prices the net P&L might already exceed minProfitPct — no reason
// to wait until expiry.

const _earlyExiting = new Set<string>()   // trade IDs currently being closed

export function computeExitPnLPct(trade: TradeRecord): number | null {
  if (!trade.polyEntryPrice || !trade.limEntryPrice) return null
  const key = trade.timeframe ? `${trade.asset}-${trade.timeframe}` : `${trade.asset}-5min`
  const poly = getPolyAssetPrice(key)
  const lim  = getLimAssetPrice(key)
  if (!poly?.yes || !lim) return null

  // Derive contracts from positionSize and entry prices — most reliable source since
  // polySharesHeld may be in wrong units if the Poly API response format changes.
  const totalCostPerUnit = trade.polyEntryPrice + trade.limEntryPrice
  if (totalCostPerUnit <= 0) return null
  const contracts = trade.positionSize / totalCostPerUnit

  let polyBid: number, limBid: number
  if (trade.direction === 'UP') {
    // Holding: Poly YES + Lim NO
    polyBid = poly.yes.bid ?? 0
    limBid  = lim.noBid != null && lim.noBid > 0 ? lim.noBid : (lim.ask > 0 && lim.ask < 1 ? 1 - lim.ask : 0)
  } else {
    // Holding: Poly NO + Lim YES
    polyBid = poly.no?.bid ?? (poly.yes.ask != null && poly.yes.ask < 1 ? 1 - poly.yes.ask : 0)
    limBid  = lim.bid
  }
  if (polyBid <= 0 || limBid <= 0) return null

  // Subtract exit fees on both legs so the result is net profit
  const exitRevenue = contracts * (polyBid * (1 - POLY_FEE) + limBid * (1 - LIM_FEE))
  const entryCost   = trade.positionSize
  return ((exitRevenue - entryCost) / entryCost) * 100
}

function computeXtfExitPnL(trade: TradeRecord): number | null {
  if (!trade.xtfShortKey || !trade.xtfLongKey) return null
  if (!trade.xtfShortOutcome || !trade.xtfLongOutcome) return null
  const shortContracts = trade.xtfShortSharesHeld ?? 0
  const longContracts  = trade.xtfLongSharesHeld  ?? 0
  if (shortContracts <= 0 && longContracts <= 0) return null

  const shortBid = getBidPrice(trade.xtfShortKey, trade.xtfShortExchange ?? 'poly', trade.xtfShortOutcome)
  const longBid  = getBidPrice(trade.xtfLongKey,  trade.xtfLongExchange  ?? 'poly', trade.xtfLongOutcome)
  if (shortBid == null || longBid == null || shortBid <= 0 || longBid <= 0) return null

  const revenue = shortContracts * shortBid + longContracts * longBid
  return ((revenue - trade.positionSize) / trade.positionSize) * 100
}

async function executeEarlyExit(trade: TradeRecord): Promise<void> {
  if (_earlyExiting.has(trade.id)) return
  _earlyExiting.add(trade.id)

  const polyShares = polySharesForSell(trade.positionSize, trade.polyEntryPrice!, trade.limEntryPrice!, trade.polySharesHeld)
  const limOutcome: 'yes' | 'no' = trade.direction === 'UP' ? 'no' : 'yes'
  const limShares  = limSharesForSell(trade.positionSize, trade.polyEntryPrice!, trade.limEntryPrice!, trade.limSharesHeld)
  const exitPnLPct = computeExitPnLPct(trade) ?? 0

  log('info', 'ArbEngine', `early exit ${trade.asset} ${trade.direction}: realised P&L ${exitPnLPct.toFixed(2)}% — selling ${polyShares.toFixed(4)} poly + ${limShares.toFixed(4)} lim ${limOutcome}`)

  try {
    const [polyRes, limRes] = await Promise.allSettled([
      placePolyOrder(trade.polyTokenId, 'SELL', polyShares),
      closeLimPosition(trade.limSlug, limOutcome, limShares),
    ])

    const polyOk = polyRes.status === 'fulfilled'
    const limOk  = limRes.status === 'fulfilled'
    if (polyOk && limOk) {
      trade.earlyExited    = true
      trade.earlyExitPnLPct = exitPnLPct
      log('info', 'ArbEngine', `early exit success — ${trade.asset} +${exitPnLPct.toFixed(2)}%`)
    } else {
      const errs = [
        !polyOk ? `Poly: ${(polyRes as PromiseRejectedResult).reason}` : '',
        !limOk  ? `Lim: ${(limRes as PromiseRejectedResult).reason}`   : '',
      ].filter(Boolean).join(' | ')
      log('warn', 'ArbEngine', `early exit partial failure — ${errs}`)

      // If Poly rejected due to insufficient balance, extract the actual balance from the
      // error message and update polySharesHeld so the next attempt uses the correct amount.
      if (!polyOk) {
        const polyErr = String((polyRes as PromiseRejectedResult).reason)
        const balanceMatch = /balance[:\s]+(\d+)/i.exec(polyErr)
        if (balanceMatch) {
          const actualTokens = parseInt(balanceMatch[1]) / 1e6
          if (actualTokens > 0 && actualTokens < (trade.polySharesHeld ?? Infinity)) {
            log('info', 'ArbEngine', `correcting polySharesHeld: ${trade.polySharesHeld?.toFixed(4)} → ${actualTokens.toFixed(6)} (from error)`)
            trade.polySharesHeld = actualTokens
          }
        }
      }

      // 30s cooldown — prevent hammering the exchanges on every price tick
      trade.exitCooldownUntil = Date.now() + 30_000

      if (polyOk !== limOk) {
        const openLeg: 'poly' | 'lim' = polyOk ? 'lim' : 'poly'
        log('warn', 'ArbEngine', `early exit: ${openLeg} sell failed — position will resolve at expiry`)
      }
    }
  } finally {
    _earlyExiting.delete(trade.id)
    saveTradeLog().catch(() => {})
    broadcastState()
  }
}

const _earlyExitingXtf = new Set<string>()  // trade IDs

async function executeXtfEarlyExit(trade: TradeRecord): Promise<void> {
  if (_earlyExitingXtf.has(trade.id)) return
  _earlyExitingXtf.add(trade.id)

  const exitPnLPct = computeXtfExitPnL(trade) ?? 0
  const shortShares = trade.xtfShortSharesHeld ?? 0
  const longShares  = trade.xtfLongSharesHeld  ?? 0

  log('info', 'ArbEngine', `XTF early exit ${trade.id}: P&L ${exitPnLPct.toFixed(2)}% — short ${shortShares.toFixed(4)} ${trade.xtfShortKey} + long ${longShares.toFixed(4)} ${trade.xtfLongKey}`)

  try {
    const shortSell = trade.xtfShortExchange === 'poly'
      ? placePolyOrder(trade.xtfShortTokenId!, 'SELL', shortShares)
      : closeLimPosition(trade.xtfShortLimSlug!, trade.xtfShortOutcome!, shortShares)

    const longSell = trade.xtfLongExchange === 'poly'
      ? placePolyOrder(trade.xtfLongTokenId!, 'SELL', longShares)
      : closeLimPosition(trade.xtfLongLimSlug!, trade.xtfLongOutcome!, longShares)

    const [shortRes, longRes] = await Promise.allSettled([shortSell, longSell])
    const bothOk = shortRes.status === 'fulfilled' && longRes.status === 'fulfilled'

    if (bothOk) {
      trade.earlyExited     = true
      trade.earlyExitPnLPct = exitPnLPct
      log('info', 'ArbEngine', `XTF exit success ${trade.id} +${exitPnLPct.toFixed(2)}%`)
    } else {
      const errs = [
        shortRes.status === 'rejected' ? `short: ${shortRes.reason}` : '',
        longRes.status  === 'rejected' ? `long: ${longRes.reason}`   : '',
      ].filter(Boolean).join(' | ')
      log('warn', 'ArbEngine', `XTF exit partial failure ${trade.id} — ${errs}`)
      trade.exitCooldownUntil = Date.now() + 30_000
    }
  } finally {
    _earlyExitingXtf.delete(trade.id)
    saveTradeLog().catch(() => {})
    broadcastState()
  }
}

async function executeXtfTrade(opp: XtfOpportunity): Promise<void> {
  const id = `${opp.asset}-XTF-${opp.shortKey.split('-')[1]}-${opp.longKey.split('-')[1]}-${Date.now()}`
  if (_executing.has(`xtf-${opp.asset}`)) return

  const now = Date.now()
  const openCount = _tradeLog.filter(t =>
    (t.success || t.hedgeStatus === 'pending') && !t.earlyExited && t.expiresAt > now
  ).length + _pendingTradeCount
  if (openCount >= _settings.maxOpenTrades) return

  _executing.add(`xtf-${opp.asset}`)
  _pendingTradeCount++

  const POLY_MIN = 1.00
  const contractsFromBudget  = _settings.maxPositionSize / opp.totalCost
  const contractsForPolyMin  = opp.shortExchange === 'poly' || opp.longExchange === 'poly'
    ? POLY_MIN / Math.max(opp.shortExchange === 'poly' ? opp.shortAsk : 0, opp.longExchange === 'poly' ? opp.longAsk : 0)
    : 0
  const contracts = Math.max(contractsFromBudget, contractsForPolyMin)
  const shortUSDC = Math.max(Math.round(contracts * opp.shortAsk * 1e6) / 1e6, opp.shortExchange === 'poly' ? POLY_MIN : 0)
  const limShortUSDC = Math.round(contracts * opp.shortAsk * 1e6) / 1e6
  const longUSDC  = Math.max(Math.round(contracts * opp.longAsk  * 1e6) / 1e6, opp.longExchange  === 'poly' ? POLY_MIN : 0)
  const limLongUSDC = Math.round(contracts * opp.longAsk * 1e6) / 1e6

  log('info', 'ArbEngine', `XTF executing ${opp.asset}: ${opp.shortKey}(${opp.shortOutcome}@${opp.shortAsk.toFixed(3)}) + ${opp.longKey}(${opp.longOutcome}@${opp.longAsk.toFixed(3)}) gap=${opp.gapPct.toFixed(1)}% est=${opp.profitPct.toFixed(1)}%`)

  const record: TradeRecord = {
    id, ts: Date.now(), asset: opp.asset, timeframe: tfFromKey(opp.shortKey),
    direction: opp.shortOutcome === 'no' ? 'UP' : 'DOWN',
    profitPct: opp.profitPct, positionSize: contracts * opp.totalCost,
    polyTokenId: opp.shortExchange === 'poly' ? opp.shortTokenId : (opp.longExchange === 'poly' ? opp.longTokenId : ''),
    limSlug: opp.shortExchange === 'lim' ? opp.shortLimSlug : (opp.longExchange === 'lim' ? opp.longLimSlug : ''),
    expiresAt: opp.expiresAt, success: false,
    type: 'xtf',
    xtfShortKey: opp.shortKey, xtfLongKey: opp.longKey,
    xtfShortExchange: opp.shortExchange, xtfLongExchange: opp.longExchange,
    xtfShortOutcome: opp.shortOutcome, xtfLongOutcome: opp.longOutcome,
    xtfShortEntryPrice: opp.shortAsk, xtfLongEntryPrice: opp.longAsk,
    xtfShortTokenId: opp.shortTokenId, xtfShortLimSlug: opp.shortLimSlug,
    xtfLongTokenId: opp.longTokenId, xtfLongLimSlug: opp.longLimSlug,
  }

  try {
    // Place short leg
    const shortPromise = opp.shortExchange === 'poly'
      ? placePolyOrder(opp.shortTokenId, 'BUY', shortUSDC)
      : placeLimOrder(opp.shortLimSlug, opp.shortOutcome, limShortUSDC)

    // Place long leg
    const longPromise = opp.longExchange === 'poly'
      ? placePolyOrder(opp.longTokenId, 'BUY', longUSDC)
      : placeLimOrder(opp.longLimSlug, opp.longOutcome, limLongUSDC)

    const [shortRes, longRes] = await Promise.allSettled([shortPromise, longPromise])

    const shortOk = shortRes.status === 'fulfilled'
    const longOk  = longRes.status === 'fulfilled'

    if (shortOk && longOk) {
      record.success = true
      record.xtfShortSharesHeld = contracts
      record.xtfLongSharesHeld  = contracts
      // Override with actual fill if available (Poly BUY returns tokensReceived)
      if (opp.shortExchange === 'poly' && shortRes.status === 'fulfilled') {
        const pr = shortRes.value as PolyOrderResult
        if (pr.tokensReceived != null && pr.tokensReceived > 0) record.xtfShortSharesHeld = pr.tokensReceived
      }
      if (opp.longExchange === 'poly' && longRes.status === 'fulfilled') {
        const pr = longRes.value as PolyOrderResult
        if (pr.tokensReceived != null && pr.tokensReceived > 0) record.xtfLongSharesHeld = pr.tokensReceived
      }
      log('info', 'ArbEngine', `XTF opened: ${id} short=${record.xtfShortSharesHeld?.toFixed(4)} long=${record.xtfLongSharesHeld?.toFixed(4)}`)
    } else {
      const errs = [
        !shortOk ? `short(${opp.shortKey}): ${(shortRes as PromiseRejectedResult).reason}` : '',
        !longOk  ? `long(${opp.longKey}): ${(longRes as PromiseRejectedResult).reason}` : '',
      ].filter(Boolean).join(' | ')
      record.error = errs
      log('warn', 'ArbEngine', `XTF trade failed — ${errs}`)
    }
  } finally {
    _executing.delete(`xtf-${opp.asset}`)
    _pendingTradeCount--
    _tradeLog.unshift(record)
    if (_tradeLog.length > 500) _tradeLog.length = 500
    saveTradeLog().catch(() => {})
    broadcastState()
  }
}

function checkAllEarlyExits(): void {
  if (!_running || !_settings.autoExit) return
  const now = Date.now()
  for (const trade of _tradeLog) {
    if (!trade.success || trade.type === 'signal' || trade.type === 'xtf') continue  // only arb trades
    if (trade.earlyExited) continue                               // already closed
    if (_earlyExiting.has(trade.id)) continue                     // in-flight
    if (trade.exitCooldownUntil && now < trade.exitCooldownUntil) continue  // cooling down after failure
    if (trade.expiresAt > 0 && trade.expiresAt <= now) continue  // expired — let redeem handle it
    if (trade.expiresAt > 0 && trade.expiresAt - now < 30_000) continue  // <30s left, let it expire

    const pnl = computeExitPnLPct(trade)
    if (pnl != null && pnl >= _settings.minProfitPct) {
      executeEarlyExit(trade).catch(err => log('warn', 'ArbEngine', `early exit error: ${(err as Error).message}`))
    }
  }

  // XTF early exits
  for (const trade of _tradeLog) {
    if (trade.type !== 'xtf' || !trade.success || trade.earlyExited) continue
    if (_earlyExitingXtf.has(trade.id)) continue
    if (trade.exitCooldownUntil && now < trade.exitCooldownUntil) continue
    if (trade.expiresAt > 0 && trade.expiresAt <= now) continue
    if (trade.expiresAt > 0 && trade.expiresAt - now < 30_000) continue
    const pnl = computeXtfExitPnL(trade)
    if (pnl != null && pnl >= _settings.minProfitPct) {
      executeXtfEarlyExit(trade).catch(err => log('warn', 'ArbEngine', `XTF exit error: ${(err as Error).message}`))
    }
  }
}

export async function triggerManualEarlyExit(tradeId: string): Promise<{ ok: boolean; error?: string }> {
  const trade = _tradeLog.find(t => t.id === tradeId)
  if (!trade) return { ok: false, error: 'Trade not found' }
  if (!trade.success || trade.earlyExited) return { ok: false, error: 'Trade not eligible for early exit' }
  if (!trade.polyEntryPrice || !trade.limEntryPrice) return { ok: false, error: 'Entry prices not recorded — cannot compute shares' }
  executeEarlyExit(trade).catch(() => {})
  return { ok: true }
}

// ── Broadcast ──────────────────────────────────────────────────────────────────

function broadcastState(): void {
  if (_broadcastTimer) return
  _broadcastTimer = setTimeout(() => {
    _broadcastTimer = null
    const now = Date.now()
    const assets: Record<string, unknown> = {}
    for (const key of ALL_MARKET_KEYS) {
      const poly = getPolyAssetPrice(key)
      const lim  = getLimAssetPrice(key)
      const opp  = detectArb(key)
      const polyExp = getPolyMarketExpiry(key)
      const limExp  = getLimMarketExpiry(key)
      const kTf = tfFromKey(key)
      const wTolMs = kTf === '5min' ? 2*60_000 : kTf === '15min' ? 5*60_000 : 10*60_000
      const windowMismatch = polyExp && limExp && Math.abs(polyExp - limExp) > wTolMs
      const expiresAt = polyExp && limExp
        ? (windowMismatch ? Math.max(polyExp, limExp) : Math.min(polyExp, limExp))
        : (polyExp || limExp || 0)
      const sig = detectSignal(key)
      // Find the most recent open arb trade for this market key (if any)
      const openTrade = _tradeLog.find(t => {
        const tradeKey = t.timeframe ? `${t.asset}-${t.timeframe}` : `${t.asset}-5min`
        return t.success && !t.earlyExited && tradeKey === key && t.expiresAt > now && !t.type
      })
      const exitPnLPct = openTrade ? computeExitPnLPct(openTrade) : null
      assets[key] = {
        poly: poly ? { yesAsk: poly.yes?.ask ?? null, yesBid: poly.yes?.bid ?? null, noAsk: poly.no?.ask ?? null, noBid: poly.no?.bid ?? null } : null,
        lim:  lim  ? { yesAsk: lim.ask, yesBid: lim.bid, noAsk: lim.noAsk ?? null, noBid: lim.noBid ?? null } : null,
        opportunity: opp ? { direction: opp.direction, profitPct: opp.profitPct, totalCost: opp.totalCost, netProfit: opp.netProfit, secsToExpiry: opp.secsToExpiry } : null,
        signal: sig ? { direction: sig.direction, exchange: sig.exchange, entryPrice: sig.entryPrice, confidence: sig.confidence, evPct: sig.evPct, gapPct: sig.gapPct } : null,
        openTrade: openTrade ? { id: openTrade.id, direction: openTrade.direction, positionSize: openTrade.positionSize, entryProfitPct: openTrade.profitPct, exitPnLPct } : null,
        expiresAt,
      }
    }
    const xtfOpportunities = CRYPTO_ASSETS.flatMap(a => detectXtfOpportunities(a)).slice(0, 10)
    const xassetOpportunities = detectXAssetOpportunities().slice(0, 10)
    wsHub.broadcastAll({
      type: 'arb.state',
      assets,
      xtf: xtfOpportunities,
      xasset: xassetOpportunities,
      spread: scanSpreadOpportunities().slice(0, 10),
      buzzer: getBuzzerSnapshot(),
      apiCalls: getApiCallStats(),
      sports: getSportsSnapshot(),
      copyTrade: getCopyTradeSnapshot(),
      engine: { running: _running, autoExecute: _settings.autoExecute, minProfitPct: _settings.minProfitPct, mode: _settings.mode, signalMinGapPct: _settings.signalMinGapPct, xtfEnabled: _settings.xtfEnabled, xtfMinGapPct: _settings.xtfMinGapPct, xAssetEnabled: _settings.xAssetEnabled, xAssetMinGapPct: _settings.xAssetMinGapPct, autoExit: _settings.autoExit, buzzerEnabled: _settings.buzzerEnabled, buzzerAutoExecute: _settings.buzzerAutoExecute, buzzerPositionSize: _settings.buzzerPositionSize, sportEnabled: _settings.sportEnabled, cryptoEnabled: _settings.cryptoEnabled, copyTradeEnabled: _settings.copyTradeEnabled, copyTradeAutoExecute: _settings.copyTradeAutoExecute, copyTradePositionSize: _settings.copyTradePositionSize, followedWallets: _settings.followedWallets, spreadEnabled: _settings.spreadEnabled, spreadAutoExecute: _settings.spreadAutoExecute, spreadPositionSize: _settings.spreadPositionSize, spreadMinGapPct: _settings.spreadMinGapPct, spreadPlatform: _settings.spreadPlatform, spreadTimeframes: _settings.spreadTimeframes },
      ts: Date.now(),
    })
  }, 200)
}

// ── Price update handlers ──────────────────────────────────────────────────────

function onPriceUpdate(key: string): void {
  if (!_running) return
  broadcastState()
  // Buzzer Beater is a fully standalone strategy — gated by its own enable + auto-execute
  // switches, completely independent of the shared `autoExecute` / `mode` used by arb/signal.
  // Standalone strategies — fully independent of the master autoExecute / mode switches
  if (_settings.buzzerEnabled && _settings.buzzerAutoExecute) {
    runBuzzerCheck(key).catch(err => log('warn', 'ArbEngine', `buzzer ${key} error: ${(err as Error).message}`))
  }
  if (_settings.spreadEnabled && _settings.spreadAutoExecute && _settings.spreadTimeframes.includes(tfFromKey(key))) {
    const spreadOpp = detectSpread(key)
    if (spreadOpp && spreadOpp.spreadPct >= _settings.spreadMinGapPct) {
      executeSpreadTrade(spreadOpp).catch(err => log('warn', 'ArbEngine', `Spread execute error: ${(err as Error).message}`))
    }
  }

  // ARB / Signal / XTF / XAsset — gated by master AUTO button
  if (!_settings.autoExecute) return
  if (_settings.mode === 'arb' || _settings.mode === 'both') {
    const opp = detectArb(key)
    if (opp) executeArb(opp).catch(() => {})
  }
  if (_settings.mode === 'signal' || _settings.mode === 'both') {
    const sig = detectSignal(key)
    if (sig) executeSignal(sig).catch(() => {})
  }
  if (_settings.xtfEnabled) {
    const asset = assetFromKey(key)
    const xtfOpps = detectXtfOpportunities(asset)
    const best = xtfOpps[0]
    if (best && best.profitPct >= _settings.minProfitPct) {
      executeXtfTrade(best).catch(err => log('warn', 'ArbEngine', `XTF execute error: ${(err as Error).message}`))
    }
  }
  if (_settings.xAssetEnabled) {
    const xassetOpps = detectXAssetOpportunities()
    const bestXa = xassetOpps[0]
    if (bestXa && bestXa.evPct >= _settings.minProfitPct) {
      executeXAssetTrade(bestXa).catch(err => log('warn', 'ArbEngine', `XAsset execute error: ${(err as Error).message}`))
    }
  }
}

// ── Market refresh ────────────────────────────────────────────────────────────

let _retryRefreshTimer: ReturnType<typeof setTimeout> | null = null
let _redeemTimer: ReturnType<typeof setInterval> | null = null
let _hedgeTimer: ReturnType<typeof setInterval> | null = null
let _earlyExitTimer: ReturnType<typeof setInterval> | null = null
let _legCheckTimer: ReturnType<typeof setInterval> | null = null
const _pendingHedges: PendingHedge[] = []

async function refreshMarkets(): Promise<void> {
  if (_retryRefreshTimer) { clearTimeout(_retryRefreshTimer); _retryRefreshTimer = null }

  await Promise.allSettled([fetchPolyMarkets(), fetchLimMarkets()])

  // Check if we actually got fresh (non-expired) markets on both sides
  const now = Date.now()
  const polyFresh = [...getPolyMarkets().values()].some(m => m.expiresAt > now)
  const limFresh  = [...getLimMarkets().values()].some(m => m.expiresAt > now)

  // Keep LIM WS subscribed to fresh slugs even when Poly is down — prevents LIM price expiry cascade
  if (limFresh && !polyFresh) startLimWs(onPriceUpdate).catch(() => {})

  if (!polyFresh || !limFresh) {
    // New window not published yet — retry in 15s without resetting WS
    log('info', 'ArbEngine', `markets not ready yet (poly=${polyFresh}, lim=${limFresh}), retrying in 15s`)
    _retryRefreshTimer = setTimeout(() => refreshMarkets().catch(() => {}), 15_000)
    return
  }

  await Promise.allSettled([startPolyWs(onPriceUpdate), startLimWs(onPriceUpdate)])
  broadcastState()
  log('info', 'ArbEngine', `markets refreshed — poly=${getPolyMarkets().size} lim=${getLimMarkets().size}`)

  // Exchanges may publish new markets staggered — if we got a partial set, top-up shortly
  const expected = ALL_MARKET_KEYS.length
  if (getLimMarkets().size < expected || getPolyMarkets().size < expected) {
    log('info', 'ArbEngine', `partial markets (poly=${getPolyMarkets().size} lim=${getLimMarkets().size}/${expected}) — topping up in 30s`)
    if (!_retryRefreshTimer) _retryRefreshTimer = setTimeout(() => refreshMarkets().catch(() => {}), 30_000)
  }
}

function scheduleNextRefresh(): void {
  if (_refreshTimer) clearInterval(_refreshTimer)
  // Align to the next 5-min boundary + 8s buffer for exchanges to publish
  const now = new Date()
  const secToNextBoundary = (5 - (now.getMinutes() % 5)) * 60 - now.getSeconds() + 8
  const msToNext = Math.max(secToNextBoundary * 1000, 30_000)
  // Recurring interval aligned to boundaries
  setTimeout(() => {
    refreshMarkets().catch(() => {})
    _refreshTimer = setInterval(() => refreshMarkets().catch(() => {}), 5 * 60 * 1000)
  }, msToNext)
  log('info', 'ArbEngine', `next market refresh in ${Math.round(msToNext / 1000)}s`)
}

// ── Poly auto-redeem ──────────────────────────────────────────────────────────

async function redeemAllPolyPositions(): Promise<void> {
  const now = Date.now()
  const expired = _tradeLog.filter(t =>
    t.success && !t.polyRedeemed && t.conditionId &&
    t.expiresAt > 0 && t.expiresAt < now - 10_000   // 10s buffer after expiry
  )
  if (expired.length === 0) return
  let changed = false
  for (const trade of expired) {
    try {
      await redeemPolyPositions(trade.conditionId!)
      trade.polyRedeemed = true
      changed = true
      log('info', 'ArbEngine', `poly redeemed: ${trade.asset} ${trade.direction} (${trade.id})`)
      // Bust balance cache so UI shows updated balance immediately
      const { getPolyBalance } = await import('../exchanges/poly.js')
      getPolyBalance().catch(() => {})
    } catch (err) {
      const msg = (err as Error).message
      if (/no position/i.test(msg) || /already redeemed/i.test(msg)) {
        trade.polyRedeemed = true
        changed = true
        log('info', 'ArbEngine', `poly already redeemed (manual): ${trade.id}`)
      } else {
        log('warn', 'ArbEngine', `poly redeem failed ${trade.id}: ${msg}`)
      }
    }
  }
  if (changed) saveTradeLog().catch(() => {})
}

// ── External position sync ────────────────────────────────────────────────────
// On startup, seed _tradeLog with live Poly CLOB positions not already tracked.
// This prevents the openCount check from treating existing positions as "0 open".

async function syncExternalPositions(): Promise<void> {
  try {
    const livePos = await getPolyPositions()
    if (livePos.length === 0) return
    const tokenMap = getPolyTokenToKeyMap()
    const now = Date.now()
    let added = 0

    for (const p of livePos) {
      const raw = p as Record<string, unknown>
      const tokenId = String(raw['tokenId'] ?? raw['asset_id'] ?? raw['asset'] ?? '')
      if (!tokenId || tokenId === 'undefined') continue
      if (_tradeLog.some(t => t.polyTokenId === tokenId)) continue  // already tracked

      const sharesRaw = parseFloat(String(raw['size'] ?? '0'))
      if (!(sharesRaw > 0)) continue

      // Skip positions that have fully resolved with zero value
      const curPrice = parseFloat(String(raw['curPrice'] ?? '1'))
      if (raw['redeemable'] === true && curPrice === 0) continue

      // Parse expiry from title time range
      const title = String(raw['title'] ?? '')
      const endDateRaw = String(raw['endDate'] ?? raw['end_date'] ?? '')
      let expiresAt = 0
      if (endDateRaw) {
        const timeMatch = title.match(/-\s*(\d{1,2})(?::(\d{2}))?\s*([AP]M)/i)
        if (timeMatch) {
          let h = parseInt(timeMatch[1]) % 12
          if (/p/i.test(timeMatch[3])) h += 12
          const m = parseInt(timeMatch[2] ?? '0')
          expiresAt = new Date(endDateRaw + 'T00:00:00Z').getTime() + (h * 3600 + m * 60) * 1000 + 4 * 3600_000
        } else {
          expiresAt = new Date(endDateRaw + 'T23:59:59Z').getTime()
        }
      }
      // Skip if expired more than 2 hours ago
      if (expiresAt > 0 && expiresAt < now - 2 * 3600_000) continue

      const tkEntry = tokenMap.get(tokenId)
      const key = tkEntry?.key
      const outcomeRaw = String(raw['outcome'] ?? '')
      const outcome: 'yes' | 'no' = /^up$/i.test(outcomeRaw) ? 'yes' : /^down$/i.test(outcomeRaw) ? 'no' : (tkEntry?.outcome ?? 'yes')
      const tf = (key ? key.split('-').slice(1).join('-') : null) ?? detectTimeframe(title) ?? '5min'
      const q = title.toLowerCase()
      const assetStr: CryptoAsset = key ? key.split('-')[0] as CryptoAsset
        : /bitcoin|btc/.test(q) ? 'BTC' : /ethereum|eth/.test(q) ? 'ETH' : /solana|sol/.test(q) ? 'SOL'
        : /\bxrp\b|ripple/.test(q) ? 'XRP' : /dogecoin|doge/.test(q) ? 'DOGE'
        : /\bbnb\b|binance/.test(q) ? 'BNB' : /hyperliquid|hype/.test(q) ? 'HYPE' : 'BTC'
      const avgPrice = parseFloat(String(raw['avgPrice'] ?? raw['avg_price'] ?? '0'))

      _tradeLog.push({
        id: `ext-${tokenId.slice(0, 12)}`,
        ts: Date.now() - 60_000,  // offset to sort below fresh trades
        asset: assetStr,
        timeframe: tf as MarketTimeframe,
        direction: outcome === 'yes' ? 'UP' : 'DOWN',
        profitPct: 0,
        positionSize: sharesRaw * (avgPrice || 1),
        polyTokenId: tokenId,
        limSlug: '',
        expiresAt,
        success: true,
        type: 'arb',
        polyEntryPrice: avgPrice || undefined,
        polySharesHeld: sharesRaw,
      })
      added++
    }

    if (added > 0) {
      log('info', 'ArbEngine', `seeded ${added} existing Poly positions into trade log — they count against maxOpenTrades`)
      saveTradeLog().catch(() => {})
    }
  } catch (err) {
    log('warn', 'ArbEngine', `syncExternalPositions: ${(err as Error).message}`)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// ── Crypto pipeline (REST market refresh + WS feeds + redeem/hedge/early-exit
// cycles that power the dashboard table and the ARB/Signal/XTF/XAsset/Buzzer
// strategies). Gated by `cryptoEnabled` so Sport/Esport-only operation can run
// without ever touching crypto markets. ───────────────────────────────────────

let _cryptoRunning = false

async function startCryptoPipeline(): Promise<void> {
  if (_cryptoRunning) return
  _cryptoRunning = true

  await refreshMarkets()
  await syncExternalPositions()  // seed trade log with existing Poly positions so openCount is accurate

  // Schedule refresh aligned to 5-min window boundaries
  scheduleNextRefresh()
  // Periodically redeem resolved Limitless positions (also run immediately on start)
  redeemLimPositions().catch(err => log('warn', 'ArbEngine', `lim redeem error: ${(err as Error).message}`))
  if (!_redeemTimer) _redeemTimer = setInterval(() => redeemLimPositions().catch(err => log('warn', 'ArbEngine', `lim redeem error: ${(err as Error).message}`)), 60_000)
  // Periodically redeem resolved Polymarket positions (also run immediately on start)
  redeemAllPolyPositions().catch(err => log('warn', 'ArbEngine', `poly redeem error: ${(err as Error).message}`))
  if (!_polyRedeemTimer) _polyRedeemTimer = setInterval(() => redeemAllPolyPositions().catch(err => log('warn', 'ArbEngine', `poly redeem error: ${(err as Error).message}`)), 90_000)
  // Watchdog: retry closing any orphaned single legs every 5 seconds
  if (!_hedgeTimer) _hedgeTimer = setInterval(() => runHedgeWatchdog().catch(err => log('warn', 'ArbEngine', `hedge watchdog error: ${(err as Error).message}`)), 5_000)
  // Check open arb positions for early-exit opportunity every 3 seconds
  if (!_earlyExitTimer) _earlyExitTimer = setInterval(() => checkAllEarlyExits(), 3_000)
  // Watchdog: verify both legs of recent spread trades actually filled, every 20 seconds
  if (!_legCheckTimer) _legCheckTimer = setInterval(() => verifySpreadLegs().catch(err => log('warn', 'ArbEngine', `spread leg watchdog error: ${(err as Error).message}`)), 20_000)
  log('info', 'ArbEngine', `crypto pipeline started — ${getPolyMarkets().size} poly + ${getLimMarkets().size} lim markets`)
}

async function stopCryptoPipeline(): Promise<void> {
  if (!_cryptoRunning) return
  _cryptoRunning = false
  if (_refreshTimer)      { clearInterval(_refreshTimer);      _refreshTimer      = null }
  if (_retryRefreshTimer) { clearTimeout(_retryRefreshTimer);  _retryRefreshTimer = null }
  if (_redeemTimer)       { clearInterval(_redeemTimer);       _redeemTimer       = null }
  if (_polyRedeemTimer)   { clearInterval(_polyRedeemTimer);   _polyRedeemTimer   = null }
  if (_hedgeTimer)        { clearInterval(_hedgeTimer);        _hedgeTimer        = null }
  if (_earlyExitTimer)    { clearInterval(_earlyExitTimer);    _earlyExitTimer    = null }
  if (_legCheckTimer)     { clearInterval(_legCheckTimer);     _legCheckTimer     = null }
  _pendingHedges.length = 0
  _buzzerState.clear()
  await Promise.allSettled([stopPolyWs(), stopLimWs()])
  log('info', 'ArbEngine', 'crypto pipeline stopped')
}

export async function startEngine(): Promise<void> {
  if (_running) return
  _running = true
  log('info', 'ArbEngine', 'starting')

  // Warn if Polymarket is using EOA instead of proxy (CLOB will reject orders)
  try {
    const { rGet, decrypt } = await import('../db/redis.js')
    const raw = await rGet('poly:settings:wallets')
    if (raw) {
      const w = JSON.parse(decrypt(raw)) as { polyProxyAddress?: string }
      if (!w.polyProxyAddress) {
        log('warn', 'ArbEngine', 'polyProxyAddress not set — Polymarket CLOB orders will be rejected. Enter your proxy address in Settings → Step 1.')
      }
    }
  } catch { /* best-effort warning */ }

  await loadSettings()
  await loadTradeLog()

  if (_settings.cryptoEnabled) {
    await startCryptoPipeline()
  } else {
    log('info', 'ArbEngine', 'crypto pipeline disabled (cryptoEnabled=false) — skipping market fetch/WS feeds')
  }
  // Sports/Esports scanner — fully independent toggle, polls both exchanges on its own schedule
  if (_settings.sportEnabled) startSportsScanner()
  // Leaderboard Copy-Trading — fully independent toggle, polls followed wallets on its own schedule
  if (_settings.copyTradeEnabled) startCopyTradeScanner()
  log('info', 'ArbEngine', 'engine started')
}

export async function stopEngine(): Promise<void> {
  _running = false
  await stopCryptoPipeline()
  stopSportsScanner()
  stopCopyTradeScanner()
  log('info', 'ArbEngine', 'stopped')
}

export async function restartEngine(): Promise<void> {
  await stopEngine()
  await new Promise(r => setTimeout(r, 500))
  await startEngine()
}

export function getEngineStatus(): {
  running: boolean
  autoExecute: boolean
  minProfitPct: number
  maxPositionSize: number
  maxOpenTrades: number
  mode: 'arb' | 'signal' | 'both' | 'none'
  signalMinGapPct: number
  xtfEnabled: boolean
  xtfMinGapPct: number
  xAssetEnabled: boolean
  xAssetMinGapPct: number
  autoExit: boolean
  buzzerEnabled: boolean
  buzzerAutoExecute: boolean
  buzzerPositionSize: number
  sportEnabled: boolean
  cryptoEnabled: boolean
  copyTradeEnabled: boolean
  copyTradeAutoExecute: boolean
  copyTradePositionSize: number
  followedWallets: string[]
  spreadEnabled: boolean
  spreadAutoExecute: boolean
  spreadPositionSize: number
  spreadMinGapPct: number
  spreadPlatform: 'poly' | 'lim' | 'best'
  spreadTimeframes: MarketTimeframe[]
  openTrades: number
  polyMarkets: number
  limMarkets: number
  recentTrades: number
  winRate: number
  pendingHedges: number
  apiCalls: Record<'poly' | 'lim', { total: number; perMin: number }>
} {
  const wins = _tradeLog.filter(t => t.success).length
  const openTrades = _tradeLog.filter(t => t.success && !t.earlyExited && t.expiresAt > Date.now()).length + _pendingTradeCount
  return {
    running: _running,
    autoExecute: _settings.autoExecute,
    minProfitPct: _settings.minProfitPct,
    maxPositionSize: _settings.maxPositionSize,
    maxOpenTrades: _settings.maxOpenTrades,
    mode: _settings.mode,
    signalMinGapPct: _settings.signalMinGapPct,
    xtfEnabled: _settings.xtfEnabled,
    xtfMinGapPct: _settings.xtfMinGapPct,
    xAssetEnabled: _settings.xAssetEnabled,
    xAssetMinGapPct: _settings.xAssetMinGapPct,
    autoExit: _settings.autoExit,
    buzzerEnabled: _settings.buzzerEnabled,
    buzzerAutoExecute: _settings.buzzerAutoExecute,
    buzzerPositionSize: _settings.buzzerPositionSize,
    sportEnabled: _settings.sportEnabled,
    cryptoEnabled: _settings.cryptoEnabled,
    copyTradeEnabled: _settings.copyTradeEnabled,
    copyTradeAutoExecute: _settings.copyTradeAutoExecute,
    copyTradePositionSize: _settings.copyTradePositionSize,
    followedWallets: _settings.followedWallets,
    spreadEnabled: _settings.spreadEnabled,
    spreadAutoExecute: _settings.spreadAutoExecute,
    spreadPositionSize: _settings.spreadPositionSize,
    spreadMinGapPct: _settings.spreadMinGapPct,
    spreadPlatform: _settings.spreadPlatform,
    spreadTimeframes: _settings.spreadTimeframes,
    openTrades,
    polyMarkets: getPolyMarkets().size,
    limMarkets: getLimMarkets().size,
    recentTrades: _tradeLog.length,
    winRate: _tradeLog.length > 0 ? Math.round((wins / _tradeLog.length) * 100) : 0,
    pendingHedges: _pendingHedges.length,
    apiCalls: getApiCallStats(),
  }
}

export function getTradeHistory(limit = 50): TradeRecord[] {
  return _tradeLog.slice(0, limit)
}

export async function applySettings(settings: Partial<ArbSettings>): Promise<void> {
  const wasSportEnabled = _settings.sportEnabled
  const wasCryptoEnabled = _settings.cryptoEnabled
  const wasCopyTradeEnabled = _settings.copyTradeEnabled
  _settings = { ..._settings, ...settings }
  await rSet('poly:settings:arb', JSON.stringify(_settings))
  if (_running && _settings.sportEnabled !== wasSportEnabled) {
    if (_settings.sportEnabled) startSportsScanner()
    else stopSportsScanner()
  }
  if (_running && _settings.cryptoEnabled !== wasCryptoEnabled) {
    if (_settings.cryptoEnabled) await startCryptoPipeline()
    else await stopCryptoPipeline()
  }
  if (_running && _settings.copyTradeEnabled !== wasCopyTradeEnabled) {
    if (_settings.copyTradeEnabled) startCopyTradeScanner()
    else stopCopyTradeScanner()
  }
  broadcastState()
}

// Cache: base leaderboard (all-time snapshot from Polymarket API)
let _lbBaseCache: LeaderboardEntry[] = []
let _lbBaseCacheAt = 0
const LB_BASE_TTL = 10 * 60 * 1000 // 10 min

// Cache: windowed stats per window key (expensive — computed from per-trader trades)
const _lbWindowCache = new Map<LeaderboardWindow, { entries: LeaderboardEntry[]; at: number }>()
const LB_WINDOW_TTL = 15 * 60 * 1000 // 15 min

export async function getLeaderboard(window: LeaderboardWindow = 'day', limit = 25): Promise<LeaderboardEntry[]> {
  // 1. Fetch (or return cached) base snapshot
  const now = Date.now()
  if (_lbBaseCache.length === 0 || now - _lbBaseCacheAt > LB_BASE_TTL) {
    _lbBaseCache = await fetchLeaderboard(50)  // Polymarket API hard-caps at 50
    _lbBaseCacheAt = now
    for (const e of _lbBaseCache) cacheTraderName(e.proxyWallet, e.userName)
  }
  const base = _lbBaseCache.slice(0, limit)

  // 2. For day/week/month — enrich with windowed stats (cached separately)
  const cached = _lbWindowCache.get(window)
  if (cached && now - cached.at < LB_WINDOW_TTL) {
    return cached.entries.slice(0, limit)
  }

  // Kick off background enrichment; return base entries immediately while loading
  fetchLeaderboardWindowStats(base, window).then(enriched => {
    _lbWindowCache.set(window, { entries: enriched, at: Date.now() })
  }).catch(err => logLeaderboardError(`window-stats ${window}`, err))

  // Return base entries with windowVol undefined — frontend shows "loading" for window stats
  return base
}

export function getLeaderboardWindowCache(window: LeaderboardWindow): LeaderboardEntry[] | null {
  const cached = _lbWindowCache.get(window)
  if (!cached) return null
  return cached.entries
}

export async function getTraderStats(wallet: string): Promise<TraderStats> {
  return computeTraderStats(wallet)
}

export function getCopyTradeState(): { signals: CopyTradeSignal[]; stats: Record<string, TraderStats> } {
  return getCopyTradeSnapshot()
}

export async function triggerManualArb(key: string): Promise<{ ok: boolean; error?: string }> {
  const opp = detectArb(key)
  if (!opp) return { ok: false, error: 'No arb opportunity detected for this market right now' }
  executeArb(opp).catch(() => {})
  return { ok: true }
}

export async function triggerManualSpread(key: string): Promise<{ ok: boolean; error?: string }> {
  const opp = detectSpread(key, true)  // force=true: bypass profit threshold, execute at any spread
  if (!opp) return { ok: false, error: 'No market data available for this key' }
  executeSpreadTrade(opp).catch(() => {})
  return { ok: true }
}

export { getPolyBalance, getPolyPositions, getLimBalance }
