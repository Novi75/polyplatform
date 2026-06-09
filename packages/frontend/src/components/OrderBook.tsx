import type { PolyMarketData } from '../hooks/useMarkets.ts'

interface Level {
  price: string
  size: string
}

interface Props {
  bids: Level[]
  asks: Level[]
  loading?: boolean
  marketData?: PolyMarketData | null
}

export function OrderBook({ bids, asks, loading, marketData }: Props) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-sm" style={{ color: 'hsl(215,20%,55%)' }}>
        Loading orderbook...
      </div>
    )
  }

  if (bids.length === 0 && asks.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-xs" style={{ color: 'hsl(215,20%,45%)' }}>
        No orders in book
      </div>
    )
  }

  const topAsks = asks.slice(0, 8).reverse()
  const topBids = bids.slice(0, 8)
  const bookSpread =
    asks.length > 0 && bids.length > 0
      ? (parseFloat(asks[0].price) - parseFloat(bids[0].price)).toFixed(4)
      : null

  const maxSize = Math.max(
    ...topAsks.map((l) => parseFloat(l.size)),
    ...topBids.map((l) => parseFloat(l.size)),
    1,
  )

  const dim = { color: 'hsl(215,20%,50%)' }

  return (
    <div className="text-xs font-mono space-y-2">

      {/* Price metrics strip */}
      {marketData && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-1 py-2 rounded-lg" style={{ background: 'hsl(222,47%,11%)' }}>
          {marketData.midpoint && (
            <div className="flex justify-between">
              <span style={dim}>Mid</span>
              <span style={{ color: 'hsl(210,40%,90%)' }}>{parseFloat(marketData.midpoint).toFixed(4)}</span>
            </div>
          )}
          {marketData.spread && (
            <div className="flex justify-between">
              <span style={dim}>Spread</span>
              <span style={{ color: 'hsl(210,40%,90%)' }}>{parseFloat(marketData.spread).toFixed(4)}</span>
            </div>
          )}
          {marketData.lastTradePrice && (
            <div className="flex justify-between">
              <span style={dim}>Last</span>
              <span style={{ color: marketData.lastTradeSide === 'BUY' ? 'hsl(142,70%,55%)' : 'hsl(0,84%,60%)' }}>
                {parseFloat(marketData.lastTradePrice).toFixed(4)}
                {marketData.lastTradeSide ? ` ${marketData.lastTradeSide}` : ''}
              </span>
            </div>
          )}
          {marketData.tickSize != null && (
            <div className="flex justify-between">
              <span style={dim}>Tick</span>
              <span style={{ color: 'hsl(210,40%,90%)' }}>{marketData.tickSize}</span>
            </div>
          )}
          {(marketData.buyPrice || marketData.sellPrice) && (
            <>
              {marketData.buyPrice && (
                <div className="flex justify-between">
                  <span style={dim}>Buy</span>
                  <span style={{ color: 'hsl(142,70%,55%)' }}>{parseFloat(marketData.buyPrice).toFixed(4)}</span>
                </div>
              )}
              {marketData.sellPrice && (
                <div className="flex justify-between">
                  <span style={dim}>Sell</span>
                  <span style={{ color: 'hsl(0,84%,60%)' }}>{parseFloat(marketData.sellPrice).toFixed(4)}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Orderbook levels */}
      <div>
        <div className="grid grid-cols-2 mb-1 px-1" style={dim}>
          <span>Price</span>
          <span className="text-right">Size</span>
        </div>

        {/* Asks */}
        <div className="space-y-0.5 mb-1">
          {topAsks.map((level, i) => (
            <div key={i} className="relative grid grid-cols-2 px-1 py-0.5 rounded overflow-hidden">
              <div
                className="absolute inset-y-0 right-0"
                style={{ width: `${(parseFloat(level.size) / maxSize) * 100}%`, background: 'hsl(0,84%,20%)', opacity: 0.4 }}
              />
              <span style={{ color: 'hsl(0,84%,65%)' }}>{parseFloat(level.price).toFixed(4)}</span>
              <span className="text-right" style={{ color: 'hsl(210,40%,80%)' }}>{parseFloat(level.size).toFixed(2)}</span>
            </div>
          ))}
        </div>

        {/* Spread from book */}
        <div className="text-center py-1" style={dim}>
          Spread: {bookSpread ?? '-'}
        </div>

        {/* Bids */}
        <div className="space-y-0.5 mt-1">
          {topBids.map((level, i) => (
            <div key={i} className="relative grid grid-cols-2 px-1 py-0.5 rounded overflow-hidden">
              <div
                className="absolute inset-y-0 right-0"
                style={{ width: `${(parseFloat(level.size) / maxSize) * 100}%`, background: 'hsl(142,70%,20%)', opacity: 0.4 }}
              />
              <span style={{ color: 'hsl(142,70%,55%)' }}>{parseFloat(level.price).toFixed(4)}</span>
              <span className="text-right" style={{ color: 'hsl(210,40%,80%)' }}>{parseFloat(level.size).toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
