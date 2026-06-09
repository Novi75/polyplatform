import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetcher } from '../lib/api.ts'
import { useChannel } from '../hooks/useWebSocket.ts'
import { useWebSocket } from '../hooks/useWebSocket.ts'
import { Trash2, PauseCircle, PlayCircle } from 'lucide-react'

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

interface LogEntry {
  ts: number
  level: LogLevel
  tag: string
  msg: string
  data?: unknown
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  info:  'hsl(210,40%,75%)',
  warn:  'hsl(38,90%,60%)',
  error: 'hsl(0,84%,65%)',
  debug: 'hsl(215,20%,45%)',
}

const LEVEL_BG: Record<LogLevel, string> = {
  info:  'transparent',
  warn:  'hsl(38,80%,10%)',
  error: 'hsl(0,84%,8%)',
  debug: 'transparent',
}

function LogRow({ entry }: { entry: LogEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false })
  return (
    <div
      className="flex gap-3 px-3 py-1 text-xs font-mono border-b"
      style={{ background: LEVEL_BG[entry.level], borderColor: 'hsl(217,32%,12%)' }}
    >
      <span className="shrink-0 tabular-nums" style={{ color: 'hsl(215,20%,40%)' }}>{time}</span>
      <span
        className="shrink-0 w-12 text-center rounded-sm px-1"
        style={{
          color: LEVEL_COLOR[entry.level],
          background: `${LEVEL_COLOR[entry.level]}18`,
          fontSize: '10px',
          lineHeight: '18px',
        }}
      >
        {entry.level.toUpperCase()}
      </span>
      <span className="shrink-0 w-20 truncate" style={{ color: 'hsl(142,50%,55%)' }}>{entry.tag}</span>
      <span className="flex-1 break-all" style={{ color: 'hsl(210,40%,85%)' }}>{entry.msg}</span>
      {entry.data != null && (
        <span className="shrink-0 truncate max-w-xs" style={{ color: 'hsl(215,20%,45%)' }}>
          {JSON.stringify(entry.data)}
        </span>
      )}
    </div>
  )
}

export default function Logs() {
  useWebSocket()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all')
  const bottomRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)
  pausedRef.current = paused

  // Load historical logs on mount
  const { data } = useQuery<{ logs: LogEntry[] }>({
    queryKey: ['logs'],
    queryFn: () => fetcher('/logs'),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (data?.logs) setEntries(data.logs)
  }, [data])

  // Live log stream via WS
  useChannel('system.logs', (msg) => {
    if (pausedRef.current) return
    const entry = msg as LogEntry
    if (entry.ts) {
      setEntries((prev) => [...prev.slice(-499), entry])
    }
  })

  // Auto-scroll to bottom unless paused
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries, paused])

  const visible = entries.filter((e) => {
    if (levelFilter !== 'all' && e.level !== levelFilter) return false
    if (filter && !`${e.tag} ${e.msg}`.toLowerCase().includes(filter.toLowerCase())) return false
    return true
  })

  const levels: Array<LogLevel | 'all'> = ['all', 'info', 'warn', 'error', 'debug']

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter logs…"
          className="flex-1 min-w-[160px] text-xs px-3 py-1.5 rounded-lg border outline-none font-mono"
          style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,20%)', color: 'hsl(210,40%,90%)' }}
        />

        <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'hsl(222,47%,10%)' }}>
          {levels.map((l) => (
            <button
              key={l}
              onClick={() => setLevelFilter(l)}
              className="px-2.5 py-1 rounded text-xs font-medium"
              style={
                levelFilter === l
                  ? { background: 'hsl(217,32%,25%)', color: l === 'all' ? 'hsl(210,40%,90%)' : LEVEL_COLOR[l as LogLevel] }
                  : { color: 'hsl(215,20%,50%)' }
              }
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>

        <button
          onClick={() => setPaused((p) => !p)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border"
          style={{ borderColor: 'hsl(217,32%,20%)', color: paused ? 'hsl(38,90%,60%)' : 'hsl(215,20%,60%)', background: 'hsl(222,47%,8%)' }}
        >
          {paused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
          {paused ? 'Resume' : 'Pause'}
        </button>

        <button
          onClick={() => setEntries([])}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border"
          style={{ borderColor: 'hsl(217,32%,20%)', color: 'hsl(215,20%,55%)', background: 'hsl(222,47%,8%)' }}
        >
          <Trash2 size={13} /> Clear
        </button>

        <span className="text-xs" style={{ color: 'hsl(215,20%,40%)' }}>
          {visible.length} / {entries.length}
        </span>
      </div>

      {/* Log list */}
      <div
        className="flex-1 overflow-y-auto rounded-xl border"
        style={{ background: 'hsl(222,47%,6%)', borderColor: 'hsl(217,32%,15%)' }}
      >
        {visible.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs" style={{ color: 'hsl(215,20%,40%)' }}>
            No log entries yet — events will appear here in real-time
          </div>
        ) : (
          visible.map((e, i) => <LogRow key={i} entry={e} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
