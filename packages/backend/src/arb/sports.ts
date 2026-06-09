/**
 * Sports / Esports cross-exchange arbitrage — fully independent of the crypto pipeline.
 *
 * Pipeline:
 *   1. FILTER — pull match-winner markets from Polymarket and Limitless that are
 *      "starting soon" (kickoff within ±6h of now), independently on each exchange
 *   2. DATE CROSS-CHECK — for each Polymarket candidate, narrow Limitless candidates
 *      down to those with a kickoff time close to it (same real-world fixture window)
 *   3. NAME MATCH — within that date-matched set, confirm the same team/player
 *      matchup by name, producing a MatchedSportsEvent with both sides' odds
 *   4. ARB — surface two-sided opportunities (buy "home wins" on one exchange +
 *      "away wins" on the other for a combined cost below $1)
 */
import { config } from '../config.js'
import { trackLimCall } from '../exchanges/apiCallTracker.js'
import { log } from '../logger.js'
import { getMarketFetcher } from '../exchanges/lim.js'

export type SportKind = 'sports' | 'esports'

export interface SportsMatch {
  exchange: 'poly' | 'lim'
  kind: SportKind
  league: string
  homeTeam: string
  awayTeam: string
  title: string
  homeAsk: number | null   // price to buy "home wins"
  homeBid: number | null
  awayAsk: number | null   // price to buy "away wins"
  awayBid: number | null
  homeTokenId: string      // poly clobTokenId / lim token id for the home outcome
  awayTokenId: string
  limSlug: string
  score: string | null
  isLive: boolean
  startTime: number | null  // match kickoff, ms epoch — used as the first cross-exchange filter ("starting soon")
}

export interface SportsArbOpportunity {
  homeTeam: string
  awayTeam: string
  league: string
  kind: SportKind
  poly: SportsMatch
  lim: SportsMatch
  buyHomeOn: 'poly' | 'lim'
  buyAwayOn: 'poly' | 'lim'
  homeCost: number
  awayCost: number
  totalCost: number
  profitPct: number   // (1 - totalCost) / totalCost * 100
}

const GAMMA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://polymarket.com',
  'Referer': 'https://polymarket.com/',
}

const SPORTS_TAG_ID = 1
const ESPORTS_TAG_ID = 64

// ── "Starting soon" window — the FIRST filter applied on both exchanges ───────
// A match qualifies if its kickoff falls within ±STARTING_SOON_WINDOW_MS of now.
// This catches matches that are about to start (more time to spot & act on an
// arb before kickoff), ones already in progress, and ones that finished recently
// (oracle settlement lag). 24h was picked empirically — virtually every match that
// exists on BOTH exchanges at any given moment kicks off within a day of "now";
// a tighter window (e.g. 6h) was found to miss the majority of common fixtures.
const STARTING_SOON_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

function isStartingSoon(startMs: number | null): boolean {
  if (startMs == null) return false
  return Math.abs(startMs - Date.now()) <= STARTING_SOON_WINDOW_MS
}

// Once both sides have passed the "starting soon" filter independently, a pair
// must also agree on kickoff time (within this tolerance) to count as the same
// real-world fixture — guards against same-team-different-date mismatches.
const MATCH_TIME_TOLERANCE_MS = 3 * 60 * 60 * 1000 // 3 hours

// ── Team-name normalization & matching ────────────────────────────────────────

function normTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function teamsMatch(a: string, b: string): boolean {
  const na = normTeam(a)
  const nb = normTeam(b)
  if (!na || !nb) return false
  if (na === nb) return true
  // Tolerate suffix/prefix variance, e.g. "leviatan esports" vs "leviatan"
  return na.includes(nb) || nb.includes(na)
}

// ── Polymarket: live sports/esports match-winner markets ──────────────────────

// Strip a leading "League/Game: " prefix and trailing " (BOx) - context" suffix,
// e.g. "Counter-Strike: MIBR vs B8 (BO3) - IEM Cologne Major Stage 2" → "MIBR vs B8"
function parsePolyMatchup(title: string): { home: string; away: string } | null {
  let t = title
  const colonIdx = t.indexOf(': ')
  if (colonIdx > 0 && colonIdx < 24) t = t.slice(colonIdx + 2)
  t = t.split(/\s+\(/)[0].split(/\s+-\s+/)[0].trim()
  const m = t.match(/^(.+?)\s+vs\.?\s+(.+)$/i)
  if (!m) return null
  const home = m[1].trim()
  const away = m[2].trim()
  if (!home || !away) return null
  return { home, away }
}

// The Gamma API returns `outcomes`/`clobTokenIds` as JSON-encoded strings — parse if needed
function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as string[] } catch { return [] }
  }
  return []
}

async function fetchPolyCandidateEvents(tagId: number): Promise<Array<Record<string, unknown>>> {
  // Bias the result set toward events starting around "now" — without a date range
  // the API returns events ordered by popularity/creation, burying the ones that
  // are actually starting soon. start_date_min/max + ascending order surfaces them.
  const now = Date.now()
  const params = new URLSearchParams({
    active: 'true',
    closed: 'false',
    limit: '100',
    tag_id: String(tagId),
    order: 'startDate',
    ascending: 'true',
    start_date_min: new Date(now - STARTING_SOON_WINDOW_MS).toISOString(),
    start_date_max: new Date(now + STARTING_SOON_WINDOW_MS).toISOString(),
  })
  const url = `${config.polymarket.gammaHost}/events?${params}`
  const resp = await fetch(url, { headers: GAMMA_HEADERS })
  if (!resp.ok) throw new Error(`Gamma events API ${resp.status}`)
  return (await resp.json()) as Array<Record<string, unknown>>
}

// Polymarket reports kickoff as e.g. "2026-06-08 18:00:00+00" on the moneyline market
function parsePolyGameStart(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null
  const iso = raw.replace(' ', 'T').replace(/\+00$/, 'Z')
  const ts = Date.parse(iso)
  return Number.isFinite(ts) ? ts : null
}

export async function fetchPolySportsMatches(): Promise<SportsMatch[]> {
  const out: SportsMatch[] = []
  // Polymarket tags the same event under both Sports (1) and Esports (64) at times — dedupe by matchup
  const seen = new Set<string>()
  for (const [tagId, kind] of [[SPORTS_TAG_ID, 'sports'], [ESPORTS_TAG_ID, 'esports']] as const) {
    try {
      const events = await fetchPolyCandidateEvents(tagId)
      for (const ev of events) {
        const title = String(ev.title ?? '')
        const matchup = parsePolyMatchup(title)
        if (!matchup) continue

        const markets = (ev.markets ?? []) as Array<Record<string, unknown>>
        // The moneyline market is the one whose outcomes are the two team names
        const ml = markets.find(m => {
          const outcomes = parseStringArray(m.outcomes)
          return outcomes.length === 2 && teamsMatch(outcomes[0], matchup.home) && teamsMatch(outcomes[1], matchup.away)
        })
        if (!ml) continue

        // FIRST FILTER: only consider matches starting soon (or already under way within the window)
        const startTime = parsePolyGameStart(ml.gameStartTime)
        if (!isStartingSoon(startTime)) continue

        const dedupeKey = `${normTeam(matchup.home)}|${normTeam(matchup.away)}|${startTime ?? ''}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)

        const tokenIds = parseStringArray(ml.clobTokenIds)
        const bestBid = ml.bestBid != null ? Number(ml.bestBid) : null
        const bestAsk = ml.bestAsk != null ? Number(ml.bestAsk) : null
        const sportInfo = ev.sport as { sport?: string } | undefined
        const tagsArr = (ev.tags ?? []) as Array<{ label?: string }>
        const league = sportInfo?.sport?.toUpperCase()
          || tagsArr.map(t => t.label).find(l => l && l !== 'Sports' && l !== 'Esports' && l !== 'Games')
          || (kind === 'esports' ? 'Esports' : 'Sports')

        out.push({
          exchange: 'poly',
          kind,
          league: String(league),
          homeTeam: matchup.home,
          awayTeam: matchup.away,
          title,
          homeAsk: bestAsk,
          homeBid: bestBid,
          awayAsk: bestBid != null ? Math.round((1 - bestBid) * 1000) / 1000 : null,
          awayBid: bestAsk != null ? Math.round((1 - bestAsk) * 1000) / 1000 : null,
          homeTokenId: tokenIds[0] ?? '',
          awayTokenId: tokenIds[1] ?? '',
          limSlug: '',
          score: typeof ev.score === 'string' ? ev.score : null,
          isLive: ev.live === true,
          startTime,
        })
      }
    } catch (err) {
      log('warn', 'Sports', `poly ${kind} fetch failed: ${(err as Error).message}`)
    }
  }
  return out
}

// ── Limitless: live sports/esports match-winner markets ───────────────────────

// Limitless encodes "match winner" markets as a GROUP: the group carries
// {homeTeam, awayTeam, marketType:'match_winner', homeScore, awayScore} in its
// metadata, and contains two binary YES/NO sub-markets — one per team. Buying
// "home wins" = buying YES on the home sub-market (and same for away).
interface RawLimSubMarket {
  title?: string
  tradePrices?: { buy?: { market?: number[] }; sell?: { market?: number[] } }
  tokens?: { yes?: string; no?: string }
}

interface RawLimGroupMarket {
  title?: string
  slug?: string
  marketType?: string
  categories?: string[]
  metadata?: Record<string, unknown>
  markets?: RawLimSubMarket[]
}

// Parses a raw orderbook price for DISPLAY — only rejects values outside the
// valid probability range. Markets with no real liquidity often show degenerate
// placeholder asks (e.g. 0.999/0.999 on both legs); we still want to *show* those
// to the user (it's informative — "no liquidity yet"), so the stricter
// "is this actually tradeable" check lives separately, in detectSportsArb.
function parsePrice(p: number | undefined): number | null {
  if (p == null) return null
  if (p <= 0 || p > 1) return null
  return Math.round(p * 1000) / 1000
}

export async function fetchLimSportsMatches(): Promise<SportsMatch[]> {
  const out: SportsMatch[] = []
  const fetcher = getMarketFetcher()
  try {
    for (let page = 1; page <= 12; page++) {
      trackLimCall()
      const resp = await fetcher.getActiveMarkets({ page }) as unknown as { data?: RawLimGroupMarket[] }
      const data = resp.data ?? []
      if (data.length === 0) break

      for (const g of data) {
        if (g.marketType !== 'group') continue
        const categories = g.categories ?? []
        if (!categories.includes('Sports') && !categories.includes('Esports')) continue
        const meta = g.metadata ?? {}
        if (meta.marketType !== 'match_winner') continue

        const homeTeam = typeof meta.homeTeam === 'string' ? meta.homeTeam : null
        const awayTeam = typeof meta.awayTeam === 'string' ? meta.awayTeam : null
        if (!homeTeam || !awayTeam) continue

        // FIRST FILTER: only consider matches starting soon (or already under way within the window)
        const startTimeRaw = meta.startMatchTimestampInUTC
        const startTime = typeof startTimeRaw === 'number' ? startTimeRaw * 1000
          : typeof startTimeRaw === 'string' && startTimeRaw ? Number(startTimeRaw) * 1000
          : null
        if (!isStartingSoon(startTime)) continue

        // "Live" signal: the oracle has started reporting a score for this match
        const homeScore = meta.homeScore
        const awayScore = meta.awayScore
        const isLive = (homeScore != null) || (awayScore != null)

        // Skip 3-way (draw-possible) groups — not directly comparable to a 2-way moneyline
        const subMarkets = g.markets ?? []
        if (subMarkets.length !== 2) continue
        const homeSub = subMarkets.find(sm => teamsMatch(sm.title ?? '', homeTeam))
        const awaySub = subMarkets.find(sm => teamsMatch(sm.title ?? '', awayTeam))
        if (!homeSub || !awaySub) continue

        const kind: SportKind = categories.includes('Esports') || meta.esportTitle ? 'esports' : 'sports'
        const league = typeof meta.leagueName === 'string' && meta.leagueName ? meta.leagueName
          : typeof meta.esportTitle === 'string' ? meta.esportTitle
          : (kind === 'esports' ? 'Esports' : 'Sports')

        const homeAsk = parsePrice(homeSub.tradePrices?.buy?.market?.[0])
        const homeBid = parsePrice(homeSub.tradePrices?.sell?.market?.[0])
        const awayAsk = parsePrice(awaySub.tradePrices?.buy?.market?.[0])
        const awayBid = parsePrice(awaySub.tradePrices?.sell?.market?.[0])

        const score = (homeScore != null || awayScore != null) ? `${homeScore ?? '-'} : ${awayScore ?? '-'}` : null

        out.push({
          exchange: 'lim',
          kind,
          league: String(league),
          homeTeam,
          awayTeam,
          title: g.title ?? `${homeTeam} vs ${awayTeam}`,
          homeAsk,
          homeBid,
          awayAsk,
          awayBid,
          homeTokenId: homeSub.tokens?.yes ?? '',
          awayTokenId: awaySub.tokens?.yes ?? '',
          limSlug: g.slug ?? '',
          score,
          isLive,
          startTime,
        })
      }
    }
  } catch (err) {
    log('warn', 'Sports', `lim fetch failed: ${(err as Error).message}`)
  }
  return out
}

// ── Cross-exchange matching & arb detection ───────────────────────────────────

export interface MatchedSportsEvent {
  homeTeam: string
  awayTeam: string
  league: string
  kind: SportKind
  poly: SportsMatch
  lim: SportsMatch
}

// Cross-exchange matching pipeline:
//   1) Both sides were already filtered to "starting soon" candidates (fetch stage)
//   2) For each Poly candidate, narrow Limitless candidates to those starting around
//      the same time (same real-world kickoff window — guards against same-named
//      teams playing on different dates/competitions)
//   3) Within that date-matched set, confirm the same team/player matchup by name
export function matchSportsEvents(polyMatches: SportsMatch[], limMatches: SportsMatch[]): MatchedSportsEvent[] {
  const out: MatchedSportsEvent[] = []
  for (const p of polyMatches) {
    const dateCandidates = limMatches.filter(l => {
      if (p.startTime == null || l.startTime == null) return true
      return Math.abs(p.startTime - l.startTime) <= MATCH_TIME_TOLERANCE_MS
    })
    const l = dateCandidates.find(l =>
      teamsMatch(p.homeTeam, l.homeTeam) && teamsMatch(p.awayTeam, l.awayTeam))
    if (!l) continue
    out.push({ homeTeam: p.homeTeam, awayTeam: p.awayTeam, league: p.league, kind: p.kind, poly: p, lim: l })
  }
  return out
}

const MIN_LEG = 0.03
const MAX_LEG = 0.97 // legs above this are almost certainly empty-orderbook placeholders, not real tradeable prices

function isTradeable(p: number | null): p is number {
  return p != null && p >= MIN_LEG && p <= MAX_LEG
}

export function detectSportsArb(matched: MatchedSportsEvent[]): SportsArbOpportunity[] {
  const out: SportsArbOpportunity[] = []
  for (const ev of matched) {
    const { poly, lim } = ev

    // Option A: buy "home wins" on Poly + "away wins" on Lim
    if (isTradeable(poly.homeAsk) && isTradeable(lim.awayAsk)) {
      const total = poly.homeAsk + lim.awayAsk
      if (total < 1) {
        out.push({
          homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, league: ev.league, kind: ev.kind,
          poly, lim, buyHomeOn: 'poly', buyAwayOn: 'lim',
          homeCost: poly.homeAsk, awayCost: lim.awayAsk, totalCost: Math.round(total * 1000) / 1000,
          profitPct: Math.round(((1 - total) / total) * 1000) / 10,
        })
      }
    }
    // Option B: buy "home wins" on Lim + "away wins" on Poly
    if (isTradeable(lim.homeAsk) && isTradeable(poly.awayAsk)) {
      const total = lim.homeAsk + poly.awayAsk
      if (total < 1) {
        out.push({
          homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, league: ev.league, kind: ev.kind,
          poly, lim, buyHomeOn: 'lim', buyAwayOn: 'poly',
          homeCost: lim.homeAsk, awayCost: poly.awayAsk, totalCost: Math.round(total * 1000) / 1000,
          profitPct: Math.round(((1 - total) / total) * 1000) / 10,
        })
      }
    }
  }
  return out.sort((a, b) => b.profitPct - a.profitPct)
}

// ── Top-level scan ─────────────────────────────────────────────────────────────

export interface SportsScanResult {
  matched: MatchedSportsEvent[]
  opportunities: SportsArbOpportunity[]
  polyCount: number
  limCount: number
}

export async function scanSports(): Promise<SportsScanResult> {
  const [polyMatches, limMatches] = await Promise.all([fetchPolySportsMatches(), fetchLimSportsMatches()])
  const matched = matchSportsEvents(polyMatches, limMatches)
  const opportunities = detectSportsArb(matched)
  return { matched, opportunities, polyCount: polyMatches.length, limCount: limMatches.length }
}
