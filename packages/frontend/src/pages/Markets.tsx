import { useState, useMemo } from 'react'
import { useMarkets, useOrderBook, useLivePrices } from '../hooks/useMarkets.ts'
import { MarketCard } from '../components/MarketCard.tsx'
import { OrderBook } from '../components/OrderBook.tsx'
import { useStore } from '../store/useStore.ts'
import { ExternalLink, ScanLine } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

type TopTab = 'all' | 'crypto' | 'sports' | 'esports'

const TOP_TABS: { label: string; tag: TopTab }[] = [
  { label: 'All', tag: 'all' },
  { label: 'Crypto', tag: 'crypto' },
  { label: 'Sports', tag: 'sports' },
  { label: 'Esports', tag: 'esports' },
]

const ASSETS = ['Bitcoin', 'Ethereum', 'Solana', 'XRP', 'Dogecoin', 'BNB', 'Microstrategy', 'Hyperliquid']
const ASSET_KEYWORDS: Record<string, string[]> = {
  Bitcoin: ['bitcoin', 'btc'],
  Ethereum: ['ethereum', 'eth'],
  Solana: ['solana', 'sol'],
  XRP: ['xrp', 'ripple'],
  Dogecoin: ['dogecoin', 'doge'],
  BNB: ['bnb', 'binance coin'],
  Microstrategy: ['microstrategy', 'mstr'],
  Hyperliquid: ['hyperliquid', 'hype'],
}

const SPORT_TYPES = ['NBA', 'MLB', 'NHL', 'NFL', 'Soccer', 'Tennis', 'UFC', 'Golf', 'F1', 'Table Tennis', 'Pickleball', 'Rugby', 'Cricket', 'Basketball', 'Baseball', 'Hockey', 'Lacrosse']
const SPORT_KEYWORDS: Record<string, string[]> = {
  NBA: ['nba'],
  MLB: ['mlb'],
  NHL: ['nhl'],
  NFL: ['nfl'],
  Soccer: ['soccer', 'premier league', 'la liga', 'bundesliga', 'serie a', 'champions league', 'mls', 'ligue 1'],
  Tennis: ['tennis', 'wimbledon', 'us open', 'roland garros', 'australian open'],
  UFC: ['ufc', 'mma'],
  Golf: ['golf', 'pga', 'masters'],
  F1: ['formula 1', 'f1', 'grand prix'],
  'Table Tennis': ['table tennis'],
  Pickleball: ['pickleball'],
  Rugby: ['rugby'],
  Cricket: ['cricket'],
  Basketball: ['basketball'],
  Baseball: ['baseball'],
  Hockey: ['hockey'],
  Lacrosse: ['lacrosse'],
}

const ESPORT_GAMES = ['League of Legends', 'CS2', 'Valorant', 'Dota 2', 'Mobile Legends', 'Overwatch', 'Rocket League', 'StarCraft', 'Rainbow Six', 'Call of Duty', 'Honor of Kings']
const ESPORT_KEYWORDS: Record<string, string[]> = {
  'League of Legends': ['league of legends', 'lpl', 'lck', 'lec', 'lcs'],
  CS2: ['cs2', 'counter-strike'],
  Valorant: ['valorant'],
  'Dota 2': ['dota 2', 'dota2'],
  'Mobile Legends': ['mobile legends', 'mlbb'],
  Overwatch: ['overwatch'],
  'Rocket League': ['rocket league'],
  StarCraft: ['starcraft'],
  'Rainbow Six': ['rainbow six', 'r6'],
  'Call of Duty': ['call of duty', 'cod'],
  'Honor of Kings': ['honor of kings'],
}

// Crypto keywords for fast category matching
const CRYPTO_KW = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'dogecoin', 'doge', 'hyperliquid', 'hype', 'crypto', 'bnb', 'binance', 'xrp', 'ripple', 'microstrategy', 'mstr', 'defi', 'nft', 'token', 'blockchain']

function isCrypto(t: string): boolean { const l = t.toLowerCase(); return CRYPTO_KW.some(k => l.includes(k)) }
function isSports(t: string): boolean { const l = t.toLowerCase(); return Object.values(SPORT_KEYWORDS).some(kws => kws.some(k => l.includes(k))) }
function isEsports(t: string): boolean { const l = t.toLowerCase(); return Object.values(ESPORT_KEYWORDS).some(kws => kws.some(k => l.includes(k))) }

function matchesTab(title: string, tab: TopTab): boolean {
  if (tab === 'all') return isCrypto(title) || isSports(title) || isEsports(title)
  if (tab === 'crypto') return isCrypto(title)
  if (tab === 'sports') return isSports(title)
  return isEsports(title)
}

function extractAsset(title: string): string | null {
  const t = title.toLowerCase()
  for (const [name, kws] of Object.entries(ASSET_KEYWORDS)) {
    if (kws.some(kw => t.includes(kw))) return name
  }
  return null
}

function extractDuration(title: string): string | null {
  // Polymarket 1H candle: "Bitcoin Up or Down – May 28 (1 AM ET Candle)"
  if (/candle\)/i.test(title)) return '1 Hour'
  // Polymarket 4H multi-strike: "Bitcoin above ___ on Aug 29, 4PM ET?"
  if (/above\s+_{2,}/i.test(title)) return '4 Hours'
  // Polymarket time-range: "5:15AM-5:20AM ET", "4:45AM-5:00AM ET"
  const rangeMatch = title.match(/(\d{1,2})(?::(\d{2}))?(AM|PM)-(\d{1,2})(?::(\d{2}))?(AM|PM)/i)
  if (rangeMatch) {
    const toMin = (h: string, m: string | undefined, ap: string) => {
      let hh = parseInt(h); const mm = m ? parseInt(m) : 0
      if (ap.toUpperCase() === 'PM' && hh !== 12) hh += 12
      if (ap.toUpperCase() === 'AM' && hh === 12) hh = 0
      return hh * 60 + mm
    }
    const start = toMin(rangeMatch[1], rangeMatch[2], rangeMatch[3])
    const end = toMin(rangeMatch[4], rangeMatch[5], rangeMatch[6])
    let diff = end - start; if (diff < 0) diff += 24 * 60
    if (diff === 5) return '5 Min'
    if (diff === 15) return '15 Min'
    if (diff === 30) return '30 Min'
    if (diff === 60) return '1 Hour'
    if (diff === 240) return '4 Hours'
    return null
  }
  // Polymarket 1H candle format: "DOGE Up or Down - May 25, 7AM ET" (specific time, no range)
  if (/\d+(AM|PM)\s*ET/i.test(title) && !/above|below|reach|\d{1,2}(?::\d{2})?(AM|PM)-/i.test(title)) return '1 Hour'
  // Text patterns (Limitless and fallback)
  if (/\b15\s*min/i.test(title)) return '15 Min'
  if (/\b5\s*min/i.test(title)) return '5 Min'
  if (/1\s*hour/i.test(title) || /hourly/i.test(title)) return '1 Hour'
  if (/4\s*hour/i.test(title)) return '4 Hours'
  if (/daily/i.test(title) || /\bday\b/i.test(title) || /\bon [a-z]+ \d+\?/i.test(title)) return 'Daily'
  if (/weekly/i.test(title) || /\bweek\b/i.test(title)) return 'Weekly'
  if (/monthly/i.test(title) || /\bmonth\b/i.test(title)) return 'Monthly'
  if (/yearly/i.test(title) || /\byear\b/i.test(title)) return 'Yearly'
  if (/pre.?market/i.test(title)) return 'Pre-Market'
  if (/etf/i.test(title)) return 'ETF'
  return null
}

function extractSportType(title: string): string | null {
  const t = title.toLowerCase()
  for (const [name, kws] of Object.entries(SPORT_KEYWORDS)) {
    if (kws.some(kw => t.includes(kw))) return name
  }
  return null
}

function extractEsportGame(title: string): string | null {
  const t = title.toLowerCase()
  for (const [name, kws] of Object.entries(ESPORT_KEYWORDS)) {
    if (kws.some(kw => t.includes(kw))) return name
  }
  return null
}

interface PolyMarket { conditionId: string; question: string; bestBid: number; bestAsk: number; volumeNum: number; tokens: Array<{ token_id: string }> }
interface LimMarket { id: string; title: string; bestBid: string; bestAsk: string; volume: string }
interface SidebarSection { title: string; items: { label: string; count: number }[]; activeVal: string | null; onSelect: (val: string) => void }

function buildCryptoSections(
  markets: { q: string }[],
  durActive: string | null, assetActive: string | null,
  setDur: (v: string) => void, setAsset: (v: string) => void,
): SidebarSection[] {
  const durMap = new Map<string, number>()
  const assetMap = new Map<string, number>()
  for (const { q } of markets) {
    const d = extractDuration(q); if (d) durMap.set(d, (durMap.get(d) || 0) + 1)
    const a = extractAsset(q); if (a) assetMap.set(a, (assetMap.get(a) || 0) + 1)
  }
  const durOrder = ['5 Min', '15 Min', '30 Min', '1 Hour', '4 Hours', 'Daily', 'Weekly', 'Monthly', 'Yearly', 'Pre-Market', 'ETF']
  const durItems = [
    { label: 'All', count: markets.length },
    ...durOrder.map(d => ({ label: d, count: durMap.get(d) ?? 0 })).filter(item => item.count > 0 || ['1 Hour', '4 Hours'].includes(item.label)),
  ]
  const assetItems = ASSETS.filter(a => assetMap.has(a)).map(a => ({ label: a, count: assetMap.get(a)! }))
  const sections: SidebarSection[] = [{ title: 'Duration', items: durItems, activeVal: durActive, onSelect: setDur }]
  if (assetItems.length) sections.push({ title: 'Assets', items: assetItems, activeVal: assetActive, onSelect: setAsset })
  return sections
}

function buildSportSections(markets: { q: string }[], active: string | null, onSelect: (v: string) => void): SidebarSection[] {
  const typeMap = new Map<string, number>()
  for (const { q } of markets) { const s = extractSportType(q); if (s) typeMap.set(s, (typeMap.get(s) || 0) + 1) }
  const items = [{ label: 'All', count: markets.length }, ...SPORT_TYPES.filter(s => typeMap.has(s)).map(s => ({ label: s, count: typeMap.get(s)! }))]
  return [{ title: 'Sport', items, activeVal: active, onSelect }]
}

function buildEsportSections(markets: { q: string }[], active: string | null, onSelect: (v: string) => void): SidebarSection[] {
  const gameMap = new Map<string, number>()
  for (const { q } of markets) { const g = extractEsportGame(q); if (g) gameMap.set(g, (gameMap.get(g) || 0) + 1) }
  const items = [{ label: 'All', count: markets.length }, ...ESPORT_GAMES.filter(g => gameMap.has(g)).map(g => ({ label: g, count: gameMap.get(g)! }))]
  return [{ title: 'Game', items, activeVal: active, onSelect }]
}

export default function Markets() {
  const [topTab, setTopTab] = useState<TopTab>('all')
  const [polyDur, setPolyDur] = useState<string | null>(null)
  const [polyAsset, setPolyAsset] = useState<string | null>(null)
  const [polySport, setPolySport] = useState<string | null>(null)
  const [polyEsport, setPolyEsport] = useState<string | null>(null)
  const [limDur, setLimDur] = useState<string | null>(null)
  const [limAsset, setLimAsset] = useState<string | null>(null)
  const [limSport, setLimSport] = useState<string | null>(null)
  const [limEsport, setLimEsport] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ exchange: string; id: string; tokenId?: string } | null>(null)
  const setSelectedMarket = useStore((s) => s.setSelectedMarket)
  const setScannerFilter = useStore((s) => s.setScannerFilter)
  const navigate = useNavigate()

  const sendToScanner = () => {
    setScannerFilter({
      topTab,
      dur: polyDur,
      asset: polyAsset,
      sport: polySport,
      esport: polyEsport,
    })
    navigate('/scanner')
  }

  // Fetch both exchanges — Polymarket served from disk cache instantly, Limitless fetched live.
  const { data, isLoading } = useMarkets('both', undefined, {}, 'all')
  const allPoly = useMemo(() => (data?.polymarket ?? []) as PolyMarket[], [data])
  const allLim = useMemo(() => (data?.limitless ?? []) as LimMarket[], [data])

  // Filter markets by top tab
  const polyByTab = useMemo(() => allPoly.filter(m => matchesTab(m.question, topTab)), [allPoly, topTab])
  const limByTab = useMemo(() => allLim.filter(m => matchesTab(m.title, topTab)), [allLim, topTab])

  // Apply sub-filters (Polymarket)
  const polyFiltered = useMemo(() => {
    let list = polyByTab
    if (topTab === 'crypto') {
      if (polyDur) list = list.filter(m => extractDuration(m.question) === polyDur)
      if (polyAsset) list = list.filter(m => extractAsset(m.question) === polyAsset)
    } else if (topTab === 'sports' && polySport) {
      list = list.filter(m => extractSportType(m.question) === polySport)
    } else if (topTab === 'esports' && polyEsport) {
      list = list.filter(m => extractEsportGame(m.question) === polyEsport)
    }
    return list
  }, [polyByTab, topTab, polyDur, polyAsset, polySport, polyEsport])

  // Apply sub-filters (Limitless)
  const limFiltered = useMemo(() => {
    let list = limByTab
    if (topTab === 'crypto') {
      if (limDur) list = list.filter(m => extractDuration(m.title) === limDur)
      if (limAsset) list = list.filter(m => extractAsset(m.title) === limAsset)
    } else if (topTab === 'sports' && limSport) {
      list = list.filter(m => extractSportType(m.title) === limSport)
    } else if (topTab === 'esports' && limEsport) {
      list = list.filter(m => extractEsportGame(m.title) === limEsport)
    }
    return list
  }, [limByTab, topTab, limDur, limAsset, limSport, limEsport])

  // Left sidebar: Polymarket filters
  const polySidebarSections = useMemo((): SidebarSection[] => {
    if (topTab === 'all') return []
    const qs = polyByTab.map(m => ({ q: m.question }))
    if (topTab === 'crypto') return buildCryptoSections(qs, polyDur, polyAsset,
      v => setPolyDur(v === 'All' ? null : v), v => setPolyAsset(v === polyAsset ? null : v))
    if (topTab === 'sports') return buildSportSections(qs, polySport, v => setPolySport(v === 'All' ? null : v))
    return buildEsportSections(qs, polyEsport, v => setPolyEsport(v === 'All' ? null : v))
  }, [polyByTab, topTab, polyDur, polyAsset, polySport, polyEsport])

  // Right sidebar: Limitless filters
  const limSidebarSections = useMemo((): SidebarSection[] => {
    if (topTab === 'all') return []
    const qs = limByTab.map(m => ({ q: m.title }))
    if (topTab === 'crypto') return buildCryptoSections(qs, limDur, limAsset,
      v => setLimDur(v === 'All' ? null : v), v => setLimAsset(v === limAsset ? null : v))
    if (topTab === 'sports') return buildSportSections(qs, limSport, v => setLimSport(v === 'All' ? null : v))
    return buildEsportSections(qs, limEsport, v => setLimEsport(v === 'All' ? null : v))
  }, [limByTab, topTab, limDur, limAsset, limSport, limEsport])

  const handleTopTab = (tab: TopTab) => {
    setTopTab(tab)
    setPolyDur(null); setPolyAsset(null); setPolySport(null); setPolyEsport(null)
    setLimDur(null); setLimAsset(null); setLimSport(null); setLimEsport(null)
    setSelected(null)
  }

  const { data: book, isLoading: bookLoading } = useOrderBook(
    selected?.exchange ?? '', selected?.tokenId ?? selected?.id ?? '', !!selected)

  const polyTokenIds = polyFiltered.slice(0, 50).map(m => m.tokens?.[0]?.token_id ?? '').filter(Boolean)
  const { data: livePrices } = useLivePrices(polyTokenIds)

  const handleSelect = (exchange: string, id: string, question: string, tokenId?: string) => {
    setSelected({ exchange, id, tokenId }); setSelectedMarket({ exchange, id, question, tokenId })
  }

  const dim = { color: 'hsl(215,20%,50%)' }
  const bright = { color: 'hsl(210,40%,92%)' }
  const green = { color: 'hsl(142,70%,50%)' }
  const red = { color: 'hsl(0,84%,60%)' }

  const sidebarItemStyle = (active: boolean) => active
    ? { background: 'hsl(217,32%,15%)', color: 'hsl(210,40%,92%)', borderRadius: '6px', margin: '0 6px' }
    : { color: dim.color }

  const renderSidebar = (sections: SidebarSection[]) => (
    <div className="w-36 shrink-0 overflow-y-auto rounded-xl border py-1" style={{ borderColor: 'hsl(217,32%,17%)', background: 'hsl(222,47%,7%)' }}>
      {sections.map((section, si) => (
        <div key={section.title}>
          {si > 0 && <div className="mx-3 my-1 border-t" style={{ borderColor: 'hsl(217,32%,12%)' }} />}
          <div className="px-3 pt-2 pb-0.5 text-[10px] uppercase tracking-widest font-semibold" style={{ color: 'hsl(215,20%,38%)' }}>{section.title}</div>
          {section.items.map(item => {
            const isAll = item.label === 'All'
            const active = isAll ? section.activeVal === null : section.activeVal === item.label
            return (
              <button key={item.label} onClick={() => section.onSelect(item.label)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-white/5 transition-colors"
                style={sidebarItemStyle(active)}>
                <span className="flex-1 text-left truncate">{item.label}</span>
                <span className="text-[10px] shrink-0" style={{ color: 'hsl(215,20%,40%)' }}>{item.count}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Top category tabs */}
      <div className="shrink-0 flex items-center gap-1">
        {TOP_TABS.map(t => (
          <button key={t.tag} onClick={() => handleTopTab(t.tag)}
            className="px-4 py-1.5 rounded-md text-xs font-semibold tracking-wide transition-colors"
            style={topTab === t.tag
              ? { background: 'hsl(217,32%,17%)', color: 'hsl(142,70%,45%)', border: '1px solid hsl(217,32%,28%)' }
              : { background: 'transparent', color: 'hsl(215,20%,55%)', border: '1px solid transparent' }}>
            {t.label}
          </button>
        ))}
        <button onClick={sendToScanner}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors"
          style={{ background: 'hsl(217,32%,15%)', color: 'hsl(217,80%,65%)', border: '1px solid hsl(217,32%,25%)' }}>
          <ScanLine size={12} /> Send to Scanner
        </button>
      </div>

      {/* [Poly sidebar] [Poly panel] [Lim panel] [Lim sidebar] */}
      <div className="flex gap-3 flex-1 min-h-0">
        {polySidebarSections.length > 0 && renderSidebar(polySidebarSections)}

        {/* Polymarket panel */}
        <div className="flex-1 flex flex-col min-h-0 rounded-xl border overflow-hidden" style={{ borderColor: 'hsl(217,32%,17%)' }}>
          <div className="shrink-0 px-3 py-2 border-b flex items-center" style={{ background: 'hsl(222,47%,7%)', borderColor: 'hsl(217,32%,17%)' }}>
            <span className="text-xs font-semibold uppercase tracking-wider" style={bright}>Polymarket ({polyFiltered.length})</span>
          </div>
          <div className="flex-1 overflow-y-auto" style={{ background: 'hsl(222,47%,8%)' }}>
            {isLoading ? <div className="text-center py-12 text-xs" style={dim}>Loading…</div> :
              polyFiltered.length === 0 ? <div className="text-center py-12 text-xs" style={dim}>No markets found</div> :
              polyFiltered.map(m => {
                const isActive = selected?.exchange === 'polymarket' && selected.id === m.conditionId
                const tokenId = m.tokens?.[0]?.token_id
                const live = tokenId ? livePrices?.[tokenId] : null
                return (
                  <div key={m.conditionId} className="px-3 py-2 border-b hover:bg-white/5 transition-colors cursor-pointer"
                    style={{ borderColor: 'hsl(217,32%,13%)', background: isActive ? 'hsl(217,32%,17%)' : 'transparent' }}
                    onClick={() => handleSelect('polymarket', m.conditionId, m.question, tokenId)}>
                    <p className="text-xs leading-snug mb-1 truncate" style={bright}>{m.question}</p>
                    <div className="flex items-center gap-3 text-xs" style={dim}>
                      <span>Bid <span style={green}>{live?.bestBid ?? m.bestBid?.toFixed(3)}</span></span>
                      <span>Ask <span style={red}>{live?.bestAsk ?? m.bestAsk?.toFixed(3)}</span></span>
                      <span>Vol ${(m.volumeNum / 1000).toFixed(0)}k</span>
                    </div>
                  </div>
                )
              })}
          </div>
        </div>

        {/* Limitless panel */}
        <div className="flex-1 flex flex-col min-h-0 rounded-xl border overflow-hidden" style={{ borderColor: 'hsl(217,32%,17%)' }}>
          <div className="shrink-0 px-3 py-2 border-b flex items-center" style={{ background: 'hsl(222,47%,7%)', borderColor: 'hsl(217,32%,17%)' }}>
            <span className="text-xs font-semibold uppercase tracking-wider" style={bright}>Limitless ({limFiltered.length})</span>
          </div>
          <div className="flex-1 overflow-y-auto" style={{ background: 'hsl(222,47%,8%)' }}>
            {isLoading ? <div className="text-center py-12 text-xs" style={dim}>Loading…</div> :
              limFiltered.length === 0 ? <div className="text-center py-12 text-xs" style={dim}>No markets found</div> :
              limFiltered.map(m => {
                const isActive = selected?.exchange === 'limitless' && selected.id === m.id
                return (
                  <div key={m.id} className="px-3 py-2 border-b hover:bg-white/5 transition-colors cursor-pointer"
                    style={{ borderColor: 'hsl(217,32%,13%)', background: isActive ? 'hsl(217,32%,17%)' : 'transparent' }}
                    onClick={() => handleSelect('limitless', m.id, m.title)}>
                    <p className="text-xs leading-snug mb-1 truncate" style={bright}>{m.title}</p>
                    <div className="flex items-center gap-3 text-xs" style={dim}>
                      <span>Bid <span style={green}>{parseFloat(m.bestBid || '0').toFixed(3)}</span></span>
                      <span>Ask <span style={red}>{parseFloat(m.bestAsk || '0').toFixed(3)}</span></span>
                      <span>Vol ${(parseFloat(m.volume || '0') / 1000).toFixed(0)}k</span>
                    </div>
                  </div>
                )
              })}
          </div>
        </div>

        {limSidebarSections.length > 0 && renderSidebar(limSidebarSections)}
      </div>

      {/* Selected market detail */}
      {selected && (
        <div className="shrink-0 flex gap-3">
          <div className="w-72 space-y-3">
            {selected.exchange === 'polymarket' && <MarketCard conditionId={selected.id} />}
          </div>
          <div className="w-64 rounded-xl border p-4" style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>
            <h3 className="text-xs font-semibold uppercase mb-3" style={{ color: 'hsl(215,20%,65%)' }}>Orderbook</h3>
            <OrderBook bids={book?.bids ?? []} asks={book?.asks ?? []} loading={bookLoading} />
            <button onClick={() => navigate('/trade')}
              className="w-full mt-3 py-2 rounded-lg text-sm font-medium flex items-center justify-center gap-2"
              style={{ background: 'hsl(142,70%,40%)', color: 'hsl(222,47%,5%)' }}>
              <ExternalLink size={13} /> Trade This Market
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
