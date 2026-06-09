import { NavLink } from 'react-router-dom'
import { LayoutDashboard, BarChart2, ArrowLeftRight, TrendingUp, Settings, Zap, ScanLine, ScrollText, Columns2 } from 'lucide-react'
import { useStore } from '../../store/useStore.ts'

const nav = [
  { to: '/compare', icon: Columns2, label: 'Compare' },
  { to: '/scanner', icon: ScanLine, label: 'Scanner' },
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/markets', icon: BarChart2, label: 'Markets' },
  { to: '/trade', icon: ArrowLeftRight, label: 'Trade' },
  { to: '/arbitrage', icon: Zap, label: 'Arbitrage' },
  { to: '/positions', icon: TrendingUp, label: 'Positions' },
  { to: '/logs', icon: ScrollText, label: 'Logs' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export function TopBar() {
  const wsConnected = useStore((s) => s.wsConnected)
  const engineRunning = useStore((s) => s.engineStatus.running)
  const engineStatus = useStore((s) => s.engineStatus)

  return (
    <header
      className="flex items-center gap-1 px-3 py-1.5 border-b shrink-0 overflow-x-auto"
      style={{ background: 'hsl(222,47%,7%)', borderColor: 'hsl(217,32%,15%)', scrollbarWidth: 'none' }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 mr-3 shrink-0">
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold"
          style={{ background: 'hsl(142,70%,45%)', color: 'hsl(222,47%,5%)' }}
        >
          P
        </div>
        <span className="font-semibold text-xs tracking-wide hidden lg:inline" style={{ color: 'hsl(210,40%,98%)' }}>
          Polyplatform
        </span>
      </div>

      {/* Navigation links */}
      <nav className="flex items-center gap-0.5">
        {nav.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                isActive
                  ? 'text-white font-medium'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
              }`
            }
            style={({ isActive }) =>
              isActive ? { background: 'hsl(217,32%,17%)', color: 'hsl(142,70%,45%)' } : {}
            }
          >
            <Icon size={13} />
            <span className="hidden sm:inline">{label}</span>
            {label === 'Arbitrage' && engineRunning && (
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'hsl(142,70%,45%)' }} />
            )}
          </NavLink>
        ))}
      </nav>

      {/* Right side status */}
      <div className="flex items-center gap-3 ml-auto text-xs shrink-0" style={{ color: 'hsl(215,20%,55%)' }}>
        {engineStatus.lastError && (
          <span className="px-1.5 py-0.5 rounded text-xs truncate max-w-[200px]" style={{ background: 'hsl(0,84%,15%)', color: 'hsl(0,84%,70%)' }}>
            {engineStatus.lastError}
          </span>
        )}
        <div className="flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'animate-pulse' : ''}`}
            style={{ background: wsConnected ? 'hsl(142,70%,45%)' : 'hsl(0,84%,60%)' }} />
          {wsConnected ? 'Live' : 'Off'}
        </div>
        <span>
          Engine: <span style={{ color: engineRunning ? 'hsl(142,70%,45%)' : 'hsl(215,20%,55%)' }}>{engineRunning ? 'On' : 'Off'}</span>
        </span>
      </div>
    </header>
  )
}
