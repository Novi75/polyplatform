import type { FastifyInstance } from 'fastify'
import {
  getEngineStatus, getTradeHistory, scanOpportunities, scanSignals, scanXtfOpportunities,
  applySettings, triggerManualArb, triggerManualSignal, triggerManualEarlyExit, triggerManualSpread,
  computeExitPnLPct, restartEngine,
  getPolyBalance, getPolyPositions, getLimBalance,
  getLeaderboard, getLeaderboardWindowCache, getTraderStats, getCopyTradeState, cacheTraderName, getArbSettings,
  type ArbSettings,
} from '../arb/engine.js'
import { CRYPTO_ASSETS, getPolyMarkets, getPolyTokenToKeyMap, detectTimeframe } from '../exchanges/poly.js'
import { getPolyAssetPrice, getPolyAddress } from '../exchanges/poly.js'
import { getLimAssetPrice, getLimMarkets, getLimCreds } from '../exchanges/lim.js'
import { log, getLogs } from '../logger.js'
import { rGet } from '../db/redis.js'

export async function dashboardRoutes(app: FastifyInstance) {

  app.get('/dashboard', async () => {
    const [polyBal, limBal, polyPos] = await Promise.allSettled([
      getPolyBalance(), getLimBalance(), getPolyPositions(),
    ])

    // Build exchange status for Settings credentials panel
    const [polyRaw, limRaw, walletRaw] = await Promise.all([
      rGet('poly:settings:polymarket'), rGet('poly:settings:limitless'), rGet('poly:settings:wallets'),
    ])
    const hasPolyWallet = !!walletRaw
    const hasPolyApi = !!polyRaw
    const polyAddress = await getPolyAddress()
    const limCreds = await getLimCreds()
    const polyStatus = {
      walletStored: hasPolyWallet,
      configured: hasPolyWallet && hasPolyApi,
      address: polyAddress,
      usdcBalance: polyBal.status === 'fulfilled' ? polyBal.value : null,
      positionCount: 0,
      openOrderCount: 0,
      feeRateBps: null,
      profileId: null,
      error: null,
    }
    const limStatus = {
      walletStored: !!limCreds?.walletAddress,
      configured: !!limCreds,
      address: limCreds?.walletAddress ?? null,
      usdcBalance: limBal.status === 'fulfilled' ? limBal.value : null,
      positionCount: 0,
      openOrderCount: 0,
      feeRateBps: null,
      profileId: null,
      error: null,
    }

    // Build assets using live market keys from both exchanges
    const assets: Record<string, unknown> = {}
    const polyKeys = new Set(getPolyMarkets().keys())
    const limKeys  = new Set(getLimMarkets().keys())
    const allKeys  = new Set([...polyKeys, ...limKeys])
    for (const key of allKeys) {
      const poly = getPolyAssetPrice(key)
      const lim  = getLimAssetPrice(key)
      assets[key] = {
        poly: poly ? { yesAsk: poly.yes?.ask ?? null, yesBid: poly.yes?.bid ?? null, noAsk: poly.no?.ask ?? null, noBid: poly.no?.bid ?? null } : null,
        lim:  lim  ? { yesAsk: lim.ask, yesBid: lim.bid } : null,
      }
    }

    const history = getTradeHistory(50)
    const wins = history.filter(t => t.success).length
    const totalPnl = history.reduce((sum, t) => sum + (t.success ? (t.profitPct / 100) * t.positionSize : 0), 0)

    return {
      engine: getEngineStatus(),
      assets,
      opportunities: scanOpportunities(),
      signals: scanSignals(),
      xtf: scanXtfOpportunities(),
      polymarket: polyStatus,
      limitless: limStatus,
      balances: {
        polymarket: polyBal.status === 'fulfilled' ? polyBal.value : null,
        limitless: limBal.status === 'fulfilled' ? limBal.value : null,
        polyAddress,
        limAddress: limCreds?.walletAddress ?? null,
      },
      positions: {
        polymarket: (() => {
          const now = Date.now()
          const openArb = getTradeHistory(200).filter(t => t.success && t.expiresAt > now)
          const arbPos = openArb.map(t => ({
            market: `${t.asset}${t.timeframe ? '-' + t.timeframe : ''} ${t.direction} arb`,
            side: 'BUY',
            size: t.positionSize,
            avgPrice: null,
            currentPrice: null,
            unrealizedPnl: +((t.profitPct / 100) * t.positionSize).toFixed(4),
            expiresIn: Math.round((t.expiresAt - now) / 1000),
          }))
          return [...arbPos, ...(polyPos.status === 'fulfilled' ? polyPos.value as unknown[] : [])]
        })(),
      },
      stats: {
        totalTrades: history.length,
        wins,
        winRate: history.length > 0 ? Math.round((wins / history.length) * 100) : 0,
        totalPnl: +totalPnl.toFixed(4),
      },
      recentTrades: history.slice(0, 20),
    }
  })

  app.get('/positions', async () => {
    const now = Date.now()
    const openTrades = getTradeHistory(200).filter(t => t.success && !t.earlyExited && t.expiresAt > now)
    const trackedTokenIds = new Set(openTrades.map(t => t.polyTokenId).filter(Boolean))

    const positions = openTrades.map(t => {
      const exitPnLPct = computeExitPnLPct(t)
      return {
        tradeId: t.id,
        asset: t.asset,
        timeframe: t.timeframe ?? '5min',
        direction: t.direction,
        type: t.type ?? 'arb',
        positionSize: t.positionSize,
        projectedProfitPct: +t.profitPct.toFixed(2),
        exitPnLPct: exitPnLPct != null ? +exitPnLPct.toFixed(2) : null,
        polyTokenId: t.polyTokenId,
        limSlug: t.limSlug,
        expiresIn: Math.round((t.expiresAt - now) / 1000),
        polyEntryPrice: t.polyEntryPrice ?? null,
        limEntryPrice: t.limEntryPrice ?? null,
        xtfShortKey: t.xtfShortKey ?? null,
        xtfLongKey: t.xtfLongKey ?? null,
        xtfShortExchange: t.xtfShortExchange ?? null,
        xtfLongExchange: t.xtfLongExchange ?? null,
        xtfShortOutcome: t.xtfShortOutcome ?? null,
        xtfLongOutcome: t.xtfLongOutcome ?? null,
        spreadYesPlatform: t.spreadYesPlatform ?? null,
        spreadNoPlatform: t.spreadNoPlatform ?? null,
        hedgeStatus: t.hedgeStatus ?? null,
        hedgeError: t.hedgeError ?? null,
      }
    })

    // Augment with live Poly CLOB positions not already in our trade log
    try {
      const livePos = await getPolyPositions()
      const tokenMap = getPolyTokenToKeyMap()
      for (const p of livePos) {
        const raw = p as Record<string, unknown>
        const tokenId = String(raw['tokenId'] ?? raw['asset_id'] ?? raw['asset'] ?? raw['token_id'] ?? '')
        if (!tokenId || tokenId === 'undefined' || tokenId === 'null') continue
        if (trackedTokenIds.has(tokenId)) continue
        const sharesRaw = parseFloat(String(raw['size'] ?? raw['shares'] ?? raw['amount'] ?? raw['balance'] ?? '0'))
        if (!(sharesRaw > 0)) continue
        const avgPrice = parseFloat(String(raw['avgPrice'] ?? raw['avg_price'] ?? raw['price'] ?? raw['entryPrice'] ?? '0'))

        // Parse actual expiry time — prefer full ISO, fall back to title time-range parsing, last resort end-of-day
        const endDateRaw = raw['end_date_iso'] ?? raw['endDate'] ?? raw['end_date'] ?? raw['expiration'] ?? null
        let endTs = 0
        if (endDateRaw) {
          const s = String(endDateRaw)
          if (/^\d{10}$/.test(s)) {
            endTs = Number(s) * 1000  // unix seconds
          } else if (/T|Z/.test(s) && s.includes(':')) {
            endTs = new Date(s).getTime()  // full ISO datetime
          } else {
            // Date-only ("2026-05-28") — try to extract end time from title ("...6:45AM-7:00AM ET")
            const title = String(raw['title'] ?? raw['question'] ?? '')
            const timeMatch = title.match(/-\s*(\d{1,2})(?::(\d{2}))?\s*([AP]M)/i)
            if (timeMatch) {
              let h = parseInt(timeMatch[1]) % 12
              if (/p/i.test(timeMatch[3])) h += 12
              const m = parseInt(timeMatch[2] ?? '0')
              // ET = UTC-4 in EDT (assume summer)
              const etOffsetMs = 4 * 3600_000
              const dayStart = new Date(s + 'T00:00:00Z').getTime()
              endTs = dayStart + (h * 3600 + m * 60) * 1000 + etOffsetMs
            } else {
              endTs = new Date(s + 'T23:59:59Z').getTime()  // last resort: end of day
            }
          }
        }
        // Skip positions that have been expired for more than 2 hours (likely resolved/redeemed)
        if (endTs > 0 && endTs < now - 2 * 3600_000) continue
        const tkEntry = tokenMap.get(tokenId)
        const key = tkEntry?.key
        // Prefer SDK outcome field ("Up"/"Down"), fall back to token map
        const outcomeRaw = String(raw['outcome'] ?? raw['side'] ?? '')
        const outcomeFromSdk: 'yes' | 'no' | null = /^up$/i.test(outcomeRaw) ? 'yes' : /^down$/i.test(outcomeRaw) ? 'no' : null
        const outcome = outcomeFromSdk ?? tkEntry?.outcome ?? 'yes'
        const direction: 'UP' | 'DOWN' = outcome === 'yes' ? 'UP' : 'DOWN'
        const question = String(raw['title'] ?? (raw['market'] as Record<string,unknown> | undefined)?.['question'] ?? raw['question'] ?? key ?? '')
        const tf = (key ? key.split('-').slice(1).join('-') : null) ?? detectTimeframe(question) ?? '5min'
        const assetRaw = key ? key.split('-')[0] : (() => {
          const q = question.toLowerCase()
          if (/bitcoin|btc/.test(q))      return 'BTC'
          if (/ethereum|eth/.test(q))     return 'ETH'
          if (/solana|sol/.test(q))       return 'SOL'
          if (/\bxrp\b|ripple/.test(q))  return 'XRP'
          if (/dogecoin|doge/.test(q))   return 'DOGE'
          if (/\bbnb\b|binance/.test(q)) return 'BNB'
          if (/hyperliquid|hype/.test(q)) return 'HYPE'
          return 'UNK'
        })()
        positions.push({
          tradeId: `poly-live-${tokenId.slice(0, 8)}`,
          asset: assetRaw as string,
          timeframe: tf,
          direction,
          type: 'arb' as const,
          positionSize: sharesRaw * (avgPrice || 1),
          projectedProfitPct: 0,
          exitPnLPct: null,
          polyTokenId: tokenId,
          limSlug: undefined,
          expiresIn: endTs > 0 ? Math.round((endTs - now) / 1000) : 0,
          polyEntryPrice: avgPrice || null,
          limEntryPrice: null,
          xtfShortKey: null, xtfLongKey: null,
          xtfShortExchange: null, xtfLongExchange: null,
          xtfShortOutcome: null, xtfLongOutcome: null,
        })
      }
    } catch { /* live sync is best-effort */ }

    return { positions }
  })

  // Shows all "up or down" markets from Gamma API with their detected asset/TF — useful for debugging 1h detection
  app.get('/debug/poly-markets-raw', async (_req, reply) => {
    try {
      const { config } = await import('../config.js')
      const { detectTimeframe } = await import('../exchanges/poly.js')
      const now = new Date().toISOString()
      const params = new URLSearchParams({ active: 'true', closed: 'false', limit: '100', end_date_min: now, order: 'endDate', ascending: 'true' })
      const resp = await fetch(`${config.polymarket.gammaHost}/markets?${params}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Origin': 'https://polymarket.com' },
      })
      if (!resp.ok) return reply.status(502).send({ error: `Gamma ${resp.status}` })
      const raw = await resp.json() as Array<Record<string, unknown>>
      const upDown = raw.filter(m => /up\s+or\s+down/i.test(String(m['question'] ?? '')))
      return {
        total: raw.length,
        upDown: upDown.length,
        markets: upDown.map(m => ({
          q: m['question'],
          endDate: m['endDate'],
          detectedTf: detectTimeframe(String(m['question'] ?? '')),
        })),
      }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  // Shows all Lim active markets with their title and detected TF — useful for 1h debugging
  app.get('/debug/lim-markets-raw', async () => {
    const { HttpClient, MarketFetcher } = await import('@limitless-exchange/sdk')
    const { detectTimeframe } = await import('../exchanges/poly.js')
    const fetcher = new MarketFetcher(new HttpClient())
    const all: { title: string; slug: string; detectedTf: string | null; expiry: string }[] = []
    for (let page = 1; page <= 8; page++) {
      const resp = await fetcher.getActiveMarkets({ page }) as { data?: Array<Record<string, unknown>> }
      const data = resp.data ?? []
      if (data.length === 0) break
      for (const m of data) {
        const title = String(m['title'] ?? '')
        if (!/up\s+or\s+down/i.test(title)) continue
        const expMs = m['expirationTimestamp'] ? Number(m['expirationTimestamp']) : 0
        all.push({ title, slug: String(m['slug'] ?? ''), detectedTf: detectTimeframe(title), expiry: expMs ? new Date(expMs).toISOString() : '?' })
      }
    }
    return { count: all.length, markets: all }
  })

  // Raw positions debug — shows exactly what the Poly SDK returns
  app.get('/debug/poly-positions-raw', async (_req, reply) => {
    try {
      const { getPolyClient } = await import('../exchanges/poly.js')
      const client = await getPolyClient()
      const page = await (client as unknown as Record<string, (...a: unknown[]) => unknown>)['getPositions']?.()
        ?? await client.listPositions({}).firstPage()
      return { ok: true, rawType: typeof page, isArray: Array.isArray(page), raw: page }
    } catch (err) {
      return reply.status(500).send({ ok: false, error: (err as Error).message })
    }
  })

  app.get('/trades', async (req) => {
    const limit = Math.min(parseInt((req.query as Record<string, string>)['limit'] ?? '100'), 200)
    return { trades: getTradeHistory(limit) }
  })

  app.get('/balances', async () => {
    const [polyBal, limBal] = await Promise.allSettled([getPolyBalance(), getLimBalance()])
    const polyAddress = await getPolyAddress()
    const limCreds = await getLimCreds()
    return {
      polymarket: polyBal.status === 'fulfilled' ? polyBal.value : null,
      limitless: limBal.status === 'fulfilled' ? limBal.value : null,
      polyAddress,
      limAddress: limCreds?.walletAddress ?? null,
    }
  })

  app.get('/logs', async () => ({ logs: getLogs() }))

  app.get('/debug/poly-proxy', async (_req, reply) => {
    try {
      const { rGet, decrypt } = await import('../db/redis.js')
      const walletRaw = await rGet('poly:settings:wallets')
      if (!walletRaw) return reply.status(400).send({ error: 'No wallet configured' })
      const wallets = JSON.parse(decrypt(walletRaw)) as { polymarketPrivKey?: string; polyProxyAddress?: string }
      if (!wallets.polymarketPrivKey) return reply.status(400).send({ error: 'No private key' })

      const { createSecureClient, production } = await import('@polymarket/client')
      const { privateKey: viemPrivKey } = await import('@polymarket/client/viem')
      const { privateKeyToAccount: pkToAccount } = await import('viem/accounts')
      const eoa = pkToAccount(wallets.polymarketPrivKey as `0x${string}`).address
      const walletAddr = wallets.polyProxyAddress ?? eoa

      const client = await createSecureClient({
        wallet: walletAddr,
        signer: viemPrivKey(wallets.polymarketPrivKey),
        environment: production,
      })

      const acct = (client as unknown as Record<string, unknown>).account as Record<string, unknown> | undefined
      return {
        signerAddress: acct?.signer ?? null,
        walletAddress: acct?.wallet ?? null,
        walletType: acct?.walletType ?? null,
        savedProxyAddress: wallets.polyProxyAddress ?? null,
        productionChainId: (production as unknown as Record<string, unknown>).chainId ?? null,
      }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  // Compute the Polymarket deposit wallet address deterministically from the EOA (CREATE2), then auto-save it
  app.post('/debug/poly-discover-proxy', async (_req, reply) => {
    try {
      const { rGet, rSet, decrypt, encrypt } = await import('../db/redis.js')
      const walletRaw = await rGet('poly:settings:wallets')
      if (!walletRaw) return reply.status(400).send({ error: 'No wallet configured' })

      const wallets = JSON.parse(decrypt(walletRaw)) as { polymarketPrivKey?: string; polyProxyAddress?: string }
      if (!wallets.polymarketPrivKey) return reply.status(400).send({ error: 'No private key' })

      const { privateKeyToAccount } = await import('viem/accounts')
      const { encodeAbiParameters, keccak256, getContractAddress } = await import('viem')
      const { production } = await import('@polymarket/client')
      const env = production as unknown as { walletDerivation: {
        depositWalletFactory: `0x${string}`
        depositWalletImplementation: `0x${string}`
        depositWalletBeacon: `0x${string}`
        safeFactory: `0x${string}`
        safeInitCodeHash: `0x${string}`
      }}

      const wd = env.walletDerivation
      const eoa = privateKeyToAccount(wallets.polymarketPrivKey as `0x${string}`).address

      // Compute Hr(EOA, walletDerivation) — implementation-based deposit wallet (CREATE2)
      // This matches what the SDK uses when walletDerivation.depositWalletFactory beacon reverts
      const paddedEoa = `0x${'0'.repeat(24)}${eoa.slice(2).toLowerCase()}` as `0x${string}`
      const encoded = encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [wd.depositWalletFactory, paddedEoa]
      )
      const salt = keccak256(encoded)

      // bytecodeHash = keccak256(prefix(10) + implementation(20) + 0x6009 + Fo(32) + Bo(32) + encoded)
      const Fo = '5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076'
      const Bo = 'cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3'
      const Mo = 0x61003d3d8160233d3973n
      const oLen = BigInt((encoded.length - 2) / 2)
      const prefix = Mo + (oLen << 56n)
      const prefixHex = prefix.toString(16).padStart(20, '0')
      const bytecodeHex = `0x${prefixHex}${wd.depositWalletImplementation.slice(2)}6009${Fo}${Bo}${encoded.slice(2)}`
      const bytecodeHash = keccak256(bytecodeHex as `0x${string}`)

      const depositWallet = getContractAddress({
        from: wd.depositWalletFactory,
        salt,
        bytecodeHash,
        opcode: 'CREATE2',
      })

      // Check if deployed on Polygon
      const { createPublicClient, http } = await import('viem')
      const { polygon } = await import('viem/chains')
      const poly = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') })
      let deployed = false
      try {
        const code = await poly.getCode({ address: depositWallet })
        deployed = !!code && code !== '0x'
      } catch { /* ignore RPC errors */ }

      wallets.polyProxyAddress = depositWallet
      await rSet('poly:settings:wallets', await encrypt(JSON.stringify(wallets)))
      const { invalidatePolyClient } = await import('../exchanges/poly.js')
      invalidatePolyClient()
      log('info', 'System', `auto-saved deposit wallet: ${depositWallet} (deployed=${deployed})`)

      return { ok: true, signerAddress: eoa, proxyAddress: depositWallet, autoSaved: true, deployed }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  app.post('/admin/restart', async (_req, reply) => {
    log('info', 'System', 'manual restart triggered')
    reply.send({ ok: true, message: 'Restarting engine...' })
    setImmediate(() => restartEngine().catch(err => log('error', 'System', `restart failed: ${(err as Error).message}`)))
  })

  // Accept full market key e.g. "BTC-5min", "ETH-1h"
  app.post('/arb/execute/:key', async (req, reply) => {
    const { key } = req.params as { key: string }
    if (!key || !key.includes('-')) return reply.status(400).send({ error: `Invalid market key: ${key}. Expected format: ASSET-TIMEFRAME (e.g. BTC-5min)` })
    const result = await triggerManualArb(key)
    return result
  })

  app.post('/signal/execute/:key', async (req, reply) => {
    const { key } = req.params as { key: string }
    if (!key || !key.includes('-')) return reply.status(400).send({ error: `Invalid market key: ${key}. Expected format: ASSET-TIMEFRAME (e.g. BTC-5min)` })
    const result = await triggerManualSignal(key)
    return result
  })

  app.post('/spread/execute/:key', async (req, reply) => {
    const { key } = req.params as { key: string }
    if (!key || !key.includes('-')) return reply.status(400).send({ error: `Invalid market key: ${key}. Expected format: ASSET-TIMEFRAME (e.g. BTC-5min)` })
    const result = await triggerManualSpread(key)
    return result
  })

  app.post('/arb/close/:tradeId', async (req, reply) => {
    const { tradeId } = req.params as { tradeId: string }
    const result = await triggerManualEarlyExit(tradeId)
    if (!result.ok) return reply.status(400).send(result)
    return result
  })

  app.post('/test/poly-order', async (req, reply) => {
    const { asset = 'ETH', side = 'YES', amount = 1 } = (req.body ?? {}) as { asset?: string; side?: string; amount?: number }
    try {
      const { getPolyMarkets, placePolyOrder } = await import('../exchanges/poly.js')
      const markets = getPolyMarkets()
      // Accept either "ETH" (defaults to 5min) or "ETH-5min"
      const normalizedKey = asset.includes('-') ? asset.toUpperCase() : `${asset.toUpperCase()}-5min`
      const market = markets.get(normalizedKey)
      if (!market) return reply.status(400).send({ error: `No active market for ${normalizedKey}` })
      const tokenId = side.toUpperCase() === 'NO' ? (market.noTokenId ?? market.yesTokenId) : market.yesTokenId
      log('info', 'Test', `placing $${amount} ${normalizedKey} ${side} order — token ${tokenId.slice(0, 16)}...`)
      const result = await placePolyOrder(tokenId, 'BUY', amount)
      return { ok: true, result }
    } catch (err) {
      return reply.status(400).send({ ok: false, error: (err as Error).message })
    }
  })

  app.post('/test/lim-order', async (req, reply) => {
    const { asset = 'ETH', outcome = 'yes', amount = 1 } = (req.body ?? {}) as { asset?: string; outcome?: string; amount?: number }
    try {
      const { getLimMarkets, placeLimOrder } = await import('../exchanges/lim.js')
      // Accept either "ETH" (defaults to 5min) or "ETH-5min"
      const normalizedKey = asset.includes('-') ? asset.toUpperCase() : `${asset.toUpperCase()}-5min`
      const market = getLimMarkets().get(normalizedKey)
      if (!market) return reply.status(400).send({ error: `No active Lim market for ${normalizedKey}` })
      log('info', 'Test', `placing $${amount} Lim ${normalizedKey} ${outcome} order — slug ${market.slug}`)
      const result = await placeLimOrder(market.slug, outcome as 'yes' | 'no', amount)
      return { ok: true, result }
    } catch (err) {
      return reply.status(400).send({ ok: false, error: (err as Error).message })
    }
  })

  app.put('/arb/settings', async (req, reply) => {
    const body = req.body as Partial<ArbSettings>
    if (!body || typeof body !== 'object') return reply.status(400).send({ error: 'Invalid body' })
    await applySettings(body)
    return { ok: true, settings: await import('../arb/engine.js').then(m => m.getArbSettings()) }
  })

  // ── Leaderboard Copy-Trading ──────────────────────────────────────────────
  app.get('/leaderboard', async (req, reply) => {
    const { window = 'day', limit = '25' } = req.query as { window?: string; limit?: string }
    if (!['day', 'week', 'month'].includes(window)) return reply.status(400).send({ error: 'window must be day, week, or month' })
    const n = Math.min(Number(limit) || 50, 50)  // Polymarket API hard-caps at 50
    const w = window as 'day' | 'week' | 'month'
    try {
      const entries = await getLeaderboard(w, n)
      // Include any already-computed window stats from the background cache
      const windowEntries = getLeaderboardWindowCache(w)
      const windowMap = new Map(windowEntries?.map(e => [e.proxyWallet, e]) ?? [])
      const merged = entries.map(e => windowMap.get(e.proxyWallet) ?? e)
      return { ok: true, entries: merged, windowReady: windowEntries != null }
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message })
    }
  })

  // Lightweight poll — returns enriched entries once background window-stats job is done
  app.get('/leaderboard/window-ready', async (req, reply) => {
    const { window = 'day' } = req.query as { window?: string }
    if (!['day', 'week', 'month'].includes(window)) return reply.status(400).send({ error: 'invalid window' })
    const entries = getLeaderboardWindowCache(window as 'day' | 'week' | 'month')
    return { ready: entries != null, entries: entries ?? [] }
  })

  app.get('/leaderboard/:wallet/stats', async (req, reply) => {
    const { wallet } = req.params as { wallet: string }
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) return reply.status(400).send({ error: 'Invalid wallet address' })
    try {
      const stats = await getTraderStats(wallet)
      return { ok: true, stats }
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message })
    }
  })

  app.get('/copytrade', async () => {
    return { ok: true, ...getCopyTradeState() }
  })

  app.post('/copytrade/follow', async (req, reply) => {
    const { wallet, userName } = (req.body ?? {}) as { wallet?: string; userName?: string }
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) return reply.status(400).send({ error: 'Invalid wallet address' })
    const settings = await getArbSettings()
    if (settings.followedWallets.includes(wallet)) return { ok: true, followedWallets: settings.followedWallets }
    const followedWallets = [...settings.followedWallets, wallet]
    if (userName) cacheTraderName(wallet, userName)
    await applySettings({ followedWallets })
    return { ok: true, followedWallets }
  })

  app.post('/copytrade/unfollow', async (req, reply) => {
    const { wallet } = (req.body ?? {}) as { wallet?: string }
    if (!wallet) return reply.status(400).send({ error: 'wallet is required' })
    const settings = await getArbSettings()
    const followedWallets = settings.followedWallets.filter(w => w !== wallet)
    await applySettings({ followedWallets })
    return { ok: true, followedWallets }
  })

}
