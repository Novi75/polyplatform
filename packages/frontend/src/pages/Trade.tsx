import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore.ts'
import { useOrderBook, useMarketData } from '../hooks/useMarkets.ts'
import { MarketTradeWidget } from '../components/MarketTradeWidget.tsx'
import { OrderBook } from '../components/OrderBook.tsx'
import { api } from '../lib/api.ts'
import { useQuery } from '@tanstack/react-query'
import { fetcher } from '../lib/api.ts'

type OrderType = 'GTC' | 'FOK' | 'FAK'
type Side = 'BUY' | 'SELL'

export default function Trade() {
  const selectedMarket = useStore((s) => s.selectedMarket)
  const [exchange, setExchange] = useState(selectedMarket?.exchange ?? 'polymarket')
  const [marketId, setMarketId] = useState(selectedMarket?.id ?? '')
  const [tokenId, setTokenId] = useState('')
  const [side, setSide] = useState<Side>('BUY')
  const [price, setPrice] = useState('')
  const [size, setSize] = useState('')
  const [orderType, setOrderType] = useState<OrderType>('GTC')
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [loading, setLoading] = useState(false)

  // Sync form state whenever the global selectedMarket changes.
  // useState only initialises once — this effect fires on every selection
  // even when the Trade tab is already mounted (no re-mount = no reinit).
  useEffect(() => {
    if (!selectedMarket) return
    setExchange(selectedMarket.exchange ?? 'polymarket')
    setMarketId(selectedMarket.id ?? '')
    setTokenId(selectedMarket.tokenId ?? '')  // pre-fill YES token when available
    setStatus(null)
  }, [selectedMarket?.id, selectedMarket?.exchange, selectedMarket?.tokenId])

  const bookTokenId = exchange === 'polymarket' ? tokenId : ''
  const { data: marketData } = useMarketData(bookTokenId, exchange === 'polymarket' && !!tokenId)

  const { data: book, isLoading: bookLoading } = useOrderBook(
    exchange,
    exchange === 'polymarket' ? tokenId : marketId,
    !!(exchange === 'polymarket' ? tokenId : marketId),
  )

  const ordersQuery = useQuery({
    queryKey: ['orders', exchange],
    queryFn: () => fetcher(`/orders/${exchange}?status=open`),
    staleTime: 15_000,
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setStatus(null)
    try {
      if (exchange === 'polymarket') {
        await api.post('/orders', { exchange: 'polymarket', tokenId, side, price: parseFloat(price), size: parseFloat(size), orderType })
      } else {
        await api.post('/orders', { exchange: 'limitless', marketId, side, price, size, orderType: orderType === 'FAK' ? 'FOK' : orderType })
      }
      setStatus({ ok: true, msg: 'Order placed successfully' })
      ordersQuery.refetch()
    } catch (err) {
      setStatus({ ok: false, msg: (err as Error).message })
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = {
    background: 'hsl(222,47%,11%)',
    border: '1px solid hsl(217,32%,20%)',
    color: 'hsl(210,40%,98%)',
    borderRadius: '8px',
    padding: '8px 12px',
    fontSize: '14px',
    width: '100%',
    outline: 'none',
  }

  const labelStyle = { fontSize: '12px', color: 'hsl(215,20%,60%)', marginBottom: '6px', display: 'block' }

  const orders: unknown[] = ordersQuery.data ?? []

  // Called by MarketTradeWidget when user clicks Buy/Sell on an outcome card
  const handleOutcomeSelect = (tid: string, p: string, s: 'BUY' | 'SELL', _outcome: string) => {
    setTokenId(tid)
    setPrice(parseFloat(p).toFixed(2))
    setSide(s)
  }

  return (
    <div className="flex gap-5 items-start h-full min-h-0">
      {/* Trade form */}
      <div className="w-96 shrink-0 space-y-4">
        <div className="rounded-xl border p-5 space-y-4" style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'hsl(210,40%,95%)' }}>Place Order</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Exchange */}
            <div>
              <label style={labelStyle}>Exchange</label>
              <div className="flex gap-2">
                {(['polymarket', 'limitless'] as const).map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => setExchange(ex)}
                    className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
                    style={
                      exchange === ex
                        ? { background: 'hsl(142,70%,40%)', color: 'hsl(222,47%,5%)' }
                        : { background: 'hsl(217,32%,17%)', color: 'hsl(215,20%,70%)' }
                    }
                  >
                    {ex === 'polymarket' ? 'Polymarket' : 'Limitless'}
                  </button>
                ))}
              </div>
            </div>

            {/* Market ID */}
            <div>
              <label style={labelStyle}>{exchange === 'polymarket' ? 'Condition ID' : 'Market ID'}</label>
              <input
                style={inputStyle}
                value={marketId}
                onChange={(e) => setMarketId(e.target.value)}
                placeholder={exchange === 'polymarket' ? '0x...' : 'market-slug'}
                required
              />
            </div>

            {exchange === 'polymarket' && (
              <div>
                <label style={labelStyle}>Token ID (YES/NO outcome)</label>
                <input style={inputStyle} value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="ERC-1155 token ID" required />
              </div>
            )}

            {/* Side */}
            <div>
              <label style={labelStyle}>Side</label>
              <div className="flex gap-2">
                {(['BUY', 'SELL'] as Side[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSide(s)}
                    className="flex-1 py-2 rounded-lg text-sm font-medium"
                    style={
                      side === s
                        ? s === 'BUY'
                          ? { background: 'hsl(142,70%,30%)', color: 'hsl(142,70%,65%)' }
                          : { background: 'hsl(0,84%,25%)', color: 'hsl(0,84%,65%)' }
                        : { background: 'hsl(217,32%,17%)', color: 'hsl(215,20%,70%)' }
                    }
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Price & Size */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label style={labelStyle}>Price (0.01–0.99)</label>
                <input style={inputStyle} type="number" step="0.01" min="0.01" max="0.99" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.50" required />
              </div>
              <div>
                <label style={labelStyle}>Size (shares)</label>
                <input style={inputStyle} type="number" step="1" min="1" value={size} onChange={(e) => setSize(e.target.value)} placeholder="100" required />
              </div>
            </div>

            {/* Order type */}
            <div>
              <label style={labelStyle}>Order Type</label>
              <div className="flex gap-2 flex-wrap">
                {(['GTC', 'FOK', 'FAK'] as OrderType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setOrderType(t)}
                    className="px-3 py-1.5 rounded text-xs font-medium"
                    style={
                      orderType === t
                        ? { background: 'hsl(217,32%,30%)', color: 'hsl(210,40%,98%)' }
                        : { background: 'hsl(217,32%,17%)', color: 'hsl(215,20%,60%)' }
                    }
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {status && (
              <div
                className="px-3 py-2 rounded-lg text-sm"
                style={{ background: status.ok ? 'hsl(142,70%,10%)' : 'hsl(0,84%,10%)', color: status.ok ? 'hsl(142,70%,55%)' : 'hsl(0,84%,65%)' }}
              >
                {status.msg}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg text-sm font-semibold disabled:opacity-50"
              style={{
                background: side === 'BUY' ? 'hsl(142,70%,40%)' : 'hsl(0,84%,50%)',
                color: side === 'BUY' ? 'hsl(222,47%,5%)' : 'white',
              }}
            >
              {loading ? 'Placing...' : `${side} ${orderType}`}
            </button>
          </form>
        </div>

        {/* Open orders */}
        <div className="rounded-xl border p-4" style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>
          <h3 className="text-xs font-semibold uppercase mb-3" style={{ color: 'hsl(215,20%,65%)' }}>Open Orders ({orders.length})</h3>
          {orders.length === 0 ? (
            <p className="text-sm text-center py-4" style={{ color: 'hsl(215,20%,45%)' }}>No open orders</p>
          ) : (
            <div className="space-y-2 text-xs font-mono">
              {orders.slice(0, 10).map((o, i) => (
                <div key={i} className="flex gap-2 py-1 border-b" style={{ borderColor: 'hsl(217,32%,13%)', color: 'hsl(215,20%,65%)' }}>
                  <pre>{JSON.stringify(o, null, 0).slice(0, 80)}...</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Live market trade widget — key=marketId forces full remount on market change,
          preventing stale React Query cache from briefly showing the wrong market */}
      {exchange === 'polymarket' && (
        <MarketTradeWidget
          key={marketId}
          conditionId={marketId}
          question={selectedMarket?.question}
          onOutcomeSelect={handleOutcomeSelect}
        />
      )}

      {/* Orderbook — its own panel, independent width */}
      <div
        className="w-48 shrink-0 rounded-xl border p-4 h-fit"
        style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}
      >
        <h3 className="text-xs font-semibold uppercase mb-3" style={{ color: 'hsl(215,20%,65%)' }}>Orderbook</h3>
        <OrderBook
          bids={book?.bids ?? []}
          asks={book?.asks ?? []}
          loading={bookLoading && !!(exchange === 'polymarket' ? tokenId : marketId)}
          marketData={exchange === 'polymarket' ? marketData : null}
        />
      </div>
    </div>
  )
}
