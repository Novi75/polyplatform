import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

// __dirname = packages/backend/src — go up 3 levels to reach the monorepo root
const __dirname = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__dirname, '..', '..', '..', '.env') })
// Also accept a .env placed directly in packages/backend (for per-package overrides)
loadEnv({ path: resolve(__dirname, '..', '.env'), override: false })

export const config = {
  port: parseInt(process.env.PORT ?? '3001'),
  host: process.env.HOST ?? '0.0.0.0',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  masterSecret: process.env.MASTER_SECRET ?? 'dev_secret_change_in_production',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isDev: (process.env.NODE_ENV ?? 'development') === 'development',

  auth: {
    password: process.env.AUTH_PASSWORD ?? '',
    sessionSecret: process.env.AUTH_SECRET
      ?? process.env.MASTER_SECRET
      ?? 'dev_secret_change_in_production',
  },

  polymarket: {
    clobHost: 'https://clob.polymarket.com',
    gammaHost: 'https://gamma-api.polymarket.com',
    wsHost: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    chainId: 137,
  },

  limitless: {
    apiHost: 'https://api.limitless.exchange',
    baseRpc: 'https://base-rpc.publicnode.com',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    chainId: 8453, // Base L2
  },

  arb: {
    pollIntervalMs: 500,
    matcherRefreshMs: 300_000,
    defaultMinProfitPct: 1.5,
    defaultMaxPositionUsdc: 100,
    maxAutoExecPerMin: 3,
    consecutiveLossCircuitBreaker: 3,
  },

  redis: {
    ttl: {
      markets: 60,
      orderbook: 5,
      positions: 30,
      matcher: 300,
      arbOpp: 30,
      priceHistory: 86400,
    },
  },
} as const
