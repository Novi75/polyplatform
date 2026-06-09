import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetcher, api } from '../lib/api.ts'
import { Shield, Key, Wallet, CheckCircle, AlertTriangle, Zap, RefreshCw, Activity, HardDrive, type LucideIcon } from 'lucide-react'

interface SettingsData {
  polymarket: { apiKey: string; secret: string; passphrase: string } | null
  limitless: { mode: 'legacy'; apiKey: string; walletAddress?: string } | { mode: 'hmac'; tokenId: string; secret: string; walletAddress?: string; privateKey?: string } | null
  arb: { minProfitPct: number; autoExecute: boolean; maxPositionSize: number; maxOpenTrades: number }
  hasPolyWallet: boolean
  polyAddress: string | null
  polyProxyAddress: string | null
}

interface ExchangeStatus {
  walletStored: boolean
  configured: boolean
  address: string | null
  usdcBalance: string | null
  positionCount: number
  openOrderCount: number
  feeRateBps: number | null
  profileId: number | null
  error: string | null
}

interface DashboardStatus {
  polymarket: ExchangeStatus | null
  limitless: ExchangeStatus | null
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

const labelStyle = {
  fontSize: '12px',
  color: 'hsl(215,20%,60%)',
  marginBottom: '6px',
  display: 'block',
}

function SectionCard({ icon: Icon, title, badge, children }: { icon: LucideIcon; title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-5 space-y-4" style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}>
      <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: 'hsl(217,32%,15%)' }}>
        <div className="flex items-center gap-2.5">
          <Icon size={16} style={{ color: 'hsl(142,70%,45%)' }} />
          <h2 className="text-sm font-semibold" style={{ color: 'hsl(210,40%,95%)' }}>{title}</h2>
        </div>
        {badge}
      </div>
      {children}
    </div>
  )
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full" style={{ background: ok ? 'hsl(142,70%,12%)' : 'hsl(217,32%,17%)', color: ok ? 'hsl(142,70%,55%)' : 'hsl(215,20%,50%)' }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: ok ? 'hsl(142,70%,50%)' : 'hsl(215,20%,40%)' }} />
      {label}
    </span>
  )
}

function RestartButton() {
  const qc = useQueryClient()
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')

  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const restart = async () => {
    setState('busy')
    setErrorMsg(null)
    try {
      await api.post('/admin/restart')
      setState('done')
      setTimeout(() => setState('idle'), 2_000)
      // Invalidate health + dashboard so the Redis banner and status clear immediately
      qc.invalidateQueries({ queryKey: ['health'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      qc.invalidateQueries({ queryKey: ['settings'] })
    } catch (err) {
      setErrorMsg((err as Error).message)
      setState('idle')
    }
  }

  const label = state === 'busy' ? 'Restarting…' : state === 'done' ? 'Done!' : 'Restart Services'

  const color = state === 'done'
    ? { background: 'hsl(142,70%,15%)', color: 'hsl(142,70%,55%)' }
    : state === 'busy'
    ? { background: 'hsl(217,32%,17%)', color: 'hsl(215,20%,50%)' }
    : { background: 'hsl(0,84%,18%)', color: 'hsl(0,84%,65%)' }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={restart}
        disabled={state !== 'idle'}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-70"
        style={color}
      >
        <RefreshCw size={11} className={state === 'busy' ? 'animate-spin' : ''} />
        {label}
      </button>
      {errorMsg && (
        <span className="text-xs max-w-xs truncate" style={{ color: 'hsl(0,84%,60%)' }} title={errorMsg}>
          {errorMsg}
        </span>
      )}
    </div>
  )
}

export default function Settings() {
  const qc = useQueryClient()
  const { data, refetch } = useQuery<SettingsData>({ queryKey: ['settings'], queryFn: () => fetcher('/settings'), staleTime: 30_000 })
  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useQuery<DashboardStatus>({
    queryKey: ['dashboard'],
    queryFn: () => fetcher('/dashboard'),
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

  // Polymarket manual form
  const [polyKey, setPolyKey] = useState('')
  const [polySecret, setPolySecret] = useState('')
  const [polyPassphrase, setPolyPassphrase] = useState('')
  const [polyNonce, setPolyNonce] = useState('0')
  const [polyTab, setPolyTab] = useState<'auto' | 'manual'>('auto')

  // Limitless — two auth modes
  const [limTab, setLimTab] = useState<'legacy' | 'hmac'>('legacy')
  const [limKey, setLimKey] = useState('')          // legacy mode
  const [limTokenId, setLimTokenId] = useState('')  // hmac mode
  const [limSecret, setLimSecret] = useState('')    // hmac mode
  const [limPrivKey, setLimPrivKey] = useState('')  // hmac mode — EOA private key for order signing
  const [limWalletAddress, setLimWalletAddress] = useState('') // wallet address for profile

  // Wallets
  const [polyPrivKey, setPolyPrivKey] = useState('')
  const [polyProxyAddress, setPolyProxyAddress] = useState('')

const [saving, setSaving] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [allowanceData, setAllowanceData] = useState<{ allowance: string; required: string } | null>(null)

  useEffect(() => {
    if (data?.limitless?.walletAddress) {
      setLimWalletAddress(data.limitless.walletAddress)
    }
    if (data?.polyProxyAddress) {
      setPolyProxyAddress(data.polyProxyAddress)
    }
  }, [data])

  const setMsg = (key: string, ok: boolean, text: string) => {
    setMessages((m) => ({ ...m, [key]: { ok, text } }))
    setTimeout(() => setMessages((m) => { const n = { ...m }; delete n[key]; return n }), 5_000)
  }

  const save = async (key: string, fn: () => Promise<unknown>) => {
    setSaving(key)
    try {
      const result = await fn()
      const msg = (result as Record<string, string>)?.apiKey
        ? `API key derived: ${(result as Record<string, string>).apiKey} (address: ${(result as Record<string, string>).address})`
        : 'Saved successfully'
      setMsg(key, true, msg)
      qc.invalidateQueries({ queryKey: ['settings'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      refetch()
      refetchStatus()
    } catch (err) {
      setMsg(key, false, (err as Error).message)
    } finally {
      setSaving(null)
    }
  }

  const checkAllowance = async () => {
    try {
      const r = await api.get('/limitless/allowance')
      setAllowanceData(r.data as { allowance: string; required: string })
    } catch (err) {
      setMsg('allowance', false, (err as Error).message)
    }
  }

  const Msg = ({ k }: { k: string }) =>
    messages[k] ? (
      <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg" style={{ background: messages[k].ok ? 'hsl(142,70%,10%)' : 'hsl(0,84%,10%)', color: messages[k].ok ? 'hsl(142,70%,55%)' : 'hsl(0,84%,65%)' }}>
        {messages[k].ok ? <CheckCircle size={12} /> : <AlertTriangle size={12} />}
        <span className="break-all">{messages[k].text}</span>
      </div>
    ) : null

  const Btn = ({ k, label, icon: Icon, variant = 'primary', type = 'submit', onClick }: { k: string; label: string; icon?: LucideIcon; variant?: 'primary' | 'danger' | 'secondary'; type?: 'submit' | 'button'; onClick?: () => void }) => (
    <button
      disabled={saving === k}
      type={type}
      onClick={onClick}
      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-opacity"
      style={
        variant === 'primary' ? { background: 'hsl(142,70%,40%)', color: 'hsl(222,47%,5%)' }
        : variant === 'danger' ? { background: 'hsl(0,84%,20%)', color: 'hsl(0,84%,65%)' }
        : { background: 'hsl(217,32%,20%)', color: 'hsl(215,20%,70%)' }
      }
    >
      {saving === k ? <RefreshCw size={13} className="animate-spin" /> : Icon ? <Icon size={13} /> : null}
      {saving === k ? 'Working...' : label}
    </button>
  )

  const tabBtn = (active: boolean) => ({
    padding: '5px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: active ? '600' : '400',
    background: active ? 'hsl(217,32%,22%)' : 'transparent',
    color: active ? 'hsl(210,40%,95%)' : 'hsl(215,20%,55%)',
    border: 'none', cursor: 'pointer',
  })

  const hasWallet = data?.hasPolyWallet
  const hasCreds = !!data?.polymarket

  const ExchangeStatusRow = ({
    name, logo, chain, panel, balanceLabel = 'Portfolio Value',
  }: {
    name: string; logo: string; chain: string; panel: ExchangeStatus | null | undefined; balanceLabel?: string
  }) => {
    const dimmed = { color: 'hsl(215,20%,50%)' }
    const mono = { color: 'hsl(210,40%,80%)', fontFamily: 'monospace' }

    // Derive badge state from the two independent flags
    const state: 'loading' | 'error' | 'connected' | 'wallet-only' | 'api-only' | 'none' =
      statusLoading && !panel ? 'loading'
      : panel?.error ? 'error'
      : panel?.configured ? 'connected'
      : panel?.walletStored ? 'wallet-only'
      : panel?.address ? 'api-only'   // API key but no wallet (edge case)
      : 'none'

    const badge = {
      loading:     { bg: 'hsl(217,32%,17%)', fg: 'hsl(215,20%,55%)', dot: 'hsl(215,20%,40%)', pulse: false, label: 'Loading…' },
      error:       { bg: 'hsl(0,84%,12%)',   fg: 'hsl(0,84%,60%)',   dot: 'hsl(0,84%,55%)',   pulse: false, label: 'API error' },
      connected:   { bg: 'hsl(142,70%,12%)', fg: 'hsl(142,70%,55%)', dot: 'hsl(142,70%,50%)', pulse: true,  label: 'Connected' },
      'wallet-only': { bg: 'hsl(38,80%,12%)', fg: 'hsl(38,80%,60%)', dot: 'hsl(38,80%,55%)', pulse: false, label: 'Wallet stored — add API key' },
      'api-only':  { bg: 'hsl(217,70%,15%)', fg: 'hsl(217,70%,60%)', dot: 'hsl(217,70%,55%)', pulse: false, label: 'API key set' },
      none:        { bg: 'hsl(217,32%,17%)', fg: 'hsl(215,20%,50%)', dot: 'hsl(215,20%,35%)', pulse: false, label: 'Not configured' },
    }[state]

    return (
      <div
        className="rounded-xl border p-4 space-y-3"
        style={{ background: 'hsl(222,47%,10%)', borderColor: 'hsl(217,32%,17%)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold" style={{ color: 'hsl(210,40%,95%)' }}>{logo} {name}</span>
            <span className="text-xs" style={{ color: 'hsl(215,20%,45%)' }}>{chain}</span>
          </div>
          <span
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
            style={{ background: badge.bg, color: badge.fg }}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${badge.pulse ? 'animate-pulse' : ''}`}
              style={{ background: badge.dot }}
            />
            {badge.label}
          </span>
        </div>

        {/* Guidance for wallet-only state */}
        {state === 'wallet-only' && (
          <div className="flex items-start gap-2 text-xs px-3 py-2 rounded-lg" style={{ background: 'hsl(38,80%,10%)', color: 'hsl(38,80%,65%)' }}>
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>
              Private key detected — address shown below. Complete Step 2 to derive your API credentials and activate trading.
            </span>
          </div>
        )}

        {/* API error */}
        {panel?.error && (
          <p className="text-xs px-3 py-2 rounded-lg" style={{ background: 'hsl(0,84%,10%)', color: 'hsl(0,84%,65%)' }}>
            {panel.error}
          </p>
        )}

        {panel && (
          <div className="space-y-2">
            {/* Wallet address */}
            {panel.address && (
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-xs shrink-0" style={dimmed}>Address</span>
                <span className="text-xs font-mono truncate" style={{ color: 'hsl(142,70%,50%)' }}>
                  {panel.address}
                </span>
              </div>
            )}

            {/* Stats — only meaningful when API credentials are present */}
            {panel.configured && (
              <div className="space-y-2 pt-1">
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: balanceLabel, value: panel.usdcBalance != null ? `$${panel.usdcBalance}` : '—' },
                    { label: 'Taker Fee', value: panel.feeRateBps != null ? `${(panel.feeRateBps / 100).toFixed(2)}%` : '—' },
                    { label: 'Open Positions', value: String(panel.positionCount) },
                    { label: 'Open Orders', value: String(panel.openOrderCount) },
                  ].map(({ label, value }) => (
                    <div key={label} className="rounded-lg p-2 text-center" style={{ background: 'hsl(222,47%,13%)' }}>
                      <p className="text-xs mb-0.5" style={dimmed}>{label}</p>
                      <p className="text-sm font-semibold font-mono" style={{ color: 'hsl(210,40%,90%)' }}>{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Profile ID (Limitless) */}
            {panel.profileId != null && (
              <p className="text-xs" style={dimmed}>
                Profile ID: <span style={mono}>{panel.profileId}</span>
              </p>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">

      {/* ── Data store status ── */}
      <div
        className="rounded-xl border p-4 flex items-start gap-3"
        style={{ background: 'hsl(142,40%,8%)', borderColor: 'hsl(142,40%,18%)' }}
      >
        <HardDrive size={16} className="shrink-0 mt-0.5" style={{ color: 'hsl(142,70%,50%)' }} />
        <div className="space-y-1.5 text-sm">
          <p className="font-semibold" style={{ color: 'hsl(142,70%,60%)' }}>Credentials stored on disk</p>
          <p className="text-xs" style={{ color: 'hsl(142,30%,55%)' }}>
            API keys and settings are persisted to <code style={{ color: 'hsl(142,60%,70%)' }}>data/store.json</code>.
            They survive backend restarts — no Redis required.
          </p>
          <p className="text-xs" style={{ color: 'hsl(215,20%,50%)' }}>
            Markets and matched pairs are cached in <code style={{ color: 'hsl(215,20%,60%)' }}>data/markets-*.json</code>.
          </p>
        </div>
      </div>

      {/* ── Connection Status ── */}
      <div
        className="rounded-xl border p-5 space-y-4"
        style={{ background: 'hsl(222,47%,8%)', borderColor: 'hsl(217,32%,17%)' }}
      >
        <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: 'hsl(217,32%,15%)' }}>
          <div className="flex items-center gap-2.5">
            <Activity size={16} style={{ color: 'hsl(142,70%,45%)' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'hsl(210,40%,95%)' }}>Connection Status</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { refetchStatus() }}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg"
              style={{ background: 'hsl(217,32%,17%)', color: 'hsl(215,20%,60%)' }}
            >
              <RefreshCw size={11} /> Refresh
            </button>
            <RestartButton />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3">
          <ExchangeStatusRow
            name="Polymarket"
            logo="🔷"
            chain="Polygon · chainId 137"
            panel={status?.polymarket}
          />
          <ExchangeStatusRow
            name="Limitless Exchange"
            logo="♾️"
            chain="Base L2 · chainId 8453"
            panel={status?.limitless}
            balanceLabel="Wallet Balance"
          />
        </div>
      </div>

      {/* ════════════════════════════════════════════
          🔷  POLYMARKET
          ════════════════════════════════════════════ */}
      <SectionCard
        icon={Wallet}
        title="🔷 Polymarket"
        badge={<StatusBadge ok={!!hasWallet && hasCreds} label={!!hasWallet && hasCreds ? 'Ready' : !hasWallet ? 'No wallet' : 'No API key'} />}
      >
        {/* Encryption notice */}
        <div className="flex items-start gap-2 text-xs px-3 py-2.5 rounded-lg" style={{ background: 'hsl(30,80%,10%)', color: 'hsl(30,80%,65%)' }}>
          <Shield size={13} className="shrink-0 mt-0.5" />
          <span>Keys are encrypted with AES-256-CBC before storage and never sent to any external service.</span>
        </div>

        {/* ── Wallet private key + proxy ── */}
        <div className="space-y-1">
          <p className="text-xs font-semibold" style={{ color: 'hsl(215,20%,65%)' }}>Wallet</p>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); save('wallets', () => api.put('/settings/wallets', { polymarketPrivKey: polyPrivKey || undefined, polyProxyAddress: polyProxyAddress || undefined }).then(r => r.data)) }}
          className="space-y-3"
        >
          <div>
            <label style={labelStyle}>Private Key <span style={{ color: 'hsl(215,20%,40%)' }}>(Polygon / chainId 137)</span></label>
            <input style={inputStyle} type="password" value={polyPrivKey} onChange={(e) => setPolyPrivKey(e.target.value)} placeholder="0x..." autoComplete="off" />
          </div>
          <div>
            <label style={labelStyle}>Deposit Wallet Address <span style={{ color: 'hsl(215,20%,40%)' }}>(required for CLOB orders)</span></label>
            <input style={inputStyle} type="text" value={polyProxyAddress} onChange={(e) => setPolyProxyAddress(e.target.value)} placeholder="0x... (use Auto-discover to compute)" autoComplete="off" />
            <p className="text-xs mt-1" style={{ color: 'hsl(215,20%,45%)' }}>
              Polymarket CLOB requires orders from a registered deposit wallet, not your EOA directly. After discovering, fund this wallet with USDC.e on Polygon.
            </p>
            <button
              type="button"
              className="mt-2 text-xs px-3 py-1.5 rounded-lg font-medium"
              style={{ background: 'hsl(217,32%,17%)', color: 'hsl(142,70%,55%)', border: '1px solid hsl(142,70%,25%)' }}
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onClick={async () => {
                try {
                  const r = await api.post('/debug/poly-discover-proxy')
                  const d = r.data as { proxyAddress?: string; autoSaved?: boolean; deployed?: boolean }
                  if (d.proxyAddress) {
                    setPolyProxyAddress(d.proxyAddress)
                    alert(`Deposit wallet ${d.deployed ? '(deployed ✓)' : '(not yet deployed)'} auto-saved: ${d.proxyAddress}\n\nFund this address with USDC.e on Polygon to enable trading.`)
                  } else {
                    alert('Could not compute deposit wallet address.')
                  }
                } catch (err: unknown) {
                  const msg = (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? String(err)
                  alert(`Failed: ${msg}`)
                }
              }}
            >
              Auto-discover deposit wallet
            </button>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Btn k="wallets" label="Save Keys" />
            {hasWallet && (
              <Btn
                k="wallets-del"
                label="Clear Keys"
                variant="danger"
                type="button"
                // eslint-disable-next-line @typescript-eslint/no-misused-promises
                onClick={() => save('wallets-del', () => api.delete('/settings/wallets').then(r => r.data))}
              />
            )}
            <Msg k="wallets" />
            <Msg k="wallets-del" />
          </div>
        </form>

        {data?.polyAddress && (
          <p className="text-xs" style={{ color: 'hsl(215,20%,50%)' }}>
            Signer address: <span className="font-mono" style={{ color: 'hsl(142,70%,50%)' }}>{data.polyAddress}</span>
          </p>
        )}

        {/* ── API Credentials ── */}
        <div className="pt-4 border-t space-y-3" style={{ borderColor: 'hsl(217,32%,15%)' }}>
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold" style={{ color: 'hsl(215,20%,65%)' }}>API Credentials</p>
            <StatusBadge ok={hasCreds} label={hasCreds ? `Key: ${data!.polymarket!.apiKey}` : 'Not configured'} />
          </div>

          <div className="flex gap-1 p-1 rounded-lg w-fit" style={{ background: 'hsl(222,47%,12%)' }}>
            <button style={tabBtn(polyTab === 'auto')} onClick={() => setPolyTab('auto')}>Auto-derive from wallet</button>
            <button style={tabBtn(polyTab === 'manual')} onClick={() => setPolyTab('manual')}>Manual entry</button>
          </div>

          {polyTab === 'auto' ? (
            <div className="space-y-4">
              <div className="rounded-lg p-4 space-y-2 text-sm" style={{ background: 'hsl(222,47%,11%)', border: '1px solid hsl(217,32%,20%)' }}>
                <p className="font-medium" style={{ color: 'hsl(210,40%,90%)' }}>How it works</p>
                <ol className="space-y-1.5 text-xs list-decimal list-inside" style={{ color: 'hsl(215,20%,60%)' }}>
                  <li>Fetches the CLOB server timestamp from <code style={{ color: 'hsl(142,70%,50%)' }}>GET /time</code></li>
                  <li>Signs an EIP-712 typed message with your stored private key (ClobAuthDomain, chainId 137)</li>
                  <li>Calls <code style={{ color: 'hsl(142,70%,50%)' }}>GET /auth/derive-api-key</code> — returns the same key for the same nonce every time</li>
                  <li>Saves the returned <code style={{ color: 'hsl(142,70%,50%)' }}>apiKey / secret / passphrase</code> encrypted in storage</li>
                </ol>
              </div>

              <div className="flex items-end gap-3">
                <div className="w-32">
                  <label style={labelStyle}>
                    Nonce{' '}
                    <span style={{ color: 'hsl(215,20%,40%)' }}>
                      (same nonce → same key)
                    </span>
                  </label>
                  <input
                    style={inputStyle}
                    type="number"
                    min="0"
                    value={polyNonce}
                    onChange={(e) => setPolyNonce(e.target.value)}
                  />
                </div>

                <div className="flex gap-2 flex-wrap">
                  <Btn
                    k="derive-key"
                    label="Derive Existing Key"
                    icon={RefreshCw}
                    type="button"
                    // eslint-disable-next-line @typescript-eslint/no-misused-promises
                    onClick={() => {
                      if (!hasWallet) { setMsg('derive-key', false, 'Store your private key first.'); return }
                      save('derive-key', () => api.post('/settings/derive-api-key', { nonce: Number(polyNonce) }).then(r => r.data))
                    }}
                  />
                  <Btn
                    k="create-key"
                    label="Create New Key"
                    icon={Zap}
                    variant="secondary"
                    type="button"
                    // eslint-disable-next-line @typescript-eslint/no-misused-promises
                    onClick={() => {
                      if (!hasWallet) { setMsg('create-key', false, 'Store your private key first.'); return }
                      save('create-key', () => api.post('/settings/create-api-key', { nonce: Number(polyNonce) }).then(r => r.data))
                    }}
                  />
                </div>
              </div>

              {!hasWallet && (
                <p className="text-xs flex items-center gap-1.5" style={{ color: 'hsl(30,80%,60%)' }}>
                  <AlertTriangle size={12} /> Add your private key above to enable auto-derivation.
                </p>
              )}

              <Msg k="derive-key" />
              <Msg k="create-key" />

              <p className="text-xs" style={{ color: 'hsl(215,20%,40%)' }}>
                Use <strong>Derive Existing Key</strong> to recover the same key (deterministic). Use <strong>Create New Key</strong> to generate fresh credentials (rotates the key).
                If you get a <code>NONCE_ALREADY_USED</code> error, increment the nonce by 1.
              </p>
            </div>
          ) : (
            <form
              onSubmit={(e) => { e.preventDefault(); save('poly-api', () => api.put('/settings/polymarket', { apiKey: polyKey, secret: polySecret, passphrase: polyPassphrase }).then(r => r.data)) }}
              className="space-y-3"
            >
              <p className="text-xs" style={{ color: 'hsl(215,20%,50%)' }}>
                Paste credentials generated at <span style={{ color: 'hsl(142,70%,50%)' }}>clob.polymarket.com</span> or via the py-clob-client SDK.
              </p>
              <div>
                <label style={labelStyle}>API Key</label>
                <input style={inputStyle} value={polyKey} onChange={(e) => setPolyKey(e.target.value)} placeholder="UUID (e.g. 550e8400-e29b-41d4-...)" required />
              </div>
              <div>
                <label style={labelStyle}>Secret</label>
                <input style={inputStyle} type="password" value={polySecret} onChange={(e) => setPolySecret(e.target.value)} placeholder="Base64-encoded secret" required autoComplete="off" />
              </div>
              <div>
                <label style={labelStyle}>Passphrase</label>
                <input style={inputStyle} type="password" value={polyPassphrase} onChange={(e) => setPolyPassphrase(e.target.value)} placeholder="Passphrase" required autoComplete="off" />
              </div>
              <div className="flex items-center gap-3">
                <Btn k="poly-api" label="Save Credentials" />
                <Msg k="poly-api" />
              </div>
            </form>
          )}
        </div>

        {/* ── One-time on-chain setup ── */}
        {hasWallet && (
          <div className="pt-4 border-t space-y-2" style={{ borderColor: 'hsl(217,32%,15%)' }}>
            <p className="text-xs font-semibold" style={{ color: 'hsl(215,20%,65%)' }}>One-time On-chain Setup <span style={{ color: 'hsl(215,20%,40%)' }}>(Polygon)</span></p>
            <p className="text-xs" style={{ color: 'hsl(215,20%,50%)' }}>
              New wallets must approve USDC and conditional token contracts before placing orders.
              Requires a small amount of MATIC for gas. Run once per wallet.
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <Btn
                k="setup-approvals"
                label="Setup Trading Approvals"
                icon={Zap}
                type="button"
                // eslint-disable-next-line @typescript-eslint/no-misused-promises
                onClick={() => save('setup-approvals', () => api.post('/settings/setup-approvals').then(r => r.data))}
              />
              <Msg k="setup-approvals" />
            </div>
            <p className="text-xs" style={{ color: 'hsl(215,20%,40%)' }}>
              This sends 2 transactions on Polygon — USDC allowance + CTF approval. After this your wallet can place CLOB orders.
            </p>
          </div>
        )}
      </SectionCard>

      {/* ════════════════════════════════════════════
          ♾️  LIMITLESS EXCHANGE
          ════════════════════════════════════════════ */}
      <SectionCard
        icon={Key}
        title="♾️ Limitless Exchange"
        badge={
          <StatusBadge
            ok={!!data?.limitless}
            label={
              !data?.limitless ? 'Not configured'
              : data.limitless.mode === 'hmac' ? `HMAC · ${data.limitless.tokenId}`
              : `Legacy · ${data.limitless.apiKey}`
            }
          />
        }
      >
        {/* Auth mode explainer */}
        <div className="rounded-lg p-3 text-xs space-y-1.5" style={{ background: 'hsl(222,47%,11%)', border: '1px solid hsl(217,32%,20%)' }}>
          <p className="font-medium" style={{ color: 'hsl(210,40%,90%)' }}>Authentication modes</p>
          <p style={{ color: 'hsl(215,20%,55%)' }}>
            <span style={{ color: 'hsl(142,70%,50%)' }}>HMAC (recommended)</span> — Three signed headers per request using a <code>tokenId</code> + <code>secret</code>.
            Obtain via <code>POST /auth/api-tokens/derive</code> after logging in at limitless.exchange. Supports scopes: <code>trading</code>, <code>withdrawal</code>.
          </p>
          <p style={{ color: 'hsl(215,20%,55%)' }}>
            <span style={{ color: 'hsl(215,20%,65%)' }}>Legacy (deprecated)</span> — Single <code>X-API-Key</code> header using an <code>lmts_…</code> key from the Limitless UI dashboard.
            Still accepted but no longer issued to new users.
          </p>
        </div>

        {/* ── API Credentials ── */}
        <div className="space-y-1">
          <p className="text-xs font-semibold" style={{ color: 'hsl(215,20%,65%)' }}>API Credentials</p>
        </div>

        <div className="flex gap-1 p-1 rounded-lg w-fit" style={{ background: 'hsl(222,47%,12%)' }}>
          <button style={tabBtn(limTab === 'hmac')} onClick={() => setLimTab('hmac')}>HMAC (recommended)</button>
          <button style={tabBtn(limTab === 'legacy')} onClick={() => setLimTab('legacy')}>Legacy key</button>
        </div>

        {limTab === 'hmac' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              save('lim-api', () =>
                api.put('/settings/limitless', { mode: 'hmac', tokenId: limTokenId, secret: limSecret, walletAddress: limWalletAddress || undefined, privateKey: limPrivKey || undefined }).then(r => r.data),
              )
            }}
            className="space-y-3"
          >
            <div className="rounded-lg p-3 text-xs space-y-1" style={{ background: 'hsl(222,47%,11%)', border: '1px solid hsl(217,32%,20%)' }}>
              <p className="font-medium" style={{ color: 'hsl(210,40%,88%)' }}>How to get HMAC credentials</p>
              <ol className="list-decimal list-inside space-y-1" style={{ color: 'hsl(215,20%,58%)' }}>
                <li>Log in at <span style={{ color: 'hsl(142,70%,50%)' }}>limitless.exchange</span> with an external EVM wallet (MetaMask / Phantom)</li>
                <li>Open Profile → API Keys → <strong>Generate new token</strong></li>
                <li>Select scopes: <code>trading</code> (required), <code>withdrawal</code> (optional) — <strong>no</strong> <code>delegated_signing</code> needed</li>
                <li>Copy the <code>tokenId</code> and <code>secret</code> — the secret is shown <strong>once only</strong></li>
                <li>Paste your wallet's <strong>private key</strong> below — used locally to sign orders via EIP-712</li>
              </ol>
            </div>
            <div>
              <label style={labelStyle}>Token ID</label>
              <input
                style={inputStyle}
                value={limTokenId}
                onChange={(e) => setLimTokenId(e.target.value)}
                placeholder="Token ID from limitless.exchange"
                required
                autoComplete="off"
              />
            </div>
            <div>
              <label style={labelStyle}>Secret <span style={{ color: 'hsl(215,20%,40%)' }}>(base64, shown once at creation)</span></label>
              <input
                style={inputStyle}
                type="password"
                value={limSecret}
                onChange={(e) => setLimSecret(e.target.value)}
                placeholder="Base64-encoded HMAC secret"
                required
                autoComplete="off"
              />
            </div>
            <div>
              <label style={labelStyle}>
                Wallet Address <span style={{ color: 'hsl(0,84%,60%)' }}>*required</span>
                <span style={{ color: 'hsl(215,20%,40%)' }}> — EIP-55 checksummed (0x + 40 hex chars)</span>
              </label>
              <input
                style={inputStyle}
                value={limWalletAddress}
                onChange={(e) => setLimWalletAddress(e.target.value)}
                placeholder="0x27b4afBD88fE7c88c6897BB0b4ADE338D0401E37"
                required
                autoComplete="off"
              />
              <p className="text-xs mt-1.5" style={{ color: 'hsl(215,20%,45%)' }}>
                The EVM wallet address connected to your Limitless account.
                Find it at <span style={{ color: 'hsl(142,70%,50%)' }}>limitless.exchange → Profile → Wallet</span>.
              </p>
            </div>
            <div>
              <label style={labelStyle}>
                Private Key <span style={{ color: 'hsl(0,84%,60%)' }}>*required for order placement</span>
                {data?.limitless?.mode === 'hmac' && data.limitless.privateKey && (
                  <span style={{ color: 'hsl(142,70%,50%)' }}> (stored — leave blank to keep)</span>
                )}
              </label>
              <input
                style={inputStyle}
                type="password"
                value={limPrivKey}
                onChange={(e) => setLimPrivKey(e.target.value)}
                placeholder={data?.limitless?.mode === 'hmac' && data.limitless.privateKey ? '(stored — leave blank to keep)' : '0x... (your Limitless wallet private key)'}
                autoComplete="off"
              />
              <p className="text-xs mt-1.5" style={{ color: 'hsl(215,20%,45%)' }}>
                Used locally to sign orders with EIP-712. Stored encrypted — never sent to any external service. Must belong to the wallet address above.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Btn k="lim-api" label="Save HMAC Credentials" />
              <Msg k="lim-api" />
            </div>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              save('lim-api', () =>
                api.put('/settings/limitless', { mode: 'legacy', apiKey: limKey, walletAddress: limWalletAddress || undefined }).then(r => r.data),
              )
            }}
            className="space-y-3"
          >
            <div className="flex items-start gap-2 text-xs px-3 py-2 rounded-lg" style={{ background: 'hsl(30,80%,10%)', color: 'hsl(30,80%,65%)' }}>
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>Legacy keys (<code>lmts_…</code>) are deprecated and no longer issued to new users. Use HMAC mode if possible.</span>
            </div>
            <div>
              <label style={labelStyle}>API Key <span style={{ color: 'hsl(215,20%,40%)' }}>(from Limitless UI dashboard)</span></label>
              <input
                style={inputStyle}
                value={limKey}
                onChange={(e) => setLimKey(e.target.value)}
                placeholder="lmts_…"
                required
                autoComplete="off"
              />
            </div>
            <div>
              <label style={labelStyle}>
                Wallet Address <span style={{ color: 'hsl(215,20%,40%)' }}>(your EVM address, used as <code>x-account</code> header)</span>
              </label>
              <input
                style={inputStyle}
                value={limWalletAddress}
                onChange={(e) => setLimWalletAddress(e.target.value)}
                placeholder="0x27b4afBD88fE7c88c6897BB0b4ADE338D0401E37"
                autoComplete="off"
              />
            </div>
            <p className="text-xs" style={{ color: 'hsl(215,20%,45%)' }}>
              One active key per account. Creating a new key in the UI automatically revokes the previous one.
            </p>
            <div className="flex items-center gap-3">
              <Btn k="lim-api" label="Save Legacy Key" />
              <Msg k="lim-api" />
            </div>
          </form>
        )}

        {/* ── On-chain approvals ── */}
        <div className="pt-4 border-t space-y-2" style={{ borderColor: 'hsl(217,32%,15%)' }}>
          <p className="text-xs font-semibold" style={{ color: 'hsl(215,20%,65%)' }}>One-time On-chain Setup <span style={{ color: 'hsl(215,20%,40%)' }}>(Base L2)</span></p>
          <p className="text-xs" style={{ color: 'hsl(215,20%,45%)' }}>
            Required once per wallet. Sends two transactions: USDC approval (for buying) and CTF setApprovalForAll (for selling/hedging). Requires a small amount of ETH for gas on Base.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <Btn k="allowance-check" label="Check USDC Allowance" variant="secondary" type="button" onClick={checkAllowance} />
            {allowanceData && (
              <span className="text-xs font-mono" style={{ color: parseFloat(allowanceData.allowance) > 0 ? 'hsl(142,70%,55%)' : 'hsl(0,84%,60%)' }}>
                USDC: {allowanceData.allowance} / Needed: {allowanceData.required}
              </span>
            )}
          </div>
          <Btn
            k="lim-approve"
            label="Approve USDC + CTF (run once)"
            icon={Zap}
            type="button"
            onClick={() => { save('lim-approve', () => api.post('/limitless/approve').then(r => r.data)) }}
          />
          <Msg k="allowance" />
          <Msg k="lim-approve" />
        </div>
      </SectionCard>

    </div>
  )
}
