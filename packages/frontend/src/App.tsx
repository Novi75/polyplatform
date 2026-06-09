import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { useWebSocket } from './hooks/useWebSocket.ts'

const Dashboard = lazy(() => import('./pages/Dashboard.tsx'))
const Settings  = lazy(() => import('./pages/Settings.tsx'))

function AppInner() {
  useWebSocket()
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">Loading…</div>}>
      <Routes>
        <Route path="/"         element={<Dashboard />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*"         element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppInner />
    </BrowserRouter>
  )
}
