import { useState } from 'react'
import { api } from '../lib/api.ts'

export default function Login() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.post('/auth/login', { password })
      window.location.href = '/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg0)', color: 'var(--txt)' }}>
      <div className="scanline" />
      <form onSubmit={submit} className="widget p-6 w-full" style={{ maxWidth: 340 }}>
        <div className="mb-5 text-center">
          <div className="text-lg font-bold tracking-widest neon-g">ARB BOT</div>
          <div className="wlabel mt-1">Authentication Required</div>
        </div>

        <label className="wlabel block mb-1.5" htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2 mb-3"
          style={{ fontSize: 13 }}
        />

        {error && (
          <div className="mb-3 text-xs" style={{ color: 'var(--nr)' }}>{error}</div>
        )}

        <button type="submit" disabled={busy} className="btn-ng w-full py-2 rounded text-xs font-bold tracking-wider" style={{ opacity: busy ? 0.6 : 1 }}>
          {busy ? 'CHECKING…' : 'LOG IN'}
        </button>
      </form>
    </div>
  )
}
