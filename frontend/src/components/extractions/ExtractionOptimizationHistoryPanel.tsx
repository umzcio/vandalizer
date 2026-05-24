/**
 * Collapsible list of past optimization runs for a SearchSet.
 *
 * Lazy-loads history on first open. Clicking a row notifies the parent so
 * it can fetch the full run document and flip into a read-only "viewing past
 * run" state. Light-mode styling — matches the Validate-tab surrounding UI
 * (KB's equivalent is dark-mode; the structure here is intentionally
 * parallel but the chrome differs).
 */
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, History, Loader2 } from 'lucide-react'
import {
  listExtractionOptimizationHistory,
  type ExtractionOptimizationRunSummary,
} from '../../api/extractions'
import { StatusDot } from '../shared/StatusDot'

interface Props {
  searchSetUuid: string
  /** Run UUID to suppress from the list (typically the currently displayed run). */
  excludeRunUuid?: string
  /** Called when a past run is clicked. Parent fetches the full payload. */
  onSelect?: (runUuid: string) => void
}

export function ExtractionOptimizationHistoryPanel({
  searchSetUuid, excludeRunUuid, onSelect,
}: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ExtractionOptimizationRunSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || items !== null) return
    setLoading(true)
    listExtractionOptimizationHistory(searchSetUuid, { limit: 20 })
      .then(out => setItems(out.items))
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [open, items, searchSetUuid])

  // Reset cache when the SearchSet changes.
  useEffect(() => { setItems(null); setOpen(false) }, [searchSetUuid])

  const filtered = (items ?? []).filter(r => r.uuid !== excludeRunUuid)

  return (
    <div style={{
      backgroundColor: '#fafafa',
      border: '1px solid #e5e7eb', borderRadius: 8,
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '10px 14px', background: 'transparent', border: 'none',
          fontFamily: 'inherit', cursor: 'pointer', color: '#1f2937',
          textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={14} style={{ color: '#6b7280' }} /> : <ChevronRight size={14} style={{ color: '#6b7280' }} />}
        <History size={14} style={{ color: '#6b7280' }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Previous runs</span>
        {items != null && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }}>
            {filtered.length} {filtered.length === 1 ? 'run' : 'runs'}
          </span>
        )}
      </button>

      {open && (
        <div style={{ padding: '0 12px 12px 12px' }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: 16, color: '#6b7280' }}>
              <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
          )}
          {error && (
            <div style={{ fontSize: 12, color: '#b91c1c', padding: 8 }}>{error}</div>
          )}
          {items != null && !loading && filtered.length === 0 && (
            <div style={{ fontSize: 12, color: '#6b7280', padding: '12px 8px' }}>
              No prior optimization runs for this extraction.
            </div>
          )}
          {items != null && filtered.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {filtered.map(run => (
                <HistoryRow key={run.uuid} run={run} onSelect={onSelect} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function HistoryRow({
  run, onSelect,
}: { run: ExtractionOptimizationRunSummary; onSelect?: (runUuid: string) => void }) {
  const score = run.optimized_score
  const baseline = run.baseline_default_score
  const lift = score != null && baseline != null ? (score - baseline) * 100 : null

  return (
    <button
      onClick={() => onSelect?.(run.uuid)}
      disabled={!onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px', textAlign: 'left',
        background: '#fff', border: '1px solid #e5e7eb',
        borderRadius: 5, cursor: onSelect ? 'pointer' : 'default',
        fontFamily: 'inherit', color: '#1f2937',
      }}
      onMouseEnter={e => onSelect && (e.currentTarget.style.borderColor = '#c4b5fd')}
      onMouseLeave={e => onSelect && (e.currentTarget.style.borderColor = '#e5e7eb')}
    >
      <StatusDot status={run.status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.started_at ? new Date(run.started_at).toLocaleString() : 'Unknown date'}
          <span style={{ color: '#9ca3af' }}> · {run.num_trials} trial{run.num_trials !== 1 ? 's' : ''}</span>
          {run.options?.apply_on_finish ? <span style={{ color: '#7c3aed' }}> · auto-applied</span> : null}
        </div>
        {run.error_message && run.status === 'failed' && (
          <div style={{
            fontSize: 10, color: '#b91c1c', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1,
          }}>
            {run.error_message}
          </div>
        )}
      </div>
      {score != null && (
        <span style={{ fontSize: 12, fontWeight: 600, color: scoreColor(score), minWidth: 42, textAlign: 'right' }}>
          {(score * 100).toFixed(0)}%
        </span>
      )}
      {lift != null && (
        <span style={{
          fontSize: 10,
          color: lift > 0 ? '#16a34a' : lift < 0 ? '#dc2626' : '#9ca3af',
          minWidth: 50, textAlign: 'right',
        }}>
          {lift > 0 ? '+' : ''}{lift.toFixed(0)}pts
        </span>
      )}
    </button>
  )
}

function scoreColor(s: number) {
  if (s >= 0.7) return '#16a34a'
  if (s >= 0.4) return '#d97706'
  return '#dc2626'
}
