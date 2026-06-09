import { useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore.ts'

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1_000   // starts at 1s, doubles up to 30s
const MAX_DELAY = 30_000
const subscribers = new Map<string, Set<(data: unknown) => void>>()

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${proto}//${window.location.host}/ws`)

  ws.onopen = () => {
    reconnectDelay = 1_000   // reset backoff on successful connect
    useStore.getState().setWsConnected(true)

    // Resubscribe all active channels after reconnect
    const channels = [...subscribers.keys()]
    if (channels.length > 0 && ws) {
      ws.send(JSON.stringify({ type: 'subscribe', channels }))
    }
  }

  ws.onclose = () => {
    ws = null
    useStore.getState().setWsConnected(false)
    scheduleReconnect()
  }

  ws.onerror = () => {
    ws?.close()
  }

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as { type: string; [k: string]: unknown }
      const store = useStore.getState()

      if (msg.type === 'arb.opportunity') {
        store.addOpportunity(msg as unknown as Parameters<typeof store.addOpportunity>[0])
      }
      if (msg.type === 'arb.expired') store.removeOpportunity(msg.id as string)
      if (msg.type === 'engine.status') {
        store.setEngineStatus({ running: msg.running as boolean, lastError: msg.lastError as string | null })
      }
      if (msg.type === 'order.update') store.setLastOrderUpdate(msg)

      const channelKey = inferChannel(msg)
      if (channelKey) subscribers.get(channelKey)?.forEach((cb) => cb(msg))
    } catch {}
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY)
}

function inferChannel(msg: { type: string; [k: string]: unknown }): string | null {
  if (msg.type === 'orderbook.update' || msg.type === 'orderbook.snapshot') {
    return `orderbook.${msg.exchange as string}.${(msg.asset_id ?? msg.marketId) as string}`
  }
  if (msg.type === 'price.tick') {
    return `prices.${msg.exchange as string}.${(msg.asset_id ?? msg.marketId) as string}`
  }
  if (msg.type === 'arb.opportunity' || msg.type === 'arb.expired') {
    return 'arbitrage.opportunities'
  }
  if (msg.type === 'system.log') {
    return 'system.logs'
  }
  if (msg.type === 'prices.5min') return 'prices.5min'
  if (msg.type === 'arb.state') return 'arb.state'
  if (msg.type === 'arb.executed') return 'arb.state'
  return null
}

export function useWebSocket() {
  useEffect(() => {
    connect()
  }, [])

  const subscribe = useCallback((channel: string, cb: (data: unknown) => void) => {
    if (!subscribers.has(channel)) subscribers.set(channel, new Set())
    subscribers.get(channel)!.add(cb)

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', channels: [channel] }))
    }

    return () => {
      subscribers.get(channel)?.delete(cb)
    }
  }, [])

  return { subscribe }
}

export function useChannel(channel: string, cb: (data: unknown) => void) {
  const { subscribe } = useWebSocket()
  const cbRef = useRef(cb)
  cbRef.current = cb

  useEffect(() => {
    if (!channel) return
    return subscribe(channel, (data) => cbRef.current(data))
  }, [channel, subscribe])
}
