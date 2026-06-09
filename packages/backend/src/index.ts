import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { config } from './config.js'
import { installApiCallTracker } from './exchanges/apiCallTracker.js'
import { wsHub } from './ws/server.js'
import { settingsRoutes } from './routes/settings.js'
import { dashboardRoutes } from './routes/dashboard.js'
import { startEngine } from './arb/engine.js'

installApiCallTracker()

const app = Fastify({
  logger: config.isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : true,
})

await app.register(cors, { origin: true })
await app.register(helmet, { contentSecurityPolicy: false })
await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })
await app.register(websocket)

app.get('/ws', { websocket: true }, (socket) => {
  wsHub.register(socket.socket)
})

app.get('/health', async () => ({ status: 'ok', ts: Date.now() }))

await app.register(async (instance) => {
  await instance.register(settingsRoutes)
  await instance.register(dashboardRoutes)
}, { prefix: '/api/v1' })

const shutdown = async () => { await app.close(); process.exit(0) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  await app.listen({ port: config.port, host: config.host })
  app.log.info(`Polyplatform backend running on ${config.host}:${config.port}`)

  const { encrypt } = await import('./db/redis.js')
  encrypt('warmup').catch(() => {})

  startEngine().catch((err) => app.log.error({ err }, 'Engine start failed'))
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
