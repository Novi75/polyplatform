/**
 * Limitless exchange integration — crypto markets for all timeframes (5min, 15min, 1h).
 * Handles: WS subscription, live prices, order placement, balance.
 */
import { WebSocketClient, HttpClient, MarketFetcher, OrderClient, OrderType, Side } from '@limitless-exchange/sdk'
import type { OrderbookUpdate, OraclePriceData, NewPriceData } from '@limitless-exchange/sdk'
import { config } from '../config.js'
import { trackLimCall } from './apiCallTracker.js'
import { rGet, rSet, decrypt } from '../db/redis.js'
import { log } from '../logger.js'
import type { CryptoAsset } from './poly.js'
import { TIMEFRAMES, type MarketTimeframe, detectTimeframe, MAX_FUTURE_MS } from './poly.js'

export interface LimLivePrice { bid: number; ask: number; ts: number; noAsk?: number; noBid?: number }

interface LimMarketInfo { slug: string; title: string; expiresAt: number; yesTokenId: string; noTokenId: string }

// ── Asset detection ───────────────────────────────────────────────────────────

const ASSET_PATTERNS: Record<string, RegExp> = {
  BTC: /bitcoin|btc/i,
  ETH: /ethereum|eth/i,
  SOL: /solana|sol/i,
  XRP: /ripple|xrp/i,
  DOGE: /dogecoin|doge/i,
  BNB: /bnb|binance/i,
  HYPE: /hype/i,
}

function detectAsset(title: string): CryptoAsset | null {
  for (const [asset, pattern] of Object.entries(ASSET_PATTERNS)) {
    if (pattern.test(title)) return asset as CryptoAsset
  }
  return null
}

// ── In-memory stores ──────────────────────────────────────────────────────────

const _prices   = new Map<string, { bid: number; ask: number; ts: number }>()  // YES token prices by slug
const _noPrices = new Map<string, { bid: number; ask: number; ts: number }>()  // NO token prices by slug
const _markets = new Map<string, LimMarketInfo>()          // "ASSET-timeframe" → market info
const _expiredMarkets = new Map<string, LimMarketInfo>()   // slug → expired market (for redemption)
const _tradedSlugs = new Set<string>()                     // slugs we actually placed orders for

// ── Auth credentials ──────────────────────────────────────────────────────────

export interface LimCreds {
  mode: 'legacy' | 'hmac'
  apiKey: string
  tokenId: string
  secret: string
  walletAddress?: string
  privateKey?: string   // EOA private key for EIP-712 order signing (own-account orders)
}

export async function getLimCreds(): Promise<LimCreds | null> {
  try {
    const raw = await rGet('poly:settings:limitless')
    if (!raw) return null
    const parsed = JSON.parse(decrypt(raw)) as Record<string, string>
    if (parsed.mode === 'legacy') return { mode: 'legacy', apiKey: parsed.apiKey ?? '', tokenId: '', secret: '', walletAddress: parsed.walletAddress }
    return { mode: 'hmac', apiKey: '', tokenId: parsed.tokenId ?? '', secret: parsed.secret ?? '', walletAddress: parsed.walletAddress, privateKey: parsed.privateKey }
  } catch { return null }
}

// ── Market discovery ──────────────────────────────────────────────────────────

let _httpClient: HttpClient | null = null
let _marketFetcher: MarketFetcher | null = null

export function getMarketFetcher(): MarketFetcher {
  if (!_marketFetcher) { _httpClient = new HttpClient(); _marketFetcher = new MarketFetcher(_httpClient) }
  return _marketFetcher
}

interface RawPage {
  data?: Array<Record<string, unknown>>
  totalMarketsCount?: number
}

async function fetchPage(fetcher: MarketFetcher, page: number, size: number): Promise<RawPage> {
  trackLimCall()
  const resp = await fetcher.getActiveMarkets({ page }) as unknown
  return (resp ?? {}) as RawPage
}

export async function fetchLimMarkets(): Promise<void> {
  const fetcher = getMarketFetcher()
  // Build into a temp map first — only swap in atomically if we found markets,
  // so the live map never goes empty during the window transition.
  const fresh = new Map<string, LimMarketInfo>()
  for (let page = 1; page <= 5; page++) {
    try {
      const resp = await fetchPage(fetcher, page, 25)
      const data = resp.data ?? []
      if (data.length === 0) break
      for (const m of data) {
        const slug = String(m.slug ?? '')
        const title = String(m.title ?? '')
        if (!/up\s+or\s+down/i.test(title)) continue
        const asset = detectAsset(title)
        if (!asset) continue
        const tf = detectTimeframe(title)
        if (!tf) { log('info', 'Lim', `no-tf: ${JSON.stringify(title)}`); continue }
        const mk = `${asset}-${tf}`
        if (fresh.has(mk)) continue
        const expiresAt = m.expirationTimestamp ? Number(m.expirationTimestamp) : (m.expirationDate ? new Date(String(m.expirationDate)).getTime() : 0)
        if (expiresAt && expiresAt < Date.now()) continue          // skip already-expired markets
        if (expiresAt && expiresAt > Date.now() + MAX_FUTURE_MS[tf]) continue  // skip beyond timeframe window
        const tokens = m.tokens as { yes?: string; no?: string } | undefined
        fresh.set(mk, { slug, title, expiresAt, yesTokenId: tokens?.yes ?? '', noTokenId: tokens?.no ?? '' })
        // Seed bid/ask: prefer tradePrices (FOK market order prices) over bestBid/bestAsk
        // bestAsk can be 0.999 (placeholder when no visible limit-sell orders exist)
        const raw = m as Record<string, unknown>
        const tp = m.tradePrices as { buy?: { market?: number[] }; sell?: { market?: number[] } } | undefined
        const rawBid = tp?.sell?.market?.[0] || (raw.bestBid ? Number(raw.bestBid) : 0) || 0
        const rawAsk = tp?.buy?.market?.[0] || (raw.bestAsk ? Number(raw.bestAsk) : 0) || 0
        // Cap ask at 0.98 — 0.999 is a Limitless placeholder for "no visible limit-sell orders"
        const bid = rawBid > 0 && rawBid < 1 ? rawBid : 0
        const ask = rawAsk > 0 && rawAsk < 0.99 ? rawAsk : 0
        if (bid > 0 || ask > 0) setLimPrice(slug, bid, ask)
      }
    } catch (err) {
      log('warn', 'Lim', `market page ${page} failed: ${(err as Error).message}`)
      break
    }
  }
  if (fresh.size > 0) {
    // Save expiring markets for post-expiry redemption before clearing
    const now = Date.now()
    for (const m of _markets.values()) {
      if (m.yesTokenId || m.noTokenId) _expiredMarkets.set(m.slug, m)
    }
    // Prune expired entries older than 15 minutes
    for (const [slug, m] of _expiredMarkets) {
      if (m.expiresAt > 0 && m.expiresAt < now - 15 * 60_000) _expiredMarkets.delete(slug)
    }
    _markets.clear()
    for (const [k, v] of fresh) _markets.set(k, v)
  }
  const expiryTimes = [..._markets.entries()].map(([k, m]) => `${k}@${new Date(m.expiresAt).toISOString().slice(11, 16)}Z`).join(' ')
  log('info', 'Lim', `markets: ${_markets.size} pairs — ${expiryTimes}`)
}

// Keep old name as alias for any callers that haven't been updated yet
export const fetchLim5MinMarkets = fetchLimMarkets

export function getLimMarkets(): ReadonlyMap<string, LimMarketInfo> { return _markets }
export function getLimMarketExpiry(key: string): number { return _markets.get(key)?.expiresAt ?? 0 }

// ── Live price store ──────────────────────────────────────────────────────────

export function setLimPrice(slug: string, bid: number, ask: number): void {
  _prices.set(slug, { bid, ask, ts: Date.now() })
}

export function getLimSlugPrice(slug: string): LimLivePrice | null {
  const p = _prices.get(slug)
  if (!p) return null
  const n = _noPrices.get(slug)
  return { ...p, noAsk: n?.ask, noBid: n?.bid }
}

export function getLimAssetPrice(key: string): LimLivePrice | null {
  const m = _markets.get(key)
  if (!m) return null
  return getLimSlugPrice(m.slug)
}

// ── WebSocket subscription ────────────────────────────────────────────────────

let _wsClient: WebSocketClient | null = null
let _watchdog: ReturnType<typeof setInterval> | null = null
let _lastUpdate = 0    // timestamp of last price event
let _wsStartedAt = 0   // when startLimWs was last called (for "never received" detection)
let _lastRestSeed = 0  // timestamp of last REST re-seed attempt

type LimPriceCallback = (key: string) => void
let _callback: LimPriceCallback | null = null

function handleOrderbookUpdate(data: OrderbookUpdate): void {
  const { marketSlug, orderbook } = data
  if (!marketSlug || !orderbook) return
  _lastUpdate = Date.now()
  const bid = orderbook.bids[0]?.price ?? 0
  const ask = orderbook.asks[0]?.price ?? 0
  const now = Date.now()

  // Route YES vs NO token to separate stores so they don't overwrite each other
  let isNoToken = false
  for (const [, m] of _markets) {
    if (m.slug === marketSlug && orderbook.tokenId && m.noTokenId && orderbook.tokenId === m.noTokenId) {
      isNoToken = true; break
    }
  }

  if (isNoToken) {
    const prev = _noPrices.get(marketSlug)
    const newBid = bid > 0 ? bid : (prev?.bid ?? 0)
    const newAsk = ask > 0 ? ask : (prev?.ask ?? 0)
    if (newBid > 0 || newAsk > 0) {
      _noPrices.set(marketSlug, { bid: newBid, ask: newAsk, ts: now })
    } else if (prev) {
      _noPrices.set(marketSlug, { ...prev, ts: now })
    }
  } else {
    // YES token (or unknown — default to YES)
    const prev = _prices.get(marketSlug)
    const newBid = bid > 0 ? bid : (prev?.bid ?? 0)
    const newAsk = ask > 0 ? ask : (prev?.ask ?? 0)
    if (newBid > 0 || newAsk > 0) {
      setLimPrice(marketSlug, newBid, newAsk)
    } else if (prev) {
      // Orderbook fully drained — keep last known prices alive
      _prices.set(marketSlug, { ...prev, ts: now })
    }
  }

  for (const [key, m] of _markets) {
    if (m.slug === marketSlug && _callback) { _callback(key); break }
  }
}

function handleOraclePriceData(data: OraclePriceData): void {
  const { marketSlug } = data
  if (!marketSlug) return
  _lastUpdate = Date.now()
  const now = Date.now()
  for (const [key, m] of _markets) {
    if (m.slug !== marketSlug) continue
    const yes = _prices.get(marketSlug)
    if (yes) _prices.set(marketSlug, { ...yes, ts: now })
    const no = _noPrices.get(marketSlug)
    if (no) _noPrices.set(marketSlug, { ...no, ts: now })
    if (_callback) _callback(key)
    break
  }
}

function handleNewPriceData(data: NewPriceData): void {
  if (!data.updatedPrices?.length) return
  _lastUpdate = Date.now()
  for (const entry of data.updatedPrices) {
    for (const [key, m] of _markets) {
      if ((m as { address?: string }).address === entry.marketAddress) {
        // yesPrice = oracle price for YES outcome — use as mid/ask reference
        // only update if non-zero to avoid overwriting orderbook data
        if (entry.yesPrice > 0) {
          const prev = _prices.get(m.slug)
          setLimPrice(m.slug, prev?.bid ?? entry.yesPrice, entry.yesPrice)
        }
        if (_callback) _callback(key)
        break
      }
    }
  }
}

async function refreshRestPrices(): Promise<void> {
  const fetcher = getMarketFetcher()
  await Promise.allSettled([..._markets.values()].map(async m => {
    try {
      trackLimCall()
      const detail = await fetcher.getMarket(m.slug) as Record<string, unknown>
      const tp = detail.tradePrices as { buy?: { market?: number[] }; sell?: { market?: number[] } } | undefined
      const bid = tp?.sell?.market?.[0] ?? 0
      const ask = tp?.buy?.market?.[0] ?? 0
      if (bid > 0 || ask > 0) {
        setLimPrice(m.slug, bid, ask)
        log('info', 'Lim', `REST seed ${m.slug}: bid=${bid.toFixed(3)} ask=${ask.toFixed(3)}`)
      }
    } catch (err) {
      log('warn', 'Lim', `REST refresh ${m.slug}: ${(err as Error).message}`)
    }
  }))
}

async function buildWsConfig(): Promise<ConstructorParameters<typeof WebSocketClient>[0]> {
  const cfg: ConstructorParameters<typeof WebSocketClient>[0] = {
    reconnectDelay: 200,
    maxReconnectAttempts: Infinity,
  }
  try {
    const creds = await getLimCreds()
    if (creds?.mode === 'legacy') cfg.apiKey = creds.apiKey
    else if (creds?.mode === 'hmac') cfg.hmacCredentials = { tokenId: creds.tokenId, secret: creds.secret }
  } catch { /* proceed without auth */ }
  return cfg
}

async function sendSubscription(): Promise<void> {
  if (!_wsClient?.isConnected()) return
  const slugs = [..._markets.values()].map(m => m.slug)
  if (slugs.length === 0) return
  try {
    await _wsClient.subscribe('subscribe_market_prices', { marketSlugs: slugs })
    log('info', 'Lim', `subscribed to ${slugs.length} markets: ${slugs.join(', ')}`)
  } catch (err) {
    log('warn', 'Lim', `subscribe failed: ${(err as Error).message}`)
  }
}

async function ensureWsClient(): Promise<void> {
  if (_wsClient) return
  const cfg = await buildWsConfig()
  _wsClient = new WebSocketClient(cfg)
  _wsClient.on('orderbookUpdate', handleOrderbookUpdate)
  _wsClient.on('oraclePriceData', handleOraclePriceData)
  _wsClient.on('newPriceData', handleNewPriceData)
  _wsClient.on('disconnect', (reason: string) => log('warn', 'Lim', `WS disconnected: ${reason}`))
  _wsClient.on('reconnecting', (attempt: number) => log('info', 'Lim', `WS reconnecting (attempt ${attempt})`))
  log('info', 'Lim', 'WS client created')
}

function runWatchdog(): void {
  if (!_wsClient) return
  if (!_wsClient.isConnected()) return  // SDK calls resubscribeAll() on reconnect internally

  // Re-subscribe if connected but never received data (initial sub may have failed) or gone stale
  const neverReceived = _lastUpdate === 0 && _wsStartedAt > 0 && Date.now() - _wsStartedAt > 20_000
  const stale = _lastUpdate > 0 && Date.now() - _lastUpdate > 15_000
  if (neverReceived || stale) {
    log('warn', 'Lim', `WS watchdog: resubscribing (neverReceived=${neverReceived}, stale=${stale})`)
    sendSubscription().catch(err => log('warn', 'Lim', `watchdog resub failed: ${(err as Error).message}`))
  }

  // Periodically re-seed REST prices for any market with no current price (new market liquidity delay)
  const now = Date.now()
  const hasMissingPrices = [..._markets.values()].some(m => {
    const p = _prices.get(m.slug)
    return !p || p.bid === 0
  })
  if (hasMissingPrices && now - _lastRestSeed > 30_000) {
    _lastRestSeed = now
    refreshRestPrices().catch(err => log('warn', 'Lim', `watchdog REST seed failed: ${(err as Error).message}`))
  }
}

export async function startLimWs(onUpdate: LimPriceCallback): Promise<void> {
  _callback = onUpdate
  _wsStartedAt = Date.now()
  await ensureWsClient()
  if (!_wsClient!.isConnected()) {
    // connect() resolves only after state = "connected" — safe to subscribe immediately after
    await _wsClient!.connect()
  }
  // Always send subscription: initial connect or market slug refresh after window rotation.
  // This also stores the slugs in the SDK's internal subscriptions map so resubscribeAll()
  // (called by the SDK on auto-reconnect) re-sends them with the correct current slugs.
  await sendSubscription()
  // Refresh REST prices in background to override potentially-stale initial seed
  refreshRestPrices().catch(err => log('warn', 'Lim', `REST refresh failed: ${(err as Error).message}`))
  log('info', 'Lim', 'WS ready')
  if (!_watchdog) _watchdog = setInterval(runWatchdog, 5_000)
}

export async function stopLimWs(): Promise<void> {
  _callback = null
  if (_watchdog) { clearInterval(_watchdog); _watchdog = null }
  if (_wsClient) { await _wsClient.disconnect().catch(() => {}); _wsClient = null }
  _lastUpdate = 0
  _wsStartedAt = 0
  _lastRestSeed = 0
}

// ── Balance (on-chain USDC in wallet — Limitless uses approval/pull model) ────

let _balanceCachedAt = 0
let _balanceCached: string | null = null
let _discoveredAddress: string | null = null
let _discoveredAddressCachedAt = 0

async function discoverLimWalletAddress(creds: LimCreds): Promise<string | null> {
  if (_discoveredAddress && Date.now() - _discoveredAddressCachedAt < 3_600_000) return _discoveredAddress
  try {
    const authHeader = creds.mode === 'legacy'
      ? { 'X-API-Key': creds.apiKey }
      : { 'X-API-Key': creds.apiKey }  // both modes send the relevant key
    const r = await fetch(`${config.limitless.apiHost}/auth/api-tokens`, { headers: authHeader })
    if (r.ok) {
      const body = await r.json() as unknown
      // The legacy endpoint may wrap tokens in {data:[...]} or return an array directly
      const arr: unknown[] = Array.isArray(body) ? body : (body as Record<string, unknown[]>)['data'] ?? []
      for (const tok of arr) {
        const account = (tok as Record<string, unknown>)['account']
        if (typeof account === 'string' && /^0x[0-9a-fA-F]{40}$/.test(account)) {
          _discoveredAddress = account
          _discoveredAddressCachedAt = Date.now()
          return account
        }
      }
    }
  } catch { /* best-effort */ }
  return null
}

export async function getLimBalance(): Promise<string | null> {
  if (Date.now() - _balanceCachedAt < 60_000 && _balanceCached !== null) return _balanceCached

  try {
    const creds = await getLimCreds()
    if (!creds) return null

    // Use configured wallet address, or discover it from the API
    let address = creds.walletAddress
    if (!address) {
      address = await discoverLimWalletAddress(creds) ?? undefined
    }
    if (!address) return null

    const { getAddress, createPublicClient, http, parseAbi } = await import('viem')
    const { base } = await import('viem/chains')
    const publicClient = createPublicClient({ chain: base, transport: http(config.limitless.baseRpc) })
    const raw = await publicClient.readContract({
      address: getAddress(LIM_USDC_ADDRESS) as `0x${string}`,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [getAddress(address) as `0x${string}`],
    })

    _balanceCached = (Number(raw) / 1_000_000).toFixed(2)
    _balanceCachedAt = Date.now()
    return _balanceCached
  } catch (err) {
    log('warn', 'Lim', `balance error: ${(err as Error).message}`)
    return null
  }
}

// ── Order placement (own-account EIP-712 signing — no delegated_signing scope needed) ─

let _orderClient: OrderClient | null = null
let _orderCredsKey = ''

async function getLimOrderClient(): Promise<OrderClient | null> {
  const creds = await getLimCreds()
  if (!creds?.privateKey || !creds?.walletAddress) return null
  if (creds.mode !== 'hmac') return null

  const credsKey = `${creds.tokenId}:${creds.secret}:${creds.privateKey}`
  if (!_orderClient || _orderCredsKey !== credsKey) {
    const { Wallet } = await import('ethers')
    const { getAddress } = await import('viem')
    const httpClient = new HttpClient({
      hmacCredentials: { tokenId: creds.tokenId, secret: creds.secret },
      additionalHeaders: { 'x-account': getAddress(creds.walletAddress) },
    })
    const wallet = new Wallet(creds.privateKey)
    _orderClient = new OrderClient({ httpClient, wallet, marketFetcher: getMarketFetcher() })
    _orderCredsKey = credsKey
    log('info', 'Lim', `OrderClient created — signer ${wallet.address.slice(0, 10)}...`)
  }

  return _orderClient
}

let _limSlot = Date.now()
async function waitSlot(): Promise<void> {
  const fire = _limSlot
  _limSlot = Math.max(_limSlot, Date.now()) + 1_100
  const wait = fire - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
}

// ── USDC approval (one-time, required before first order) ────────────────────

const LIM_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')

// Returns the venue exchange address from a live market (differs per deployment)
async function getLimVenueExchangeAddress(): Promise<string> {
  const fetcher = getMarketFetcher()
  for (const market of _markets.values()) {
    try {
      trackLimCall()
      const m = await fetcher.getMarket(market.slug) as { venue?: { exchange?: string } }
      if (m.venue?.exchange) return m.venue.exchange
    } catch { /* try next */ }
  }
  // Fallback: fetch fresh page and check
  trackLimCall()
  const resp = await fetcher.getActiveMarkets({ page: 1 }) as { data?: Array<Record<string, unknown>> }
  for (const m of (resp.data ?? [])) {
    if (/up\s+or\s+down/i.test(String(m.title))) {
      trackLimCall()
      const detail = await fetcher.getMarket(String(m.slug)) as { venue?: { exchange?: string } }
      if (detail.venue?.exchange) return detail.venue.exchange
    }
  }
  throw new Error('Could not determine Limitless venue exchange address — no active markets found')
}

export async function setupLimApprovals(): Promise<{ usdcTxHash: string; ctfTxHash: string; spender: string }> {
  const creds = await getLimCreds()
  if (!creds?.privateKey) throw new Error('Limitless private key not configured')

  const spender = await getLimVenueExchangeAddress()

  const { createPublicClient, createWalletClient, http, parseAbi, getAddress, fallback } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const { base } = await import('viem/chains')

  const pk = creds.privateKey.startsWith('0x') ? creds.privateKey : `0x${creds.privateKey}`
  const account = privateKeyToAccount(pk as `0x${string}`)
  const BASE_RPCS = [config.limitless.baseRpc, 'https://base.llamarpc.com', 'https://base.drpc.org']
  const transport = fallback(BASE_RPCS.map(url => http(url)))
  const publicClient = createPublicClient({ chain: base, transport })
  const walletClient = createWalletClient({ account, chain: base, transport })

  const usdcHash = await walletClient.writeContract({
    address: getAddress(LIM_USDC_ADDRESS) as `0x${string}`,
    abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
    functionName: 'approve',
    args: [getAddress(spender) as `0x${string}`, MAX_UINT256],
  })
  log('info', 'Lim', `USDC approval tx: ${usdcHash} — waiting for confirmation...`)
  // Must wait for first tx to be mined before sending second — same nonce otherwise
  await publicClient.waitForTransactionReceipt({ hash: usdcHash })
  log('info', 'Lim', `USDC approval confirmed`)

  // CTF ERC-1155 approval — required for the exchange to move conditional tokens on SELL orders
  const ctfHash = await walletClient.writeContract({
    address: getAddress(CTF_ADDRESS) as `0x${string}`,
    abi: parseAbi(['function setApprovalForAll(address operator, bool approved)']),
    functionName: 'setApprovalForAll',
    args: [getAddress(spender) as `0x${string}`, true],
  })
  log('info', 'Lim', `CTF setApprovalForAll tx: ${ctfHash} (operator: ${spender})`)

  return { usdcTxHash: usdcHash, ctfTxHash: ctfHash, spender }
}

// ── Pending-claims persistence (survives restarts) ────────────────────────────

const PENDING_CLAIMS_KEY = 'poly:lim:pending-claims'

interface PendingClaim {
  slug: string
  expiresAt: number
  yesTokenId: string
  noTokenId: string
  tradedAt: number
}

async function savePendingClaim(market: LimMarketInfo): Promise<void> {
  try {
    const raw = await rGet(PENDING_CLAIMS_KEY)
    const claims: PendingClaim[] = raw ? JSON.parse(raw) as PendingClaim[] : []
    if (!claims.find(c => c.slug === market.slug)) {
      claims.push({ slug: market.slug, expiresAt: market.expiresAt, yesTokenId: market.yesTokenId, noTokenId: market.noTokenId, tradedAt: Date.now() })
      await rSet(PENDING_CLAIMS_KEY, JSON.stringify(claims))
    }
  } catch (err) { log('warn', 'Lim', `savePendingClaim failed: ${(err as Error).message}`) }
}

async function removePendingClaim(slug: string): Promise<void> {
  try {
    const raw = await rGet(PENDING_CLAIMS_KEY)
    if (!raw) return
    const claims = (JSON.parse(raw) as PendingClaim[]).filter(c => c.slug !== slug)
    await rSet(PENDING_CLAIMS_KEY, JSON.stringify(claims))
  } catch (err) { log('warn', 'Lim', `removePendingClaim failed: ${(err as Error).message}`) }
}

// ── Auto-redeem resolved positions ────────────────────────────────────────────

const CTF_ADDRESS = '0xC9c98965297Bc527861c898329Ee280632B76e18'
let _lastRedeemAt = 0

export async function redeemLimPositions(): Promise<void> {
  // Throttle: at most once every 2 minutes to avoid RPC rate limits
  if (Date.now() - _lastRedeemAt < 2 * 60_000) return
  _lastRedeemAt = Date.now()

  const creds = await getLimCreds()
  if (!creds?.privateKey || !creds?.walletAddress) return

  const now = Date.now()
  // Build a flat slug→info lookup from in-memory maps
  const allBySlug = new Map<string, LimMarketInfo>()
  for (const m of _markets.values()) allBySlug.set(m.slug, m)
  for (const [slug, m] of _expiredMarkets) allBySlug.set(slug, m)

  // Merge in persisted claims from Redis — ensures we catch positions after a restart
  try {
    const raw = await rGet(PENDING_CLAIMS_KEY)
    if (raw) {
      const persisted = JSON.parse(raw) as PendingClaim[]
      // Prune stale claims older than 2 hours before merging
      const fresh = persisted.filter(c => c.tradedAt > now - 2 * 60 * 60_000)
      if (fresh.length !== persisted.length) {
        await rSet(PENDING_CLAIMS_KEY, JSON.stringify(fresh)).catch(() => {})
      }
      for (const c of fresh) {
        _tradedSlugs.add(c.slug)
        if (!allBySlug.has(c.slug)) {
          allBySlug.set(c.slug, { slug: c.slug, title: '', expiresAt: c.expiresAt, yesTokenId: c.yesTokenId, noTokenId: c.noTokenId })
        }
      }
    }
  } catch { /* proceed with in-memory data */ }

  // Only check slugs we actually traded — avoids unnecessary on-chain RPC calls
  const candidates = new Map<string, LimMarketInfo>()
  for (const slug of _tradedSlugs) {
    const m = allBySlug.get(slug)
    if (m && m.expiresAt > 0 && m.expiresAt < now) candidates.set(slug, m)
  }
  if (candidates.size === 0) return

  const { createPublicClient, createWalletClient, http, parseAbi, getAddress, fallback } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const { base } = await import('viem/chains')

  const pk = creds.privateKey.startsWith('0x') ? creds.privateKey : `0x${creds.privateKey}`
  const account = privateKeyToAccount(pk as `0x${string}`)
  const BASE_RPCS = [config.limitless.baseRpc, 'https://base.llamarpc.com', 'https://base.drpc.org']
  const transport = fallback(BASE_RPCS.map(url => http(url)))
  const publicClient = createPublicClient({ chain: base, transport })
  const walletClient = createWalletClient({ account, chain: base, transport })

  const ctfAbi = parseAbi([
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  ])
  const ZERO_COLLECTION = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`

  const fetcher = getMarketFetcher()
  for (const market of candidates.values()) {
    try {
      trackLimCall()
      const detail = await fetcher.getMarket(market.slug) as {
        winningOutcomeIndex?: number | null
        conditionId?: string
        tokens?: { yes?: string; no?: string }
      }
      if (detail.winningOutcomeIndex == null) continue

      const isYes = detail.winningOutcomeIndex === 0
      const winningTokenId = isYes ? BigInt(detail.tokens?.yes ?? '0') : BigInt(detail.tokens?.no ?? '0')
      if (winningTokenId === 0n) continue

      const balance = await publicClient.readContract({
        address: getAddress(CTF_ADDRESS) as `0x${string}`,
        abi: ctfAbi,
        functionName: 'balanceOf',
        args: [getAddress(creds.walletAddress) as `0x${string}`, winningTokenId],
      })

      if (balance === 0n) {
        _expiredMarkets.delete(market.slug)
        _tradedSlugs.delete(market.slug)
        removePendingClaim(market.slug).catch(() => {})
        continue
      }

      // indexSet = 2^winningOutcomeIndex (bit mask for CTF outcome slot)
      const indexSet = 1n << BigInt(detail.winningOutcomeIndex)
      log('info', 'Lim', `redeeming ${market.slug} — ${balance} tokens, outcome ${detail.winningOutcomeIndex} (${isYes ? 'YES' : 'NO'})`)

      const hash = await walletClient.writeContract({
        address: getAddress(CTF_ADDRESS) as `0x${string}`,
        abi: ctfAbi,
        functionName: 'redeemPositions',
        args: [
          getAddress(LIM_USDC_ADDRESS) as `0x${string}`,
          ZERO_COLLECTION,
          detail.conditionId as `0x${string}`,
          [indexSet],
        ],
      })

      log('info', 'Lim', `redeemPositions tx: ${hash} — ${market.slug}`)
      _expiredMarkets.delete(market.slug)
      _tradedSlugs.delete(market.slug)
      removePendingClaim(market.slug).catch(() => {})
      // Bust balance cache so next poll shows updated portfolio value
      _balanceCached = null
      _balanceCachedAt = 0
    } catch (err) {
      log('warn', 'Lim', `redeem failed for ${market.slug}: ${(err as Error).message}`)
    }
  }
}

// outcome: 'yes' = buy YES token (DOWN arb), 'no' = buy NO token (UP arb)
export async function placeLimOrder(slug: string, outcome: 'yes' | 'no', usdcAmount: number): Promise<unknown> {
  await waitSlot()

  const client = await getLimOrderClient()
  if (!client) throw new Error('Limitless private key not configured — add it in Settings → Limitless HMAC → Private Key')

  const market = [..._markets.values()].find(m => m.slug === slug)
  if (!market) throw new Error(`Lim market not found for slug: ${slug}`)

  const tokenId = outcome === 'yes' ? market.yesTokenId : market.noTokenId
  if (!tokenId) throw new Error(`Lim ${outcome} tokenId missing for ${slug} — market may not have loaded yet`)

  _tradedSlugs.add(slug)
  savePendingClaim(market).catch(() => {})  // persist so auto-redeem survives restarts
  trackLimCall()
  return client.createOrder({
    tokenId,
    makerAmount: usdcAmount,   // USDC to spend (FOK: fill at any price)
    side: Side.BUY,
    orderType: OrderType.FOK,
    marketSlug: slug,
  })
}

// Close (sell) an open Lim position. tokenShares = number of tokens to sell (not USDC).
export async function closeLimPosition(slug: string, outcome: 'yes' | 'no', tokenShares: number): Promise<unknown> {
  await waitSlot()

  const client = await getLimOrderClient()
  if (!client) throw new Error('Limitless private key not configured')

  const market = [..._markets.values()].find(m => m.slug === slug)
  if (!market) throw new Error(`Lim market not found for slug: ${slug} — market may have expired`)

  const tokenId = outcome === 'yes' ? market.yesTokenId : market.noTokenId
  if (!tokenId) throw new Error(`Lim ${outcome} tokenId missing for ${slug}`)

  // Round to 6 decimal places — exchange rejects values with more precision
  const rounded = Math.round(tokenShares * 1_000_000) / 1_000_000

  trackLimCall()
  return client.createOrder({
    tokenId,
    makerAmount: rounded,  // token shares to sell (FOK: fill at best bid)
    side: Side.SELL,
    orderType: OrderType.FOK,
    marketSlug: slug,
  })
}
