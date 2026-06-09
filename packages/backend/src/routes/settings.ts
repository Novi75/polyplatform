import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { rGet, rSet, rDel, encrypt, decrypt } from '../db/redis.js'
import { deriveAndSaveCredentials, createApiKey, getSignerAddress } from '../exchanges/polymarket-auth.js'
import { invalidatePolyClient, getPolyClient } from '../exchanges/poly.js'
import { setupLimApprovals } from '../exchanges/lim.js'
import { log } from '../logger.js'

const PolyCredsSchema = z.object({
  apiKey: z.string().min(1),
  secret: z.string().min(1),
  passphrase: z.string().min(1),
})

const ethAddress = z.string().trim().refine(
  (v) => v.length === 0 || /^0x[0-9a-fA-F]{40}$/.test(v),
  'Must be a valid address (0x + 40 hex chars), or leave empty',
)

const LimitlessLegacySchema = z.object({
  mode: z.literal('legacy'),
  apiKey: z.string().min(1),
  walletAddress: ethAddress.optional(),
})

const LimitlessHmacSchema = z.object({
  mode: z.literal('hmac'),
  tokenId: z.string().trim().min(1),
  secret: z.string().trim().min(1),
  walletAddress: ethAddress.optional(),
  privateKey: z.string().trim().optional(),
})

const LimitlessCredsSchema = z.discriminatedUnion('mode', [LimitlessLegacySchema, LimitlessHmacSchema])

const WalletSchema = z.object({
  polymarketPrivKey: z.string().optional(),
  polyProxyAddress: z.string().trim().optional().refine(
    (v) => !v || /^0x[0-9a-fA-F]{40}$/.test(v),
    'Must be a valid address (0x + 40 hex chars)',
  ),
})

const RelayerSchema = z.object({
  relayerKey: z.string().min(1),
  relayerAddress: z.string().trim().refine(
    (v) => /^0x[0-9a-fA-F]{40}$/.test(v),
    'Must be a valid address (0x + 40 hex chars)',
  ),
})

const ArbConfigSchema = z.object({
  minProfitPct: z.number().min(0.1).max(50),
  autoExecute: z.boolean(),
  maxPositionSize: z.number().min(0.01).max(100_000),
  maxOpenTrades: z.number().int().min(1).max(20),
  xtfEnabled: z.boolean().optional(),
  xtfMinGapPct: z.number().min(5).max(50).optional(),
})

function maskKey(k: string): string { return k.slice(0, 8) + '...' }
function maskSecret(): string { return '****' }

export async function settingsRoutes(app: FastifyInstance) {

  app.get('/settings', async () => {
    const [polyRaw, limRaw, arbRaw] = await Promise.all([
      rGet('poly:settings:polymarket'),
      rGet('poly:settings:limitless'),
      rGet('poly:settings:arb'),
    ])

    let polymarket: Record<string, string> | null = null
    let limitless: Record<string, string | undefined> | null = null

    if (polyRaw) {
      try {
        const p = JSON.parse(decrypt(polyRaw)) as { apiKey: string; secret: string; passphrase: string }
        polymarket = { apiKey: maskKey(p.apiKey), secret: maskSecret(), passphrase: maskSecret() }
      } catch {}
    }

    if (limRaw) {
      try {
        const l = JSON.parse(decrypt(limRaw)) as { mode: string; apiKey?: string; tokenId?: string; walletAddress?: string; privateKey?: string }
        if (l.mode === 'legacy' && l.apiKey) {
          limitless = { mode: 'legacy', apiKey: maskKey(l.apiKey), walletAddress: l.walletAddress }
        } else if (l.mode === 'hmac' && l.tokenId) {
          limitless = { mode: 'hmac', tokenId: maskKey(l.tokenId), secret: maskSecret(), walletAddress: l.walletAddress, privateKey: l.privateKey ? maskSecret() : undefined }
        }
      } catch {}
    }

    const arb = arbRaw ? JSON.parse(arbRaw) : { minProfitPct: 1.5, autoExecute: false, maxPositionSize: 100 }
    const hasPolyWallet = !!(await rGet('poly:settings:wallets'))
    const polyAddress = await getSignerAddress()

    let polyProxyAddress: string | null = null
    try {
      const walletRaw = await rGet('poly:settings:wallets')
      if (walletRaw) {
        const w = JSON.parse(decrypt(walletRaw)) as { polyProxyAddress?: string }
        polyProxyAddress = w.polyProxyAddress ?? null
      }
    } catch { /* ignore */ }

    return { polymarket, limitless, arb, hasPolyWallet, polyAddress, polyProxyAddress }
  })

  app.put('/settings/polymarket', async (req, reply) => {
    const body = PolyCredsSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })
    try {
      await rSet('poly:settings:polymarket', await encrypt(JSON.stringify(body.data)))

      // Derive and cache the signer address from the stored private key,
      // so authenticated API calls (balance, orders, etc.) can succeed.
      try {
        const walletRaw = await rGet('poly:settings:wallets')
        if (walletRaw) {
          const wallets = JSON.parse(decrypt(walletRaw)) as { polymarketPrivKey?: string }
          if (wallets.polymarketPrivKey) {
            const { privateKeyToAccount } = await import('viem/accounts')
            const address = privateKeyToAccount(wallets.polymarketPrivKey as `0x${string}`).address
            await rSet('poly:settings:polymarket:address', address)
          }
        }
      } catch { /* address caching is best-effort; auth calls fall back to on-demand derivation */ }

      return { ok: true }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  app.put('/settings/limitless', async (req, reply) => {
    const body = LimitlessCredsSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })
    try {
      let data = body.data as Record<string, unknown>
      // Preserve existing privateKey if not provided in this update
      if (body.data.mode === 'hmac' && !body.data.privateKey) {
        const existing = await rGet('poly:settings:limitless')
        if (existing) {
          try {
            const prev = JSON.parse(decrypt(existing)) as { mode: string; privateKey?: string }
            if (prev.mode === 'hmac' && prev.privateKey) data = { ...data, privateKey: prev.privateKey }
          } catch { /* ignore parse errors */ }
        }
      }
      await rSet('poly:settings:limitless', await encrypt(JSON.stringify(data)))
      return { ok: true, mode: body.data.mode }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  app.put('/settings/wallets', async (req, reply) => {
    const body = WalletSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })
    try {
      await rSet('poly:settings:wallets', await encrypt(JSON.stringify(body.data)))
      invalidatePolyClient()  // force SDK re-init with new key
      return { ok: true }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  app.delete('/settings/wallets', async () => {
    await rDel('poly:settings:wallets')
    return { ok: true }
  })

  app.put('/settings/relayer', async (req, reply) => {
    const body = RelayerSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })
    try {
      await rSet('poly:settings:relayer', await encrypt(JSON.stringify(body.data)))
      invalidatePolyClient()
      return { ok: true }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  app.post('/settings/derive-api-key', async (req, reply) => {
    const { nonce = 0 } = (req.body as Record<string, unknown>) ?? {}
    try {
      const result = await deriveAndSaveCredentials(Number(nonce))
      return { ok: true, address: result.address, apiKey: maskKey(result.apiKey) }
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }
  })

  app.post('/settings/create-api-key', async (req, reply) => {
    const { nonce = 0 } = (req.body as Record<string, unknown>) ?? {}
    try {
      const walletRaw = await rGet('poly:settings:wallets')
      if (!walletRaw) return reply.status(400).send({ error: 'No wallet private key stored. Add it in Step 1 first.' })
      const wallets = JSON.parse(decrypt(walletRaw)) as { polymarketPrivKey?: string }
      if (!wallets.polymarketPrivKey) return reply.status(400).send({ error: 'Polymarket private key not set in wallet settings.' })

      const creds = await createApiKey(wallets.polymarketPrivKey, Number(nonce))
      await rSet('poly:settings:polymarket', await encrypt(JSON.stringify({ apiKey: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase })))
      await rSet('poly:settings:polymarket:address', creds.address)

      return { ok: true, address: creds.address, apiKey: maskKey(creds.apiKey) }
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }
  })

  app.post('/settings/setup-approvals', async (_req, reply) => {
    try {
      const client = await getPolyClient()
      log('info', 'System', 'setupTradingApprovals — sending on-chain approvals...')
      const handle = await client.setupTradingApprovals()
      const outcome = await handle.wait()
      log('info', 'System', `setupTradingApprovals done — ${JSON.stringify(outcome)}`)
      return { ok: true, outcome }
    } catch (err) {
      log('warn', 'System', `setupTradingApprovals failed: ${(err as Error).message}`)
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  app.put('/settings/arbitrage', async (req, reply) => {
    const body = ArbConfigSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() })
    try {
      await rSet('poly:settings:arb', JSON.stringify(body.data))
      return { ok: true }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  app.post('/limitless/approve', async (_req, reply) => {
    try {
      log('info', 'System', 'setupLimApprovals — sending USDC + CTF approvals on Base...')
      const result = await setupLimApprovals()
      log('info', 'System', `setupLimApprovals done — USDC: ${result.usdcTxHash}, CTF: ${result.ctfTxHash}`)
      return { ok: true, usdcTxHash: result.usdcTxHash, ctfTxHash: result.ctfTxHash }
    } catch (err) {
      log('warn', 'System', `setupLimApprovals failed: ${(err as Error).message}`)
      return reply.status(500).send({ error: (err as Error).message })
    }
  })

  app.get('/limitless/allowance', async (_req, reply) => {
    try {
      const { getLimCreds } = await import('../exchanges/lim.js')
      const creds = await getLimCreds()
      if (!creds?.walletAddress) return reply.status(400).send({ error: 'Wallet address not configured' })

      const { getAddress, createPublicClient, http, parseAbi } = await import('viem')
      const { base } = await import('viem/chains')
      const { config } = await import('../config.js')

      const publicClient = createPublicClient({ chain: base, transport: http(config.limitless.baseRpc) })
      // Venue exchange address from live market (not the static CTF address)
      const { getLimMarkets } = await import('../exchanges/lim.js')
      const { MarketFetcher, HttpClient } = await import('@limitless-exchange/sdk')
      let spender = '0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5'  // known venue, refreshed below
      try {
        const fetcher = new MarketFetcher(new HttpClient())
        const markets = getLimMarkets()
        for (const market of markets.values()) {
          const m = await fetcher.getMarket(market.slug) as { venue?: { exchange?: string } }
          if (m.venue?.exchange) { spender = m.venue.exchange; break }
        }
      } catch { /* use default */ }

      const allowance = await publicClient.readContract({
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        abi: parseAbi(['function allowance(address owner, address spender) view returns (uint256)']),
        functionName: 'allowance',
        args: [getAddress(creds.walletAddress) as `0x${string}`, spender as `0x${string}`],
      })

      return {
        allowance: (Number(allowance) / 1_000_000).toFixed(2),
        required: '1.00',
        isApproved: allowance > 0n,
      }
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message })
    }
  })
}
