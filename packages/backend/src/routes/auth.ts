import type { FastifyInstance, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'crypto'
import { z } from 'zod'
import { config } from '../config.js'

export const SESSION_COOKIE_NAME = 'pp_session'
const SESSION_VALUE = 'authenticated'
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60 // 30 days

/** When AUTH_PASSWORD is unset, auth is a no-op (preserves open dev behavior). */
export function authEnabled(): boolean {
  return config.auth.password.length > 0
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function isAuthenticated(req: FastifyRequest): boolean {
  if (!authEnabled()) return true
  const raw = req.cookies[SESSION_COOKIE_NAME]
  if (!raw) return false
  const result = req.unsignCookie(raw)
  return result.valid && result.value === SESSION_VALUE
}

const LoginSchema = z.object({
  password: z.string().min(1),
})

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!authEnabled()) return { ok: true }

    const parsed = LoginSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Password required' })
    }

    if (!safeEqual(parsed.data.password, config.auth.password)) {
      return reply.code(401).send({ error: 'Invalid password' })
    }

    reply.setCookie(SESSION_COOKIE_NAME, SESSION_VALUE, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: !config.isDev,
      signed: true,
      maxAge: SESSION_MAX_AGE_SEC,
    })
    return { ok: true }
  })

  app.post('/logout', async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
    return { ok: true }
  })

  app.get('/me', async (req) => {
    return { authenticated: isAuthenticated(req) }
  })
}
