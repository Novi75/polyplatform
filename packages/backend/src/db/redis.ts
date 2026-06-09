import { pbkdf2, randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'

const pbkdf2Async = promisify(pbkdf2)

// ── In-memory store (replaces Redis) ─────────────────────────────────────────

const memory = new Map<string, { value: string; expiresAt: number }>()
const lists = new Map<string, string[]>()
const sets = new Map<string, Set<string>>()

// ── Persistence for credentials + settings ──────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))

// Walk up from __dirname to find the workspace root (the one that has packages/backend).
// This handles both dist/db/ (source-compiled, 4 levels up) and dist/ (bundled, 3 levels up)
// without being confused by unrelated 'data' directories elsewhere on the drive.
function findStorePath(): string {
  for (const depth of [3, 4, 5, 2]) {
    const ups: string[] = Array(depth).fill('..')
    const root = resolve(__dirname, ...ups)
    if (existsSync(resolve(root, 'packages', 'backend'))) {
      return resolve(root, 'data', 'store.json')
    }
  }
  return resolve(__dirname, '..', '..', '..', '..', 'data', 'store.json')
}

const STORE_PATH = findStorePath()

/** Keys that should survive process restarts (credentials, settings, operational state). */
const PERSIST_KEYS = [
  'poly:settings:polymarket',
  'poly:settings:polymarket:address',
  'poly:settings:limitless',
  'poly:settings:wallets',
  'poly:settings:arb',
  'poly:lim:pending-claims',  // Lim positions pending redemption
  'poly:trade-log',           // Trade history for positions panel + Poly auto-redeem
  'poly:settings:relayer',    // Relayer API key for gasless Poly transactions
]

function loadPersistent(): void {
  try {
    if (!existsSync(STORE_PATH)) return
    const raw = readFileSync(STORE_PATH, 'utf8')
    const data = JSON.parse(raw) as Record<string, { value: string; expiresAt: number }>
    for (const [key, entry] of Object.entries(data)) {
      if (PERSIST_KEYS.includes(key)) {
        memory.set(key, entry)
      }
    }
  } catch (err) {
    console.error('[Store] failed to load persistent store:', (err as Error).message)
  }
}

function savePersistent(keys?: string[]): void {
  try {
    const dir = dirname(STORE_PATH)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // Read existing, merge with changed keys
    let data: Record<string, { value: string; expiresAt: number }> = {}
    try {
      if (existsSync(STORE_PATH)) {
        data = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
      }
    } catch {}
    const toSave = keys ?? PERSIST_KEYS
    for (const key of toSave) {
      const entry = memory.get(key)
      if (entry) {
        data[key] = entry
      } else {
        delete data[key]
      }
    }
    writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    console.error('[Store] failed to save persistent store:', (err as Error).message)
  }
}

// Load persistent keys on module init
loadPersistent()

// ── Public API (identical to old redis.ts signature) ────────────────────────

export async function rGet(key: string): Promise<string | null> {
  const entry = memory.get(key)
  if (!entry) return null
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    memory.delete(key)
    return null
  }
  return entry.value
}

export async function rSet(key: string, value: string, ttlSecs?: number): Promise<void> {
  memory.set(key, {
    value,
    expiresAt: ttlSecs ? Date.now() + ttlSecs * 1000 : 0,
  })
  if (PERSIST_KEYS.includes(key)) {
    savePersistent([key])
  }
}

export async function rDel(key: string): Promise<void> {
  memory.delete(key)
  lists.delete(key)
  sets.delete(key)
  if (PERSIST_KEYS.includes(key)) {
    savePersistent([key])
  }
}

export async function rLpush(key: string, value: string, trimTo: number): Promise<void> {
  let arr = lists.get(key)
  if (!arr) {
    arr = []
    lists.set(key, arr)
  }
  arr.unshift(value)
  if (arr.length > trimTo) arr.length = trimTo
}

export async function rLrange(key: string, start: number, end: number): Promise<string[]> {
  const arr = lists.get(key)
  if (!arr) return []
  const clampedEnd = end < 0 ? arr.length + end : Math.min(end, arr.length - 1)
  return arr.slice(start, clampedEnd + 1)
}

export async function rSadd(key: string, ...members: string[]): Promise<void> {
  let s = sets.get(key)
  if (!s) {
    s = new Set<string>()
    sets.set(key, s)
  }
  for (const m of members) s.add(m)
}

export async function rSrem(key: string, ...members: string[]): Promise<void> {
  const s = sets.get(key)
  if (!s) return
  for (const m of members) s.delete(m)
}

export async function rSmembers(key: string): Promise<string[]> {
  const s = sets.get(key)
  return s ? [...s] : []
}

export async function rExists(key: string): Promise<boolean> {
  const entry = memory.get(key)
  if (!entry) return false
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    memory.delete(key)
    return false
  }
  return true
}

// ── Encryption (unchanged — pure crypto, no Redis dependency) ───────────────

const KDF_SALT = 'polyplatform-aes256-v1'

let _cachedKey: { secret: string; key: Buffer } | null = null

async function deriveKey(masterSecret: string): Promise<Buffer> {
  if (_cachedKey?.secret === masterSecret) return _cachedKey.key
  const key = await pbkdf2Async(masterSecret, KDF_SALT, 100_000, 32, 'sha256')
  _cachedKey = { secret: masterSecret, key }
  return key
}

export async function encrypt(plaintext: string): Promise<string> {
  const key = await deriveKey(config.masterSecret)
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(ciphertext: string): string {
  if (!_cachedKey) throw new Error('Encryption key not yet derived. Call encrypt() first.')
  const [ivHex, encHex] = ciphertext.split(':')
  if (!ivHex || !encHex) throw new Error('Invalid ciphertext format')
  const iv = Buffer.from(ivHex, 'hex')
  const enc = Buffer.from(encHex, 'hex')
  const decipher = createDecipheriv('aes-256-cbc', _cachedKey.key, iv)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
