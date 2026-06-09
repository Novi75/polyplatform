/**
 * Polymarket exchange integration — crypto markets for all timeframes (5min, 15min, 1h).
 * Handles: WS subscription, live prices, order placement, balance, positions.
 */
import { createSecureClient, OrderSide, relayerApiKey } from '@polymarket/client'
import { privateKey as viemPrivateKey } from '@polymarket/client/viem'
import type { SecureClient } from '@polymarket/client'
import { createHmac } from 'crypto'
import WebSocket from 'ws'
import { config } from '../config.js'
import { rGet, rSet, decrypt } from '../db/redis.js'
import { log } from '../logger.js'

export const CRYPTO_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'] as const
export type CryptoAsset = typeof CRYPTO_ASSETS[number]

export const TIMEFRAMES = ['5min', '15min', '1h'] as const
export type MarketTimeframe = typeof TIMEFRAMES[number]

export function detectTimeframe(text: string): MarketTimeframe | null {
  // Duration labels (Limitless format): "hourly", "5 min", "15 min", "1 hour", "1-Hour", "60 min", etc.
  if (/\b(hourly|1[-\s]*(h(our)?|hr)|60[-\s]*min)\b/i.test(text)) return '1h'
  if (/\b15[-\s]*min/i.test(text)) return '15min'
  if (/\b5[-\s]*min/i.test(text)) return '5min'

  // Polymarket format: absolute time range like "6:55AM-7:00AM ET" or "6:45AM-7:00AM ET"
  const rangeMatch = text.match(
    /(\d{1,2})(?::(\d{2}))?\s*([AP]M)\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*([AP]M)/i,
  )
  if (rangeMatch) {
    const toMin = (h: string, m: string | undefined, ap: string): number => {
      let hours = parseInt(h) % 12
      if (/p/i.test(ap)) hours += 12
      return hours * 60 + parseInt(m ?? '0')
    }
    const dur = ((toMin(rangeMatch[4], rangeMatch[5], rangeMatch[6]) -
                  toMin(rangeMatch[1], rangeMatch[2], rangeMatch[3])) + 1440) % 1440
    if (dur === 5)  return '5min'
    if (dur === 15) return '15min'
    if (dur === 60) return '1h'
  }

  // Polymarket hourly format: single whole-hour time like "6AM ET" (no colon = hourly boundary)
  if (/\b\d{1,2}[AP]M\b/i.test(text) && !/\d:\d{2}/.test(text)) return '1h'

  return null
}

export const MAX_FUTURE_MS: Record<MarketTimeframe, number> = {
  '5min':  12 * 60_000,   // Poly pre-publishes ~10 min before 5min window opens
  '15min': 45 * 60_000,   // Poly pre-publishes well before; Lim opens ~15 min out
  '1h':    90 * 60_000,   // keep both exchanges' 1h markets in sync
}

export interface LivePrice { bid: number; ask: number; ts: number }

export interface PolyMarketInfo {
  conditionId: string
  yesTokenId: string
  noTokenId: string | null
  expiresAt: number   // unix ms
}

// ── In-memory stores ──────────────────────────────────────────────────────────

const _prices = new Map<string, LivePrice>()         // tokenId → price
const _markets = new Map<string, PolyMarketInfo>()   // "ASSET-timeframe" → token IDs

// ── Market discovery ──────────────────────────────────────────────────────────

// Keyword map matching the Limitless asset names
const ASSET_KEYWORDS: Record<CryptoAsset, string[]> = {
  BTC: ['bitcoin', 'btc'],
  ETH: ['ethereum', 'eth'],
  SOL: ['solana', 'sol'],
  XRP: ['xrp', 'ripple'],
  DOGE: ['dogecoin', 'doge'],
  BNB: ['bnb', 'binance'],
  HYPE: ['hyperliquid', 'hype'],
}

function detectAsset(text: string): CryptoAsset | null {
  const t = text.toLowerCase()
  for (const [asset, kws] of Object.entries(ASSET_KEYWORDS)) {
    if (kws.some(kw => t.includes(kw))) return asset as CryptoAsset
  }
  return null
}

function isPolyUpDown(question: string): boolean {
  return /\bup\s+or\s+down\b/i.test(question)
}

interface GammaMarket {
  conditionId: string
  question: string
  active: boolean
  closed: boolean
  endDate: string       // ISO datetime e.g. "2026-05-24T16:10:00Z"
  endDateIso: string    // date only e.g. "2026-05-24"
  outcomes: string[]    // ["Up", "Down"]
  clobTokenIds: string[] // [upTokenId, downTokenId]
  bestBid?: number
  bestAsk?: number
}

const GAMMA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://polymarket.com',
  'Referer': 'https://polymarket.com/',
}

async function fetchGammaPage(params: URLSearchParams): Promise<GammaMarket[]> {
  const url = `${config.polymarket.gammaHost}/markets?${params}`
  let resp: Response | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 2_000))
    resp = await fetch(url, { headers: GAMMA_HEADERS })
    if (resp.ok) break
    if (resp.status < 500) break
    log('warn', 'Poly', `Gamma API ${resp.status} (attempt ${attempt + 1}/4) — retrying`)
  }
  if (!resp!.ok) throw new Error(`Gamma API ${resp!.status}`)
  return resp!.json() as Promise<GammaMarket[]>
}

async function fetchGammaAll(base: URLSearchParams): Promise<GammaMarket[]> {
  const p1 = await fetchGammaPage(base)
  if (p1.length < 100) return p1
  const p2Params = new URLSearchParams(base)
  p2Params.set('offset', '100')
  const p2 = await fetchGammaPage(p2Params)
  return [...p1, ...p2]
}

export async function fetchPolyMarkets(): Promise<void> {
  try {
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()

    // First call: markets from now — gets 5min and 15min (1h markets pushed past 100-result cap)
    const page1 = await fetchGammaPage(new URLSearchParams({
      active: 'true', closed: 'false', limit: '100',
      end_date_min: nowIso,
      order: 'endDate', ascending: 'true',
    }))

    // Additional calls: target each whole-hour boundary within MAX_FUTURE_MS to find 1h markets.
    // The Gamma API caps at 100 results; 5min/15min markets fill all slots in the first call,
    // so 1h markets (which expire exactly on the hour) never appear there.
    // At the 4PM ET stock-close window, Poly only publishes 4h markets for most assets but a true
    // 1h market for the NEXT hour (e.g. 5PM ET) — loop both boundaries to catch it.
    const hourPages: GammaMarket[] = []
    let nextHourMs = Math.ceil((nowMs + 1) / 3_600_000) * 3_600_000
    while (nextHourMs <= nowMs + MAX_FUTURE_MS['1h']) {
      const page = await fetchGammaAll(new URLSearchParams({
        active: 'true', closed: 'false', limit: '100',
        end_date_min: new Date(nextHourMs - 60_000).toISOString(),
        end_date_max: new Date(nextHourMs + 60_000).toISOString(),
        order: 'endDate', ascending: 'true',
      }))
      hourPages.push(...page)
      nextHourMs += 3_600_000
    }

    const markets = [...page1, ...hourPages]
    _markets.clear()

    let found = 0
    for (const m of markets) {
      if (!isPolyUpDown(m.question ?? '')) continue
      const asset = detectAsset(m.question)
      if (!asset) continue
      const tf = detectTimeframe(m.question ?? '')
      if (!tf) { log('info', 'Poly', `no-tf: ${JSON.stringify(m.question ?? '')}`); continue }
      const mk = `${asset}-${tf}`
      if (_markets.has(mk)) continue

      const tokenIds = m.clobTokenIds ?? []
      if (tokenIds.length < 1) continue

      // outcomes[0] = "Up" (YES), outcomes[1] = "Down" (NO)
      // The Gamma API returns outcomes as a JSON string — parse if needed
      const rawOutcomes = m.outcomes
      const outcomes: string[] = Array.isArray(rawOutcomes) ? rawOutcomes
        : typeof rawOutcomes === 'string' ? JSON.parse(rawOutcomes) as string[]
        : []
      const rawTokenIds = m.clobTokenIds
      const parsedTokenIds: string[] = Array.isArray(rawTokenIds) ? rawTokenIds
        : typeof rawTokenIds === 'string' ? JSON.parse(rawTokenIds) as string[]
        : tokenIds
      const upIdx   = outcomes.findIndex(o => /^up$/i.test(o))
      const downIdx = outcomes.findIndex(o => /^down$/i.test(o))
      const yesTokenId = parsedTokenIds[upIdx >= 0 ? upIdx : 0]
      const noTokenId  = downIdx >= 0 ? (parsedTokenIds[downIdx] ?? null) : (parsedTokenIds[1] ?? null)

      const expiresAt = m.endDate ? new Date(m.endDate).getTime() : 0
      // Only accept markets for the current window — reject anything expiring beyond the timeframe's max future
      if (expiresAt > 0 && expiresAt > Date.now() + MAX_FUTURE_MS[tf]) continue
      _markets.set(mk, { conditionId: m.conditionId, yesTokenId, noTokenId, expiresAt })

      // Seed live prices from snapshot if available
      if (m.bestBid != null && m.bestAsk != null && yesTokenId) {
        setPolyPrice(yesTokenId, m.bestBid, m.bestAsk)
      }
      found++
    }
    const expiryTimes = [..._markets.entries()].map(([k, m]) => `${k}@${new Date(m.expiresAt).toISOString().slice(11, 16)}Z`).join(' ')
    log('info', 'Poly', `markets: ${_markets.size} pairs — ${expiryTimes}`)
  } catch (err) {
    log('warn', 'Poly', `market fetch failed: ${(err as Error).message}`)
  }
}

// Keep old name as alias for any callers that haven't been updated yet
export const fetchPoly5MinMarkets = fetchPolyMarkets

export function getPolyMarkets(): ReadonlyMap<string, PolyMarketInfo> { return _markets }
export function getPolyMarketExpiry(key: string): number { return _markets.get(key)?.expiresAt ?? 0 }

// ── Live price store ──────────────────────────────────────────────────────────

export function setPolyPrice(tokenId: string, bid: number, ask: number): void {
  _prices.set(tokenId, { bid, ask, ts: Date.now() })
}

export function getPolyTokenPrice(tokenId: string): LivePrice | null {
  return _prices.get(tokenId) ?? null
}

export function getPolyAssetPrice(key: string): { yes: LivePrice | null; no: LivePrice | null } | null {
  const m = _markets.get(key)
  if (!m) return null
  return {
    yes: getPolyTokenPrice(m.yesTokenId),
    no: m.noTokenId ? getPolyTokenPrice(m.noTokenId) : null,
  }
}

// ── WebSocket subscription ────────────────────────────────────────────────────

let _polyWs: WebSocket | null = null
let _heartbeat: ReturnType<typeof setInterval> | null = null
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null
let _polyWsStopped = true
let _polyWsCallback: PriceCallback | null = null
let _polyWatchdog: ReturnType<typeof setInterval> | null = null
let _lastPolyWsUpdate = 0   // last time any price arrived over WS
let _polyWsConnectedAt = 0  // last time the socket reached OPEN state

type PriceCallback = (key: string) => void

function _connectPolyWs(): void {
  if (_polyWsStopped || !_polyWsCallback) return
  // Prevent concurrent connection attempts
  if (_polyWs && _polyWs.readyState === WebSocket.CONNECTING) return

  const tokenToKey = new Map<string, string>()
  for (const [key, m] of _markets) {
    tokenToKey.set(m.yesTokenId, key)
    if (m.noTokenId) tokenToKey.set(m.noTokenId, key)
  }
  if (tokenToKey.size === 0) { log('warn', 'Poly', 'no tokens — skipping WS connect'); return }

  const tokenIds = [...tokenToKey.keys()]
  const cb = _polyWsCallback

  const ws = new WebSocket(config.polymarket.wsHost)
  _polyWs = ws

  ws.on('open', () => {
    if (_heartbeat) clearInterval(_heartbeat)
    _heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('PING') }, 10_000)
    _polyWsConnectedAt = Date.now()
    ws.send(JSON.stringify({ assets_ids: tokenIds, type: 'market', initial_dump: true, level: 2, custom_feature_enabled: true }))
    log('info', 'Poly', 'WS connected')
  })

  ws.on('message', (raw: Buffer) => {
    const str = raw.toString()
    if (str === 'PONG') return
    try {
      const msg = JSON.parse(str) as unknown
      const events = Array.isArray(msg) ? msg as Record<string, unknown>[] : [msg as Record<string, unknown>]
      for (const ev of events) {
        const etype = ev['event_type'] as string | undefined
        const assetId = ev['asset_id'] as string | undefined
        if (!assetId) continue
        if (etype === 'best_bid_ask' || etype === 'price_change') {
          const bid = parseFloat((ev['best_bid'] as string) ?? '0')
          const ask = parseFloat((ev['best_ask'] as string) ?? '0')
          if (isNaN(bid) || isNaN(ask) || (bid === 0 && ask === 0)) continue
          setPolyPrice(assetId, bid, ask)
          _lastPolyWsUpdate = Date.now()
          const key = tokenToKey.get(assetId)
          if (key) cb(key)
        } else if (etype === 'book') {
          const bids = ev['bids'] as Array<{ price: string }> | undefined
          const asks = ev['asks'] as Array<{ price: string }> | undefined
          const bid = parseFloat(bids?.[0]?.price ?? '0')
          const ask = parseFloat(asks?.[0]?.price ?? '0')
          if (bid > 0 || ask > 0) {
            setPolyPrice(assetId, bid, ask)
            _lastPolyWsUpdate = Date.now()
            const key = tokenToKey.get(assetId)
            if (key) cb(key)
          }
        }
      }
    } catch { /* ignore parse errors */ }
  })

  ws.on('error', (err) => log('warn', 'Poly', `WS error: ${err.message}`))
  ws.on('close', () => {
    if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null }
    if (_polyWs === ws) {
      // This was the active socket — clear it and schedule a reconnect
      _polyWs = null
      log('info', 'Poly', 'WS closed')
      if (!_polyWsStopped) {
        if (_reconnectTimer) clearTimeout(_reconnectTimer)
        _reconnectTimer = setTimeout(() => { _reconnectTimer = null; _connectPolyWs() }, 2_000)
      }
    }
    // If _polyWs !== ws, this was a replaced socket — new connection already active, no reconnect needed
  })
}

function _runPolyWatchdog(): void {
  if (_polyWsStopped) return
  const now = Date.now()
  // Never received data after being connected for 15s — initial subscription may have been lost
  const neverReceived = _lastPolyWsUpdate === 0 && _polyWsConnectedAt > 0 && now - _polyWsConnectedAt > 15_000
  // Had data before but nothing in the last 30s — subscription silently dropped
  const stale = _lastPolyWsUpdate > 0 && now - _lastPolyWsUpdate > 30_000
  if (neverReceived || stale) {
    log('warn', 'Poly', `WS watchdog: reconnecting (neverReceived=${neverReceived}, staleSec=${stale ? Math.round((now - _lastPolyWsUpdate) / 1000) : 0})`)
    _lastPolyWsUpdate = 0
    _polyWsConnectedAt = 0
    if (_polyWs) { _polyWs.terminate(); _polyWs = null }
    if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null }
    _connectPolyWs()
  }
}

export async function startPolyWs(onUpdate: PriceCallback): Promise<void> {
  _polyWsStopped = false
  _polyWsCallback = onUpdate
  // Cancel any pending reconnect before tearing down the current socket
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
  if (_polyWs) { _polyWs.terminate(); _polyWs = null }
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null }
  _lastPolyWsUpdate = 0
  _polyWsConnectedAt = 0
  if (!_polyWatchdog) _polyWatchdog = setInterval(_runPolyWatchdog, 10_000)
  log('info', 'Poly', `WS subscribing to ${[..._markets.values()].length * 2} tokens`)
  _connectPolyWs()
}

export async function stopPolyWs(): Promise<void> {
  _polyWsStopped = true
  _polyWsCallback = null
  if (_polyWatchdog) { clearInterval(_polyWatchdog); _polyWatchdog = null }
  if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null }
  if (_polyWs) { _polyWs.terminate(); _polyWs = null }
  _lastPolyWsUpdate = 0
  _polyWsConnectedAt = 0
}

// ── Authenticated client ──────────────────────────────────────────────────────

let _client: SecureClient | null = null
let _clientPrivKey: string | null = null
let _clientProxyAddress: string | null = null
let _clientApiKey: string | null = null
let _clientRelayerKey: string | null = null

export async function getPolyClient(): Promise<SecureClient> {
  const raw = await rGet('poly:settings:wallets')
  if (!raw) throw new Error('Polymarket private key not configured')
  const wallets = JSON.parse(decrypt(raw)) as { polymarketPrivKey?: string; polyProxyAddress?: string }
  if (!wallets.polymarketPrivKey) throw new Error('Polymarket private key not set')
  const { polymarketPrivKey, polyProxyAddress } = wallets
  const apiCredsRaw = await rGet('poly:settings:polymarket')
  const apiCreds = apiCredsRaw ? JSON.parse(decrypt(apiCredsRaw)) as { apiKey: string; secret: string; passphrase: string } : null
  const relayerRaw = await rGet('poly:settings:relayer')
  const relayerCreds = relayerRaw ? JSON.parse(decrypt(relayerRaw)) as { relayerKey: string; relayerAddress: string } : null
  if (
    _client &&
    _clientPrivKey === polymarketPrivKey &&
    _clientProxyAddress === (polyProxyAddress ?? null) &&
    _clientApiKey === (apiCreds?.apiKey ?? null) &&
    _clientRelayerKey === (relayerCreds?.relayerKey ?? null)
  ) return _client
  const { privateKeyToAccount } = await import('viem/accounts')
  const account = privateKeyToAccount(polymarketPrivKey as `0x${string}`)
  // Use proxy wallet address when configured (Polymarket CLOB requires the proxy/deposit wallet as maker, not EOA)
  const walletAddress = polyProxyAddress ?? account.address
  _client = await createSecureClient({
    wallet: walletAddress,
    signer: viemPrivateKey(polymarketPrivKey),
    ...(apiCreds ? { credentials: { key: apiCreds.apiKey, secret: apiCreds.secret, passphrase: apiCreds.passphrase } } : {}),
    ...(relayerCreds ? { apiKey: relayerApiKey({ key: relayerCreds.relayerKey, address: relayerCreds.relayerAddress }) } : {}),
  })
  _clientPrivKey = polymarketPrivKey
  _clientProxyAddress = polyProxyAddress ?? null
  _clientApiKey = apiCreds?.apiKey ?? null
  _clientRelayerKey = relayerCreds?.relayerKey ?? null
  log('info', 'Poly', `client ready — ${walletAddress}${polyProxyAddress ? ' (proxy)' : ''}${apiCreds ? ' +creds' : ''}${relayerCreds ? ' +relayer' : ''}`)
  return _client
}

export function invalidatePolyClient(): void { _client = null; _clientPrivKey = null; _clientProxyAddress = null; _clientApiKey = null; _clientRelayerKey = null }

export async function getPolyAddress(): Promise<string | null> {
  try {
    const raw = await rGet('poly:settings:wallets')
    if (!raw) return null
    const wallets = JSON.parse(decrypt(raw)) as { polymarketPrivKey?: string; polyProxyAddress?: string }
    if (wallets.polyProxyAddress) return wallets.polyProxyAddress
    if (!wallets.polymarketPrivKey) return null
    const { privateKeyToAccount } = await import('viem/accounts')
    return privateKeyToAccount(wallets.polymarketPrivKey as `0x${string}`).address
  } catch { return null }
}

// ── REST helpers (balance uses authenticated CLOB API) ────────────────────────

interface ApiCreds { apiKey: string; secret: string; passphrase: string }

async function getApiCreds(): Promise<{ creds: ApiCreds; address: string } | null> {
  try {
    const [credsRaw, walletRaw] = await Promise.all([rGet('poly:settings:polymarket'), rGet('poly:settings:wallets')])
    if (!credsRaw || !walletRaw) return null
    const creds = JSON.parse(decrypt(credsRaw)) as ApiCreds
    const { polymarketPrivKey } = JSON.parse(decrypt(walletRaw)) as { polymarketPrivKey?: string }
    if (!polymarketPrivKey) return null
    const { privateKeyToAccount } = await import('viem/accounts')
    const address = privateKeyToAccount(polymarketPrivKey as `0x${string}`).address
    return { creds, address }
  } catch { return null }
}

function buildAuthHeaders(creds: ApiCreds, address: string, method: string, path: string, body = ''): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString()
  const sigPath = path.split('?')[0]
  const msg = ts + method.toUpperCase() + sigPath + body
  const key = Buffer.from(creds.secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const sig = createHmac('sha256', key).update(msg).digest('base64').replace(/\+/g, '-').replace(/\//g, '_')
  return { 'Content-Type': 'application/json', POLY_ADDRESS: address, POLY_API_KEY: creds.apiKey, POLY_PASSPHRASE: creds.passphrase, POLY_TIMESTAMP: ts, POLY_SIGNATURE: sig }
}

let _polyBalCached: string | null = null
let _polyBalCachedAt = 0

export async function getPolyBalance(): Promise<string | null> {
  if (Date.now() - _polyBalCachedAt < 10_000 && _polyBalCached !== null) return _polyBalCached
  try {
    const auth = await getApiCreds()
    if (!auth) return null
    for (const sigType of [0, 1, 2, 3]) {
      const path = `/balance-allowance?asset_type=COLLATERAL&signature_type=${sigType}`
      const res = await fetch(`${config.polymarket.clobHost}${path}`, { headers: buildAuthHeaders(auth.creds, auth.address, 'GET', path) })
      if (!res.ok) continue
      const data = await res.json() as { balance?: string }
      if (data.balance && data.balance !== '0') {
        _polyBalCached = (parseFloat(data.balance) / 1_000_000).toFixed(2)
        _polyBalCachedAt = Date.now()
        return _polyBalCached
      }
    }
    _polyBalCached = '0.00'
    _polyBalCachedAt = Date.now()
    return _polyBalCached
  } catch { return null }
}

export async function getPolyPositions(): Promise<unknown[]> {
  try {
    const client = await getPolyClient()
    const page = await (client as unknown as Record<string, (...a: unknown[]) => unknown>)['getPositions']?.()
      ?? await client.listPositions({}).firstPage()
    // SDK wraps response in {items:[]} or {data:[]} or returns array directly
    const r = page as Record<string, unknown>
    const data: unknown[] = Array.isArray(page) ? page
      : Array.isArray(r['items'])     ? r['items'] as unknown[]
      : Array.isArray(r['data'])      ? r['data'] as unknown[]
      : Array.isArray(r['positions']) ? r['positions'] as unknown[]
      : []
    return data
  } catch (err) {
    log('warn', 'Poly', `getPolyPositions error: ${(err as Error).message}`)
    return []
  }
}

export function getPolyTokenToKeyMap(): Map<string, { key: string; outcome: 'yes' | 'no' }> {
  const map = new Map<string, { key: string; outcome: 'yes' | 'no' }>()
  for (const [key, m] of _markets) {
    if (m.yesTokenId) map.set(m.yesTokenId, { key, outcome: 'yes' })
    if (m.noTokenId)  map.set(m.noTokenId,  { key, outcome: 'no' })
  }
  return map
}

// ── Order placement ───────────────────────────────────────────────────────────

export interface PolyOrderResult {
  raw: unknown
  // Actual tokens received on a BUY (takerAmount from CLOB, in base units ÷ 1e6)
  tokensReceived: number | null
}

export async function placePolyOrder(tokenId: string, side: 'BUY' | 'SELL', amount: number): Promise<PolyOrderResult> {
  if (side === 'BUY') {
    // Pre-flight balance check using 10s cache — avoids confusing raw microUSDC API errors
    const bal = await getPolyBalance()
    if (bal !== null && parseFloat(bal) < amount - 0.001) {
      throw new Error(`insufficient Poly balance: have $${bal}, need $${amount.toFixed(4)}`)
    }
  }
  const client = await getPolyClient()
  const raw = side === 'BUY'
    ? await client.placeMarketOrder({ tokenId, side: OrderSide.BUY, amount })
    : await client.placeMarketOrder({ tokenId, side: OrderSide.SELL, shares: amount })
  const r = raw as Record<string, unknown>
  // SDK response uses takingAmount (camelCase) for tokens received on a BUY, in base units (÷1e6)
  const takerRaw = r['takingAmount'] ?? r['takerAmount'] ?? r['taker_amount'] ?? r['filledAmount'] ?? r['filled_amount']
  const tokensReceived = side === 'BUY' && takerRaw != null ? parseFloat(String(takerRaw)) / 1e6 : null
  log('info', 'Poly', `order ${side} token=${tokenId.slice(0, 12)}… size=${amount} → status=${r['status'] ?? r['orderStatus'] ?? '?'} takerAmount=${takerRaw ?? '?'} tokensReceived=${tokensReceived ?? '?'} errorMsg=${r['errorMsg'] ?? r['error_msg'] ?? 'none'}`)
  return { raw, tokensReceived }
}

// ── Resting limit orders (used by the Buzzer Beater strategy) ────────────────
// Unlike placePolyOrder (market orders that cross the spread), these rest a
// GTC limit order on the book — it only fills if/when the market comes to it.

export interface PolyLimitOrderResult {
  ok: boolean
  orderId: string | null
  raw: unknown
}

export async function placePolyLimitOrder(tokenId: string, side: 'BUY' | 'SELL', price: number, size: number): Promise<PolyLimitOrderResult> {
  const client = await getPolyClient()
  const raw = await client.placeLimitOrder({
    tokenId,
    side: side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
    price,
    size,
    postOnly: true,   // never cross the spread — rejected instead of taking liquidity
  })
  const r = raw as Record<string, unknown>
  const orderId = (r['orderId'] ?? r['orderID'] ?? null) as string | null
  const ok = r['ok'] !== false && r['success'] !== false
  log('info', 'Poly', `limit ${side} token=${tokenId.slice(0, 12)}… price=${price} size=${size} → ok=${ok} orderId=${orderId ?? '?'} status=${r['status'] ?? '?'}`)
  return { ok, orderId, raw }
}

export async function cancelPolyOrder(orderId: string): Promise<void> {
  const client = await getPolyClient()
  await client.cancelOrder({ orderId })
  log('info', 'Poly', `cancelled order ${orderId.slice(0, 12)}…`)
}

export interface PolyOrderStatus {
  id: string
  status: string
  side: string
  price: number
  originalSize: number
  sizeMatched: number
}

export async function getPolyOrder(orderId: string): Promise<PolyOrderStatus | null> {
  try {
    const client = await getPolyClient()
    const o = await client.fetchOrder({ orderId })
    return {
      id: o.id,
      status: o.status,
      side: o.side,
      price: parseFloat(String(o.price)),
      originalSize: parseFloat(String(o.originalSize)),
      sizeMatched: parseFloat(String(o.sizeMatched)),
    }
  } catch (err) {
    log('warn', 'Poly', `getPolyOrder ${orderId.slice(0, 12)}… error: ${(err as Error).message}`)
    return null
  }
}

export async function redeemPolyPositions(conditionId: string): Promise<void> {
  const client = await getPolyClient()
  const handle = await client.redeemPositions({ conditionId })
  await handle.wait()
  log('info', 'Poly', `redeemPositions done — condition ${conditionId.slice(0, 16)}…`)
}

// Persist the cached signer address (used by old settings code path)
export async function cachePolyAddress(): Promise<void> {
  const address = await getPolyAddress()
  if (address) await rSet('poly:settings:polymarket:address', address).catch(() => {})
}
