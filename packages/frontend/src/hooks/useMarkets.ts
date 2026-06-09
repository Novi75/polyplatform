import { useQuery } from '@tanstack/react-query'
import { useState, useEffect, useCallback } from 'react'
import { fetcher } from '../lib/api.ts'
import { useChannel } from './useWebSocket.ts'

type Level = { price: string; size: string }
type BookData = { bids: Level[]; asks: Level[] }

export interface PolyMarketData {
  buyPrice: string | null
  sellPrice: string | null
  midpoint: string | null
  lastTradePrice: string | null
  lastTradeSide: string | null
  spread: string | null
  tickSize: number | null
}

export interface LiveTokenPrice {
  bestBid: string | null
  bestAsk: string | null
  spread: string | null
}

// Polls CLOB /books for live bid/ask on up to 50 tokens every 3 seconds
export function useLivePrices(tokenIds: string[]) {
  const valid = tokenIds.filter((id) => id && id.length >= 10).slice(0, 50)
  return useQuery<Record<string, LiveTokenPrice>>({
    queryKey: ['live-prices', valid.join(',')],
    queryFn: () => fetcher(`/prices/live?token_ids=${valid.join(',')}`),
    enabled: valid.length > 0,
    staleTime: 0,
    refetchInterval: 3_000,   // poll CLOB every 3 seconds
    refetchIntervalInBackground: true,
  })
}

export function useMarketData(tokenId: string, enabled = true) {
  return useQuery<PolyMarketData>({
    queryKey: ['market-data', tokenId],
    queryFn: () => fetcher(`/markets/polymarket/${tokenId}/market-data`),
    enabled: !!tokenId && tokenId.length >= 10 && enabled,
    staleTime: 3_000,
    refetchInterval: 5_000,
  })
}

export interface GammaMarketDetail {
  conditionId: string
  question: string
  image?: string
  icon?: string
  outcomes: string[]
  outcomePrices: number[]
  clobTokenIds: string[]
  volume: number
  volume24hr: number
  liquidity: number
  endDate: string
  lastTradePrice: number | null
  oneDayPriceChange: number | null
  oneWeekPriceChange: number | null
  oneMonthPriceChange: number | null
  featured: boolean
}

export function useMarketDetail(conditionId: string, enabled = true) {
  return useQuery<GammaMarketDetail>({
    queryKey: ['market-detail', conditionId],
    queryFn: () => fetcher(`/markets/polymarket/${conditionId}/detail`),
    enabled: !!conditionId && conditionId.startsWith('0x') && enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

export interface MarketFilters {
  order?: string
  ascending?: boolean
  competitive?: boolean
  trending?: boolean
  tag?: string
  new?: boolean
  minVolume?: number
}

export interface PolyEvent {
  id: string
  title: string
  slug: string
  image?: string
  icon?: string
  volume: number
  volume24hr: number
  endDate: string
  markets: Array<{
    conditionId: string
    question: string
    outcomes: string
    outcomePrices: string
    volume: string
  }>
}

export function useEvents(tag?: string, trending?: boolean, limit = 20) {
  return useQuery<{ events: PolyEvent[] }>({
    queryKey: ['events', tag, trending, limit],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (tag) params.set('tag', tag)
      if (trending) params.set('trending', 'true')
      return fetcher(`/events?${params}`)
    },
    staleTime: 30_000,
    enabled: true,
  })
}

export function useMarkets(exchange = 'both', q?: string, filters: MarketFilters = {}, limit: number | 'all' = 'all') {
  const { order = 'volumeNum', ascending = false, competitive = false, trending = false, tag, new: isNew, minVolume } = filters
  // eventVolume is a client-side sort — fetch by volumeNum so we get the full dataset,
  // then Scanner.tsx re-sorts by eventVolume after receiving the data.
  const backendOrder = order === 'eventVolume' ? 'volumeNum' : order
  return useQuery({
    queryKey: ['markets', exchange, q, order, ascending, competitive, trending, tag, isNew, minVolume, limit],
    queryFn: () => {
      const params = new URLSearchParams({ exchange })
      if (q) params.set('q', q)
      if (backendOrder !== 'volumeNum') params.set('order', backendOrder)
      if (ascending) params.set('ascending', 'true')
      if (competitive) params.set('competitive', 'true')
      if (trending) params.set('trending', 'true')
      if (tag) params.set('tag', tag)
      if (isNew) params.set('new', 'true')
      if (minVolume && minVolume > 0) params.set('min_volume', String(minVolume))
      if (limit === 'all') params.set('limit', 'all')
      else if (limit > 100) params.set('limit', String(limit))
      return fetcher(`/markets?${params}`)
    },
    staleTime: limit === 'all' ? 270_000 : 30_000,   // 4.5 min stale for full dataset (matches 5 min cache)
    refetchInterval: limit === 'all' ? 300_000 : 60_000,
  })
}

export function useOrderBook(exchange: string, id: string, enabled = true) {
  const [liveBook, setLiveBook] = useState<BookData | null>(null)
  const [isLive, setIsLive] = useState(false)

  // Clear stale live data when market changes
  useEffect(() => {
    setLiveBook(null)
    setIsLive(false)
  }, [exchange, id])

  const { data: restBook, isLoading } = useQuery({
    queryKey: ['orderbook', exchange, id],
    queryFn: () => fetcher(`/markets/${exchange}/${id}/book`),
    staleTime: 10_000,
    refetchInterval: 30_000,  // slow poll as WS handles live updates
    enabled: !!id && enabled,
  })

  const channel = id && enabled ? `orderbook.${exchange}.${id}` : ''

  const handleWs = useCallback((msg: unknown) => {
    const m = msg as { bids?: Level[]; asks?: Level[] }
    if (m.bids && m.asks) {
      setLiveBook({ bids: m.bids, asks: m.asks })
      setIsLive(true)
    }
  }, [])

  useChannel(channel, handleWs)

  const book = liveBook ?? (restBook as BookData | undefined) ?? null
  return { data: book, isLoading, isLive }
}
