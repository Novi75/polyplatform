/**
 * Local disk persistence for exchange markets and matched pairs.
 *
 * Avoids re-fetching from rate-limited APIs on every restart.
 * Markets are saved to JSON files and loaded on startup.
 * Background refreshes update the files.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(__dirname, '..', '..', '..', '..', 'data')

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredMarkets<T> {
  markets: T[]
  fetchedAt: number
  count: number
}

export interface StoredPairs {
  pairs: Array<{
    polymarket: {
      conditionId: string
      question: string
      tokenIds: string[]
      outcomes: string[]
    }
    limitless: {
      id: string
      slug: string
      title: string
      outcomes: string[]
    }
    score: number
    matchedAt: number
    dismissed: boolean
  }>
  totalPairs: number
  matchedAt: number
  polyCount: number
  limCount: number
}

// ── Markets ───────────────────────────────────────────────────────────────────

export function savePolyMarkets(markets: unknown[]): void {
  try {
    ensureDir()
    const data: StoredMarkets<unknown> = {
      markets,
      fetchedAt: Date.now(),
      count: markets.length,
    }
    writeFileSync(resolve(DATA_DIR, 'markets-polymarket.json'), JSON.stringify(data), 'utf8')
  } catch (err) {
    console.error('[Store] failed to save Poly markets:', (err as Error).message)
  }
}

export function loadPolyMarkets(): StoredMarkets<unknown> | null {
  try {
    const path = resolve(DATA_DIR, 'markets-polymarket.json')
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as StoredMarkets<unknown>
  } catch {
    return null
  }
}

export function saveLimMarkets(markets: unknown[]): void {
  try {
    ensureDir()
    const data: StoredMarkets<unknown> = {
      markets,
      fetchedAt: Date.now(),
      count: markets.length,
    }
    writeFileSync(resolve(DATA_DIR, 'markets-limitless.json'), JSON.stringify(data), 'utf8')
  } catch (err) {
    console.error('[Store] failed to save Lim markets:', (err as Error).message)
  }
}

export function loadLimMarkets(): StoredMarkets<unknown> | null {
  try {
    const path = resolve(DATA_DIR, 'markets-limitless.json')
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as StoredMarkets<unknown>
  } catch {
    return null
  }
}

// ── Matched pairs ─────────────────────────────────────────────────────────────

export function saveMatchedPairs(
  pairs: StoredPairs['pairs'],
  polyCount: number,
  limCount: number,
): void {
  try {
    ensureDir()
    const data: StoredPairs = {
      pairs,
      totalPairs: pairs.length,
      matchedAt: Date.now(),
      polyCount,
      limCount,
    }
    writeFileSync(resolve(DATA_DIR, 'matched-pairs.json'), JSON.stringify(data), 'utf8')
  } catch (err) {
    console.error('[Store] failed to save matched pairs:', (err as Error).message)
  }
}

export function loadMatchedPairs(): StoredPairs | null {
  try {
    const path = resolve(DATA_DIR, 'matched-pairs.json')
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as StoredPairs
  } catch {
    return null
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export function getStoreStats() {
  const poly = loadPolyMarkets()
  const lim = loadLimMarkets()
  const pairs = loadMatchedPairs()
  return {
    polymarket: poly ? { count: poly.count, fetchedAt: poly.fetchedAt, age: Date.now() - poly.fetchedAt } : null,
    limitless: lim ? { count: lim.count, fetchedAt: lim.fetchedAt, age: Date.now() - lim.fetchedAt } : null,
    pairs: pairs ? { count: pairs.totalPairs, matchedAt: pairs.matchedAt, age: Date.now() - pairs.matchedAt, polyCount: pairs.polyCount, limCount: pairs.limCount } : null,
  }
}
