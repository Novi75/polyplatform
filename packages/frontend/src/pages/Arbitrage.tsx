import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetcher, api } from '../lib/api.ts'
import { useStore } from '../store/useStore.ts'
import { ArbOpportunityCard } from '../components/ArbOpportunityCard.tsx'
import { useWebSocket } from '../hooks/useWebSocket.ts'
import { startEngine, stopEngine, executeOpportunity } from '../hooks/useArbitrage.ts'
import { RefreshCw, Play, Square, Zap } from 'lucide-react'

interface MatchedPair {
  polymarket: { conditionId: string; question: string }
  limitless: { id: string; title: string }
  score: number
  dismissed: boolean
}

interface HistoryEntry {
  oppId: string
  direction: string
  suggestedSize: number
  estimatedProfitPct: number
  profit: number
  success: boolean
  executedAt: number
}

export default function Arbitrage() {
  useWebSocket()
  const qc = useQueryClient()
  const opportunities = useStore((s) => s.opportunities)
  const engineStatus = useStore((s) => s.engineStatus)
  const [executingId, setExecutingId] = useState<string | null>(null)
  const [tab, setTab] = useState<'live' | 'pairs' | 'history'>('live')

  const pairsQuery = useQuery({ queryKey: ['arb-pairs'], queryFn: () => fetcher('/arbitrage/pairs'), staleTime: 60_000 })
  const historyQuery = useQuery({ queryKey: ['arb-history'], queryFn: () => fetcher('/arbitrage/history'), staleTime: 30_000 })

  const pairs: MatchedPair[] = pairsQuery.data ?? []
  const history: HistoryEntry[] = historyQuery.data ?? []

  const handleExecute = async (id: string) => {
    setExecutingId(id)
    try {
      await executeOpportunity(id)
    } finally {
      setExecutingId(null)
    }
  }

  const dismissPair = async (conditionId: string) => {
    await api.post(`/arbitrage/pairs/${conditionId}/dismiss`)
    qc.invalidateQueries({ queryKey: ['arb-pairs'] })
  }

  const refreshPairs = async () => {
    await api.post('/arbitrage/pairs/refresh')
    qc.invalidateQueries({ queryKey: ['arb-pairs'] })
  }

  const tabStyle = (active: boolean) => ({
    padding: '6px 16px',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: active ? '600' : '400',
    background: active ? 'hsl(217,32%,20%)' : 'transparent',
    color: active ? 'hsl(210,40%,98%)' : 'hsl(215,20%,55%)',
    cursor: 'pointer',
    border: 'none',
  })

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div
        className="rounded-xl border p-4 flex items-center justify-between"
        style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-3 h-3 rounded-full ${engineStatus.running ? 'animate-pulse' : ''}`}
            style={{ background: engineStatus.running ? 'hsl(142,70%,45%)' : 'hsl(215,20%,35%)' }}
          />
          <div>
            <p className="text-sm font-medium" style={{ color: 'hsl(210,40%,98%)' }}>
              Engine {engineStatus.running ? 'Running' : 'Stopped'}
            </p>
            {engineStatus.lastError && (
              <p className="text-xs" style={{ color: 'hsl(0,84%,60%)' }}>{engineStatus.lastError}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshPairs}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs"
            style={{ background: 'hsl(217,32%,17%)', color: 'hsl(215,20%,70%)' }}
          >
            <RefreshCw size={12} /> Refresh Pairs
          </button>
          <button
            onClick={() => engineStatus.running ? stopEngine() : startEngine()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium"
            style={
              engineStatus.running
                ? { background: 'hsl(0,84%,20%)', color: 'hsl(0,84%,65%)' }
                : { background: 'hsl(142,70%,40%)', color: 'hsl(222,47%,5%)' }
            }
          >
            {engineStatus.running ? <><Square size={13} /> Stop</> : <><Play size={13} /> Start</>}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1">
        {(['live', 'pairs', 'history'] as const).map((t) => (
          <button key={t} style={tabStyle(tab === t)} onClick={() => setTab(t)}>
            {t === 'live' ? `Live (${opportunities.length})` : t === 'pairs' ? `Matched Pairs (${pairs.length})` : 'History'}
          </button>
        ))}
      </div>

      {/* Live opportunities */}
      {tab === 'live' && (
        <div>
          {opportunities.length === 0 ? (
            <div
              className="rounded-xl p-12 text-center border"
              style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)', color: 'hsl(215,20%,45%)' }}
            >
              <Zap size={32} className="mx-auto mb-3 opacity-20" />
              <p className="text-sm">{engineStatus.running ? 'Scanning for opportunities...' : 'Start the engine to scan for arbitrage'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {opportunities.map((opp) => (
                <ArbOpportunityCard key={opp.id} opp={opp} onExecute={handleExecute} executing={executingId === opp.id} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Matched pairs */}
      {tab === 'pairs' && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'hsl(217,32%,17%)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'hsl(222,47%,10%)' }}>
                {['Polymarket Question', 'Limitless Market', 'Confidence', 'Actions'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase" style={{ color: 'hsl(215,20%,55%)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pairs.map((p) => (
                <tr key={p.polymarket.conditionId} className="border-t" style={{ borderColor: 'hsl(217,32%,13%)' }}>
                  <td className="px-4 py-3 text-xs max-w-xs" style={{ color: p.dismissed ? 'hsl(215,20%,40%)' : 'hsl(210,40%,90%)' }}>
                    {p.polymarket.question.slice(0, 80)}...
                  </td>
                  <td className="px-4 py-3 text-xs max-w-xs" style={{ color: p.dismissed ? 'hsl(215,20%,40%)' : 'hsl(210,40%,90%)' }}>
                    {p.limitless.title.slice(0, 80)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'hsl(142,70%,12%)', color: 'hsl(142,70%,55%)' }}>
                      {((1 - p.score) * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {!p.dismissed && (
                      <button
                        onClick={() => dismissPair(p.polymarket.conditionId)}
                        className="text-xs px-2 py-1 rounded"
                        style={{ background: 'hsl(217,32%,17%)', color: 'hsl(215,20%,60%)' }}
                      >
                        Dismiss
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* History */}
      {tab === 'history' && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'hsl(217,32%,17%)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'hsl(222,47%,10%)' }}>
                {['Direction', 'Size', 'Est. Profit %', 'Realized P&L', 'Status', 'Time'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold uppercase" style={{ color: 'hsl(215,20%,55%)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-sm" style={{ color: 'hsl(215,20%,45%)' }}>No execution history</td></tr>
              ) : history.map((h, i) => (
                <tr key={i} className="border-t" style={{ borderColor: 'hsl(217,32%,13%)' }}>
                  <td className="px-4 py-2.5 text-xs font-mono" style={{ color: 'hsl(210,40%,80%)' }}>{h.direction}</td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'hsl(210,40%,80%)' }}>${h.suggestedSize?.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'hsl(142,70%,55%)' }}>+{h.estimatedProfitPct?.toFixed(2)}%</td>
                  <td className="px-4 py-2.5 text-xs font-mono" style={{ color: h.profit >= 0 ? 'hsl(142,70%,55%)' : 'hsl(0,84%,60%)' }}>
                    {h.profit >= 0 ? '+' : ''}{h.profit?.toFixed(3)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: h.success ? 'hsl(142,70%,12%)' : 'hsl(0,84%,12%)', color: h.success ? 'hsl(142,70%,55%)' : 'hsl(0,84%,60%)' }}>
                      {h.success ? 'Success' : 'Failed'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'hsl(215,20%,55%)' }}>
                    {new Date(h.executedAt).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
