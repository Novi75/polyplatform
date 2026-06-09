import { create } from 'zustand'

export interface ArbOpportunity {
  id: string
  polyQuestion: string
  limitlessTitle: string
  polymarketBestAsk: number
  limitlessBestAsk: number
  priceDiffPct: number
  estimatedProfitPct: number
  direction: 'buy_poly_sell_lim' | 'buy_lim_sell_poly'
  suggestedSize: number
  expiresAt: number
}

export interface EngineStatus {
  running: boolean
  lastError: string | null
}

interface WsMessage {
  type: string
  [key: string]: unknown
}

export interface ScannerFilter {
  topTab: 'all' | 'crypto' | 'sports' | 'esports'
  dur: string | null
  asset: string | null
  sport: string | null
  esport: string | null
}

interface Store {
  // WebSocket
  wsConnected: boolean
  setWsConnected: (v: boolean) => void

  // Arb opportunities (live from WS)
  opportunities: ArbOpportunity[]
  addOpportunity: (opp: ArbOpportunity) => void
  removeOpportunity: (id: string) => void

  // Engine status
  engineStatus: EngineStatus
  setEngineStatus: (s: EngineStatus) => void

  // Order updates
  lastOrderUpdate: WsMessage | null
  setLastOrderUpdate: (m: WsMessage) => void

  // Selected market for trade
  selectedMarket: { exchange: string; id: string; question: string; tokenId?: string } | null
  setSelectedMarket: (m: { exchange: string; id: string; question: string; tokenId?: string } | null) => void

  // Scanner filter (persists across navigation from Markets page)
  scannerFilter: ScannerFilter | null
  setScannerFilter: (f: ScannerFilter | null) => void
}

export const useStore = create<Store>((set) => ({
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),

  opportunities: [],
  addOpportunity: (opp) =>
    set((s) => ({
      opportunities: [opp, ...s.opportunities.filter((o) => o.id !== opp.id)].slice(0, 50),
    })),
  removeOpportunity: (id) =>
    set((s) => ({ opportunities: s.opportunities.filter((o) => o.id !== id) })),

  engineStatus: { running: false, lastError: null },
  setEngineStatus: (s) => set({ engineStatus: s }),

  lastOrderUpdate: null,
  setLastOrderUpdate: (m) => set({ lastOrderUpdate: m }),

  selectedMarket: null,
  setSelectedMarket: (m) => set({ selectedMarket: m }),

  scannerFilter: null,
  setScannerFilter: (f) => set({ scannerFilter: f }),
}))
