import { AlertCircle, Info, Sparkles } from 'lucide-react'

interface ErrorBannerProps {
  message: string
}

export function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <div style={{
      padding: 10, marginBottom: 10, fontSize: 12,
      color: '#fca5a5', backgroundColor: 'rgba(239, 68, 68, 0.1)',
      border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 6,
    }}>
      {message}
    </div>
  )
}

interface PastRunBannerProps {
  startedAt: string | null
  onExit: () => void
}

export function PastRunBanner({ startedAt, onExit }: PastRunBannerProps) {
  const when = startedAt ? new Date(startedAt).toLocaleString() : 'Unknown date'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px',
      backgroundColor: 'rgba(124, 58, 237, 0.10)',
      border: '1px solid rgba(124, 58, 237, 0.35)', borderRadius: 6,
      fontSize: 12, color: '#e5e5e5',
    }}>
      <Sparkles size={13} style={{ color: '#a78bfa', flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        Viewing past run from <b>{when}</b> — read-only.
      </span>
      <button
        onClick={onExit}
        style={{
          padding: '4px 10px', fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
          color: '#e5e5e5', background: 'transparent',
          border: '1px solid rgba(124, 58, 237, 0.4)', borderRadius: 5,
          cursor: 'pointer',
        }}
      >
        Back to current
      </button>
    </div>
  )
}

interface FailedBannerProps {
  message: string
  onRunAgain: () => void
  title?: string
  retryLabel?: string
}

export function FailedBanner({ message, onRunAgain, title = 'Optimization failed', retryLabel = 'Try again' }: FailedBannerProps) {
  return (
    <div style={{
      padding: 14, backgroundColor: 'rgba(239, 68, 68, 0.08)',
      border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <AlertCircle size={16} style={{ color: '#ef4444' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>{title}</span>
      </div>
      <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 10 }}>{message}</div>
      <button onClick={onRunAgain} style={{
        padding: '6px 14px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        color: '#fff', backgroundColor: '#7c3aed',
        border: '1px solid #7c3aed', borderRadius: 6, cursor: 'pointer',
      }}>
        {retryLabel}
      </button>
    </div>
  )
}

interface CancelledBannerProps {
  completedTrials: number
  onRunAgain: () => void
  title?: string
  retryLabel?: string
}

export function CancelledBanner({ completedTrials, onRunAgain, title = 'Optimization cancelled', retryLabel = 'Run again' }: CancelledBannerProps) {
  return (
    <div style={{
      padding: 14, backgroundColor: '#1f1f1f',
      border: '1px solid #333', borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Info size={16} style={{ color: '#888' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>{title}</span>
      </div>
      <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
        {completedTrials} trial{completedTrials !== 1 ? 's' : ''} completed before you cancelled.
      </div>
      <button onClick={onRunAgain} style={{
        padding: '6px 14px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
        color: '#fff', backgroundColor: '#7c3aed',
        border: '1px solid #7c3aed', borderRadius: 6, cursor: 'pointer',
      }}>
        {retryLabel}
      </button>
    </div>
  )
}
