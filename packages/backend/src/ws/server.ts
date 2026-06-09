import { WebSocket } from 'ws'

type WsMessage = Record<string, unknown>

class WsHub {
  private channels = new Map<string, Set<WebSocket>>()
  private clientChannels = new Map<WebSocket, Set<string>>()
  private subscribeHandlers: Array<(channel: string) => void> = []

  onSubscribe(handler: (channel: string) => void): void {
    this.subscribeHandlers.push(handler)
  }

  register(ws: WebSocket): void {
    this.clientChannels.set(ws, new Set())

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMessage
        this.handleClientMessage(ws, msg)
      } catch {
        this.send(ws, { type: 'error', message: 'Invalid JSON' })
      }
    })

    ws.on('close', () => this.unregisterAll(ws))
    ws.on('error', () => this.unregisterAll(ws))
  }

  private handleClientMessage(ws: WebSocket, msg: WsMessage): void {
    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong' })
      return
    }

    if (msg.type === 'subscribe' && Array.isArray(msg.channels)) {
      for (const ch of msg.channels as string[]) {
        this.subscribe(ws, ch)
        for (const h of this.subscribeHandlers) h(ch)
      }
      this.send(ws, { type: 'subscribed', channels: msg.channels })
      return
    }

    if (msg.type === 'unsubscribe' && Array.isArray(msg.channels)) {
      for (const ch of msg.channels as string[]) {
        this.unsubscribe(ws, ch)
      }
      return
    }
  }

  subscribe(ws: WebSocket, channel: string): void {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set())
    this.channels.get(channel)!.add(ws)
    this.clientChannels.get(ws)?.add(channel)
  }

  unsubscribe(ws: WebSocket, channel: string): void {
    this.channels.get(channel)?.delete(ws)
    this.clientChannels.get(ws)?.delete(channel)
  }

  private unregisterAll(ws: WebSocket): void {
    const subs = this.clientChannels.get(ws)
    if (subs) {
      for (const ch of subs) {
        this.channels.get(ch)?.delete(ws)
      }
    }
    this.clientChannels.delete(ws)
  }

  broadcast(channel: string, payload: WsMessage): void {
    const subs = this.channels.get(channel)
    if (!subs || subs.size === 0) return
    const msg = JSON.stringify(payload)
    for (const ws of subs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg)
      } else {
        this.unregisterAll(ws)
      }
    }
  }

  broadcastAll(payload: WsMessage): void {
    const msg = JSON.stringify(payload)
    for (const ws of this.clientChannels.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg)
    }
  }

  private send(ws: WebSocket, payload: WsMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  get clientCount(): number {
    return this.clientChannels.size
  }
}

export const wsHub = new WsHub()
