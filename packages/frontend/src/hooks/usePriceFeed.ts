import { useEffect, useState } from 'react'
import { useWebSocket } from './useWebSocket.ts'

export interface LivePrice {
  price: number       // best_ask when available, otherwise last price
  bid: number | null  // best_bid from best_bid_ask or price_change events
  ask: number | null  // best_ask from best_bid_ask or price_change events
  side: 'buy' | 'sell' | 'ask'
  ts: number
}

// Subscribes to WS price channels for visible markets.
// Returns a Map keyed by tokenId (Polymarket) or slug (Limitless).
export function usePriceFeed(
  polyTokenIds: string[],
  limSlugs: string[],
): Map<string, LivePrice> {
  const { subscribe } = useWebSocket()
  const [prices, setPrices] = useState<Map<string, LivePrice>>(new Map())

  const validPolyIds = polyTokenIds.filter(Boolean).slice(0, 30)
  const validLimSlugs = limSlugs.filter(Boolean).slice(0, 30)
  const polyKey = validPolyIds.join(',')
  const limKey = validLimSlugs.join(',')

  useEffect(() => {
    const cleanups: Array<() => void> = []

    for (const tokenId of validPolyIds) {
      cleanups.push(
        subscribe(`prices.polymarket.${tokenId}`, (msg) => {
          const m = msg as {
            price?: string; side?: string
            best_bid?: string; best_ask?: string
            last_price?: string
          }
          const bid = m.best_bid ? parseFloat(m.best_bid) : null
          const ask = m.best_ask ? parseFloat(m.best_ask) : null
          // Prefer best_ask, fall back to price or last_price
          const displayPrice = ask ?? (m.price ? parseFloat(m.price) : null) ?? (m.last_price ? parseFloat(m.last_price) : null)
          if (displayPrice == null) return
          const side = m.side?.toUpperCase() === 'BUY' ? 'buy' : 'sell'
          setPrices((prev) => new Map(prev).set(tokenId, { price: displayPrice, bid, ask, side, ts: Date.now() }))
        })
      )
    }

    for (const slug of validLimSlugs) {
      cleanups.push(
        subscribe(`prices.limitless.${slug}`, (msg) => {
          const m = msg as { price?: string; best_ask?: string; best_bid?: string }
          const askStr = m.best_ask ?? m.price
          if (!askStr) return
          const ask = parseFloat(askStr)
          const bid = m.best_bid ? parseFloat(m.best_bid) : null
          setPrices((prev) => new Map(prev).set(slug, { price: ask, bid, ask, side: 'ask', ts: Date.now() }))
        })
      )
    }

    return () => cleanups.forEach((fn) => fn())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polyKey, limKey, subscribe])

  return prices
}
