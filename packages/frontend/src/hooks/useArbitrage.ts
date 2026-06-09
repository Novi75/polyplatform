import { useQuery } from '@tanstack/react-query'
import { fetcher, api } from '../lib/api.ts'
import { useStore } from '../store/useStore.ts'

export function useArbOpportunities() {
  return useQuery({
    queryKey: ['arb-opportunities'],
    queryFn: () => fetcher('/arbitrage/opportunities'),
    refetchInterval: 10_000,
  })
}

export function useArbPairs() {
  return useQuery({
    queryKey: ['arb-pairs'],
    queryFn: () => fetcher('/arbitrage/pairs'),
    staleTime: 60_000,
  })
}

export function useArbHistory() {
  return useQuery({
    queryKey: ['arb-history'],
    queryFn: () => fetcher('/arbitrage/history'),
    staleTime: 30_000,
  })
}

export function useEngineStatus() {
  const storeStatus = useStore((s) => s.engineStatus)
  const query = useQuery({
    queryKey: ['engine-status'],
    queryFn: () => fetcher('/arbitrage/engine/status'),
    refetchInterval: 5_000,
  })
  return { ...query, data: storeStatus.running !== undefined ? storeStatus : query.data }
}

export async function startEngine() {
  return api.post('/arbitrage/engine/start')
}

export async function stopEngine() {
  return api.post('/arbitrage/engine/stop')
}

export async function executeOpportunity(id: string) {
  return api.post(`/arbitrage/execute/${id}`)
}
