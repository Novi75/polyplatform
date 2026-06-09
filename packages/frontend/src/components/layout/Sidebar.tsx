import { NavLink } from 'react-router-dom'
import { LayoutDashboard, BarChart2, ArrowLeftRight, TrendingUp, Settings, Zap, ScanLine, ScrollText } from 'lucide-react'
import { useStore } from '../../store/useStore.ts'

const nav = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/scanner', icon: ScanLine, label: 'Scanner' },
  { to: '/markets', icon: BarChart2, label: 'Markets' },
  { to: '/trade', icon: ArrowLeftRight, label: 'Trade' },
  { to: '/arbitrage', icon: Zap, label: 'Arbitrage' },
  { to: '/positions', icon: TrendingUp, label: 'Positions' },
  { to: '/logs', icon: ScrollText, label: 'Logs' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export function Sidebar() {
  const wsConnected = useStore((s) => s.wsConnected)
  const engineRunning = useStore((s) => s.engineStatus.running)

  return (
    <aside
      className="flex flex-col w-56 shrink-0 border-r"
      style={{ background: 'hsl(222,47%,7%)', borderColor: 'hsl(217,32%,15%)' }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 py-5 border-b" style={{ borderColor: 'hsl(217,32%,15%)' }}>
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold"
          style={{ background: 'hsl(142,70%,45%)', color: 'hsl(222,47%,5%)' }}
        >
          P
        </div>
        <span className="font-semibold text-sm tracking-wide" style={{ color: 'hsl(210,40%,98%)' }}>
          Polyplatform
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-4 space-y-0.5">
        {nav.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'text-white font-medium'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
              }`
            }
            style={({ isActive }) =>
              isActive ? { background: 'hsl(217,32%,17%)', color: 'hsl(142,70%,45%)' } : {}
            }
          >
            <Icon size={16} />
            {label}
            {label === 'Arbitrage' && engineRunning && (
              <span
                className="ml-auto w-2 h-2 rounded-full animate-pulse"
                style={{ background: 'hsl(142,70%,45%)' }}
              />
            )}
          </NavLink>
        ))}
      </nav>

      {/* WS status */}
      <div
        className="px-4 py-3 border-t flex items-center gap-2 text-xs"
        style={{ borderColor: 'hsl(217,32%,15%)', color: 'hsl(215,20%,55%)' }}
      >
        <div
          className={`w-2 h-2 rounded-full ${wsConnected ? 'animate-pulse' : ''}`}
          style={{ background: wsConnected ? 'hsl(142,70%,45%)' : 'hsl(0,84%,60%)' }}
        />
        {wsConnected ? 'Connected' : 'Disconnected'}
      </div>
    </aside>
  )
}
