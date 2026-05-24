import { RotateCcw, Sparkles } from 'lucide-react'
import type { KBOptimizationRun, OptimizationSuggestion, OptimizationTrial } from '../../api/knowledge'
import { OptimizationHistoryPanel } from './OptimizationHistoryPanel'
import { FailedBanner, CancelledBanner } from '../shared/RunBanners'
import { ApplyBackButton } from '../shared/ApplyBackButton'
import { SuggestionsList, type Suggestion } from '../shared/SuggestionsList'
import { QualityComparisonCard, type BaselinePoint } from '../shared/QualityComparisonCard'
import { TrialsTable, type SortOption } from '../shared/TrialsTable'

interface Props {
  run: KBOptimizationRun
  canManage: boolean
  onApply: () => void
  applying: boolean
  onRunAgain: () => void
  /** Optional click-through to view a different past run from the history list. */
  onSelectPastRun?: (runUuid: string) => void
}

export function OptimizationResults({ run, canManage, onApply, applying, onRunAgain, onSelectPastRun }: Props) {
  if (run.status === 'failed') {
    return (
      <FailedBanner
        message={run.error_message || 'Optimization failed.'}
        onRunAgain={onRunAgain}
      />
    )
  }
  if (run.status === 'cancelled') {
    return (
      <CancelledBanner
        completedTrials={run.trials.length}
        onRunAgain={onRunAgain}
      />
    )
  }

  const baselines: BaselinePoint[] = [
    { id: 'no-kb', label: 'No KB', score: run.baseline_no_kb_score, color: '#888' },
    { id: 'default', label: 'Default', score: run.baseline_default_score, color: '#3b82f6' },
    { id: 'optimized', label: 'Optimized', score: run.optimized_score, color: '#22c55e', emphasised: true },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Comparison card */}
      <QualityComparisonCard
        baselines={baselines}
        variance={run.judge_variance ?? 0}
        secondaryBaselineId="no-kb"
      />

      {/* Best config + Apply */}
      {run.best_config && (
        <BestConfigCard
          config={run.best_config}
          isAlreadyApplied={!!run.options?.apply_on_finish}
          canManage={canManage}
          onApply={onApply}
          applying={applying}
        />
      )}

      {/* Suggestions */}
      {run.data_source_suggestions.length > 0 && (
        <SuggestionsList
          title="Data-source suggestions"
          suggestions={run.data_source_suggestions.map(toGenericSuggestion)}
        />
      )}

      {/* Trials table */}
      {run.trials.length > 0 && (
        <TrialsTable
          trials={run.trials}
          sortOptions={KB_TRIAL_SORT_OPTIONS}
          renderRow={renderKBTrialRow}
          getRowKey={(t) => t.trial_id}
        />
      )}

      {/* Past runs */}
      <OptimizationHistoryPanel
        kbUuid={run.kb_uuid}
        excludeRunUuid={run.uuid}
        onSelect={onSelectPastRun}
      />

      {/* Re-run */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={onRunAgain}
          disabled={!canManage}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
            color: canManage ? '#a78bfa' : '#555',
            background: 'transparent',
            border: '1px solid ' + (canManage ? 'rgba(124, 58, 237, 0.3)' : '#333'),
            borderRadius: 6, cursor: canManage ? 'pointer' : 'not-allowed',
          }}
        >
          <RotateCcw size={12} />
          Re-run
        </button>
      </div>
    </div>
  )
}

function BestConfigCard({
  config, isAlreadyApplied, canManage, onApply, applying,
}: { config: OptimizationTrial['config']; isAlreadyApplied: boolean; canManage: boolean; onApply: () => void; applying: boolean }) {
  const rows: { label: string; value: string }[] = [
    { label: 'Top-k chunks', value: String(config.k) },
    { label: 'Model', value: config.model || 'default' },
    { label: 'Prompt variant', value: config.prompt_variant },
    { label: 'Query rewriting', value: config.query_rewriting ? 'on' : 'off' },
    { label: 'Source labels in context', value: config.source_label_visibility ? 'visible' : 'hidden' },
  ]
  return (
    <div style={{
      padding: 14, backgroundColor: '#1f1f1f',
      border: '1px solid #2e2e2e', borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Sparkles size={14} style={{ color: '#a78bfa' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>Best configuration</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {rows.map(r => (
          <div key={r.label} style={{
            padding: '6px 10px', backgroundColor: '#262626', borderRadius: 4,
          }}>
            <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{r.label}</div>
            <div style={{ fontSize: 12, color: '#e5e5e5', marginTop: 2 }}>{r.value}</div>
          </div>
        ))}
      </div>
      <ApplyBackButton
        canApply={canManage}
        onApply={onApply}
        applying={applying}
        isAlreadyApplied={isAlreadyApplied}
      />
    </div>
  )
}

/** Convert KB-domain OptimizationSuggestion to the generic Suggestion shape. */
function toGenericSuggestion(s: OptimizationSuggestion): Suggestion {
  return { severity: s.severity, message: s.message }
}

const KB_TRIAL_SORT_OPTIONS: SortOption<OptimizationTrial>[] = [
  { key: 'score', label: 'Score', compare: (a, b) => b.score - a.score },
  { key: 'lift', label: 'Lift', compare: (a, b) => (b.lift_vs_default ?? 0) - (a.lift_vs_default ?? 0) },
  { key: 'duration', label: 'Duration', compare: (a, b) => (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0) },
]

function renderKBTrialRow(t: OptimizationTrial) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 10px', fontSize: 11, color: '#ddd',
      backgroundColor: t.status === 'failed' ? 'rgba(239, 68, 68, 0.05)' : 'rgba(0,0,0,0.2)',
      borderRadius: 4,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        backgroundColor: scoreColor(t.score),
      }} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#aaa' }}>
        {summariseConfig(t.config)}
      </span>
      {t.lift_vs_default != null && (
        <span style={{
          fontSize: 10,
          color: t.lift_vs_default > 0 ? '#22c55e' : t.lift_vs_default < 0 ? '#ef4444' : '#666',
        }}>
          {t.lift_vs_default > 0 ? '+' : ''}{(t.lift_vs_default * 100).toFixed(0)}pts
        </span>
      )}
      <span style={{ width: 50, textAlign: 'right', fontWeight: 600, color: '#e5e5e5' }}>
        {(t.score * 100).toFixed(0)}%
      </span>
    </div>
  )
}

function summariseConfig(c: OptimizationTrial['config']) {
  const bits = [`k=${c.k}`]
  if (c.model) bits.push(c.model)
  if (c.prompt_variant && c.prompt_variant !== 'default') bits.push(c.prompt_variant)
  if (c.query_rewriting) bits.push('query-rewrite')
  if (c.source_label_visibility === false) bits.push('no-source-labels')
  return bits.join(' · ')
}

function scoreColor(s: number) {
  if (s >= 0.7) return '#22c55e'
  if (s >= 0.4) return '#f59e0b'
  return '#ef4444'
}
