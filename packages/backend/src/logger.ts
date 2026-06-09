import { wsHub } from './ws/server.js'

export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

const MAX_BUFFER = 200

const buffer: Array<{ ts: number; level: LogLevel; tag: string; msg: string; data?: unknown }> = []

export function log(level: LogLevel, tag: string, msg: string, data?: unknown): void {
  const entry = { ts: Date.now(), level, tag, msg, data }
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) buffer.shift()

  // Console output
  const prefix = `[${tag}]`
  if (level === 'error') console.error(prefix, msg, data ?? '')
  else if (level === 'warn') console.warn(prefix, msg, data ?? '')
  else console.log(prefix, msg, data ?? '')

  // Broadcast to frontend log viewers
  wsHub.broadcast('system.logs', { type: 'system.log', ...entry })
}

export function getLogs() {
  return buffer
}
