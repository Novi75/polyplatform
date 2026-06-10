import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useWebSocket } from './hooks/useWebSocket.ts'
import { api } from './lib/api.ts'

const Dashboard = lazy(() => import('./pages/Dashboard.tsx'))
const Settings  = lazy(() => import('./pages/Settings.tsx'))
const Login     = lazy(() => import('./pages/Login.tsx'))

const Loading = () => (
  <div className="min-h-screen bg-gray-950 flex items-center justify-center text-gray-400">Loading…</div>
)

function AuthedApp() {
  useWebSocket()
  return <Outlet />
}

function ProtectedLayout() {
  const [status, setStatus] = useState<'loading' | 'authed' | 'anon'>('loading')

  useEffect(() => {
    api.get('/auth/me')
      .then((r) => setStatus(r.data.authenticated ? 'authed' : 'anon'))
      .catch(() => setStatus('anon'))
  }, [])

  if (status === 'loading') return <Loading />
  if (status === 'anon') return <Navigate to="/login" replace />
  return <AuthedApp />
}

function AppInner() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<ProtectedLayout />}>
          <Route path="/"         element={<Dashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*"         element={<Navigate to="/" replace />} />
        </Route>
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
