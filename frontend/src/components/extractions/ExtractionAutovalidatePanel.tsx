/**
 * "Improve extraction quality" panel — drives the extraction optimizer
 * loop end-to-end inside the Validate tab.
 *
 * Three states, mirroring KB Autovalidate:
 *
 *   A (idle)      Hero card; "Improve quality" button opens the 3-step wizard.
 *   B (running)   Live progress via shared OptimizationProgressCard + cancel.
 *   C (completed) QualityComparisonCard + best-config + ApplyBackButton.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import {
  getActiveExtractionOptimization,
  getExtractionOptimization,
  cancelExtractionOptimization,
  applyExtractionOptimization,
  revertExtractionConfig,
  type ExtractionOptimizationRun,
} from '../../api/extractions'
import { OptimizationProgressCard, type ProgressRunShape } from '../shared/OptimizationProgressCard'
import { QualityComparisonCard, type BaselinePoint } from '../shared/QualityComparisonCard'
import { ApplyBackButton } from '../shared/ApplyBackButton'
import { FailedBanner, CancelledBanner, ErrorBanner, PastRunBanner } from '../shared/RunBanners'
import { SuggestionsList, type Suggestion, type SuggestionSeverity } from '../shared/SuggestionsList'
import { useIntervalPoll } from '../shared/hooks/useIntervalPoll'
import { useToast } from '../../contexts/ToastContext'
import { ExtractionAutovalidateWizard } from './ExtractionAutovalidateWizard'
import { ExtractionOptimizationHistoryPanel } from './ExtractionOptimizationHistoryPanel'

const POLL_INTERVAL_MS = 3000

interface Props {
  searchSetUuid: string
  /** Whether the current user can manage this SearchSet (gates Start/Apply). */
  canManage: boolean
  /** Called after a successful Apply so the parent can refresh its config view. */
  onApplied?: () => void
}

export function ExtractionAutovalidatePanel({ searchSetUuid, canManage, onApplied }: Props) {
  const { toast } = useToast()
  const [run, setRun] = useState<ExtractionOptimizationRun | null>(null)
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [applying, setApplying] = useState(false)
  const [reverting, setReverting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  // When set, the user is browsing a historical run instead of the live one.
  // The panel renders the past run in read-only mode (apply/revert hidden,
  // re-run disabled, history click-throughs return us here, not the active run).
  const [viewingPast, setViewingPast] = useState<ExtractionOptimizationRun | null>(null)
  const [viewingPastLoading, setViewingPastLoading] = useState(false)
  const mountedRef = useRef(true)

  const poll = useIntervalPoll<ExtractionOptimizationRun>()
  const { stop: stopPolling } = poll

  const startPolling = useCallback((runUuid: string) => {
    poll.start({
      fetch: () => getExtractionOptimization(searchSetUuid, runUuid),
      intervalMs: POLL_INTERVAL_MS,
      isTerminal: (r) => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled',
      onUpdate: (r) => { if (mountedRef.current) setRun(r) },
      onError: (e) => console.error('Optimization polling failed', e),
    })
  }, [searchSetUuid, poll])

  // Initial mount: detect active/recent run
  useEffect(() => {
    mountedRef.current = true
    setLoading(true)
    getActiveExtractionOptimization(searchSetUuid)
      .then(out => {
        if (!mountedRef.current) return
        if (out.run) {
          setRun(out.run)
          if (out.run.status === 'queued' || out.run.status === 'running') {
            startPolling(out.run.uuid)
          }
        }
      })
      .catch(e => {
        if (mountedRef.current) console.error('getActiveExtractionOptimization failed', e)
      })
      .finally(() => { if (mountedRef.current) setLoading(false) })
    return () => {
      mountedRef.current = false
      stopPolling()
    }
  }, [searchSetUuid, startPolling, stopPolling])

  // Wizard owns the API call; we just seed a placeholder run and begin polling.
  const handleWizardStarted = (runUuid: string) => {
    setError(null)
    const seed: ExtractionOptimizationRun = {
      uuid: runUuid,
      search_set_uuid: searchSetUuid,
      status: 'queued',
      phase: 'queued',
      progress_message: 'Queued…',
      current_trial_index: 0,
      total_trials_planned: 0,
      best_score_so_far: null,
      best_config_so_far: null,
      token_budget: 0,
      tokens_used: 0,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      baseline_no_tool_score: null,
      baseline_default_score: null,
      optimized_score: null,
      judge_variance: null,
      judge_model: null,
      best_config: null,
      trials: [],
      field_breakdown: [],
      suggestions: [],
      previous_override: null,
      options: {},
      error_message: null,
      started_at: new Date().toISOString(),
      completed_at: null,
      cancel_requested: false,
    }
    setRun(seed)
    startPolling(runUuid)
  }

  const handleCancel = async () => {
    if (!run) return
    setCancelling(true)
    try {
      await cancelExtractionOptimization(searchSetUuid, run.uuid)
      toast('Cancellation requested', 'info')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to cancel', 'error')
    } finally {
      setCancelling(false)
    }
  }

  const handleApply = async () => {
    if (!run) return
    setApplying(true)
    try {
      await applyExtractionOptimization(searchSetUuid, run.uuid)
      toast('Optimized settings applied', 'success')
      onApplied?.()
      // Refetch the run to update the previous_override field
      const fresh = await getExtractionOptimization(searchSetUuid, run.uuid)
      setRun(fresh)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to apply', 'error')
    } finally {
      setApplying(false)
    }
  }

  const handleSelectPastRun = async (runUuid: string) => {
    setViewingPastLoading(true)
    try {
      const fresh = await getExtractionOptimization(searchSetUuid, runUuid)
      setViewingPast(fresh)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to load past run', 'error')
    } finally {
      setViewingPastLoading(false)
    }
  }

  const handleExitPastRun = () => setViewingPast(null)

  const handleRevert = async () => {
    if (!run) return
    setReverting(true)
    try {
      await revertExtractionConfig(searchSetUuid)
      toast('Reverted to your previous configuration', 'success')
      onApplied?.()
      // Reset previous_override locally so the UI flips back to "Apply" state
      setRun({ ...run, previous_override: null })
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to revert', 'error')
    } finally {
      setReverting(false)
    }
  }

  const handleRunAgain = () => {
    setRun(null)
    setError(null)
    setShowWizard(true)
  }

  if (loading) return null

  // State A: idle — hero + button that opens the 3-step wizard
  if (!run) {
    return (
      <>
        <div style={{
          padding: 16,
          background: 'linear-gradient(135deg, #f0f4ff 0%, #faf5ff 100%)',
          border: '1px solid #c4b5fd',
          borderRadius: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Sparkles size={16} style={{ color: '#7c3aed' }} />
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#1f2937' }}>
              Improve extraction quality
            </h3>
          </div>
          <p style={{ margin: '4px 0 12px 0', fontSize: 12, color: '#4b5563', lineHeight: 1.5 }}>
            We'll try different AI models and extraction strategies against your test cases and
            keep whichever one scores best — plus we'll check whether your custom settings are
            actually doing better than no settings at all.
          </p>
          {error && <ErrorBanner message={error} />}
          <button
            onClick={() => setShowWizard(true)}
            disabled={!canManage}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
              color: !canManage ? '#9ca3af' : '#fff',
              background: !canManage ? '#e5e7eb' : 'linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%)',
              border: '1px solid ' + (!canManage ? '#d1d5db' : '#7c3aed'),
              borderRadius: 6,
              cursor: !canManage ? 'not-allowed' : 'pointer',
            }}
            title={!canManage ? 'You cannot manage this extraction' : ''}
          >
            <Sparkles size={14} />
            Improve quality
          </button>
        </div>
        {showWizard && (
          <ExtractionAutovalidateWizard
            searchSetUuid={searchSetUuid}
            onClose={() => setShowWizard(false)}
            onStarted={(runUuid) => {
              setShowWizard(false)
              handleWizardStarted(runUuid)
            }}
          />
        )}
      </>
    )
  }

  // State C: failed
  if (run.status === 'failed') {
    return (
      <FailedBanner
        message={run.error_message || 'Optimization failed.'}
        onRunAgain={handleRunAgain}
      />
    )
  }

  // State C: cancelled
  if (run.status === 'cancelled') {
    return (
      <CancelledBanner
        completedTrials={(run.trials || []).length}
        onRunAgain={handleRunAgain}
      />
    )
  }

  // State B: running (or queued)
  if (run.status === 'queued' || run.status === 'running') {
    const progressRun: ProgressRunShape<Record<string, unknown>> = {
      status: run.status,
      phase: run.phase,
      progress_message: run.progress_message,
      current_trial_index: run.current_trial_index,
      total_trials_planned: run.total_trials_planned,
      token_budget: run.token_budget,
      tokens_used: run.tokens_used,
      best_score_so_far: run.best_score_so_far,
      best_config_so_far: run.best_config_so_far,
      trials: (run.trials || []).map(t => ({
        trial_id: t.trial_id,
        config: t.config,
        score: t.score ?? 0,
        status: t.status,
      })),
      cancel_requested: run.cancel_requested,
    }
    return (
      <OptimizationProgressCard<Record<string, unknown>>
        run={progressRun}
        scoreFloor={run.baseline_no_tool_score}
        summariseConfig={summariseExtractionConfig}
        onCancel={handleCancel}
        cancelling={cancelling}
        scoreFloorLabel="Score to beat (without custom settings)"
        scoreFloorDescription="How well extraction performs with no custom settings — the optimized result needs to clear this bar to be worth keeping."
        liftLabel="better than no settings"
      />
    )
  }

  // State C: completed.
  //
  // The displayed run is either the live one or a historical one (when the
  // user clicked through from the history panel). Past runs are rendered
  // read-only — apply/revert/re-run are hidden, and a PastRunBanner indicates
  // the read-only state with a "back to current" exit.
  const displayedRun = viewingPast ?? run
  const isPast = viewingPast !== null

  const baselines: BaselinePoint[] = [
    { id: 'no-tool', label: 'No settings', score: displayedRun.baseline_no_tool_score, color: '#9ca3af' },
    { id: 'default', label: 'Your settings', score: displayedRun.baseline_default_score, color: '#3b82f6' },
    { id: 'optimized', label: 'Optimized', score: displayedRun.optimized_score, color: '#22c55e', emphasised: true },
  ]
  const isAlreadyApplied = displayedRun.previous_override !== null

  // Translate backend suggestions (which carry an extraction-specific 'kind')
  // into the shared component's domain-neutral shape.
  const suggestionsList: Suggestion[] = (displayedRun.suggestions || []).map(s => ({
    severity: s.severity as SuggestionSeverity,
    message: s.message,
  }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {isPast && (
        <PastRunBanner
          startedAt={displayedRun.started_at}
          onExit={handleExitPastRun}
        />
      )}
      {viewingPastLoading && (
        <div style={{ fontSize: 12, color: '#6b7280', padding: 8 }}>Loading past run…</div>
      )}
      <QualityComparisonCard
        baselines={baselines}
        variance={displayedRun.judge_variance ?? 0}
        secondaryBaselineId="no-tool"
      />
      {displayedRun.best_config && (
        <div style={{
          padding: 14, backgroundColor: '#fafafa',
          border: '1px solid #e5e7eb', borderRadius: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Sparkles size={14} style={{ color: '#7c3aed' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#1f2937' }}>Best config</span>
          </div>
          <div style={{ fontSize: 12, color: '#4b5563', lineHeight: 1.6 }}>
            {summariseExtractionConfig(displayedRun.best_config)}
          </div>
          {!isPast && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <ApplyBackButton
                canApply={canManage}
                onApply={handleApply}
                applying={applying}
                isAlreadyApplied={isAlreadyApplied}
              />
              {isAlreadyApplied && (
                <button
                  onClick={handleRevert}
                  disabled={!canManage || reverting}
                  style={{
                    padding: '6px 12px', fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
                    color: canManage && !reverting ? '#6b7280' : '#9ca3af',
                    background: 'transparent',
                    border: '1px solid #d1d5db',
                    borderRadius: 6,
                    cursor: canManage && !reverting ? 'pointer' : 'not-allowed',
                  }}
                  title="Restore your previous configuration"
                >
                  {reverting ? 'Reverting…' : 'Revert'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {suggestionsList.length > 0 && (
        <SuggestionsList
          title="Suggestions"
          suggestions={suggestionsList}
        />
      )}
      <ExtractionOptimizationHistoryPanel
        searchSetUuid={searchSetUuid}
        excludeRunUuid={displayedRun.uuid}
        onSelect={handleSelectPastRun}
      />
      {!isPast && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={handleRunAgain}
            disabled={!canManage}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
              color: canManage ? '#7c3aed' : '#9ca3af',
              background: 'transparent',
              border: '1px solid ' + (canManage ? '#c4b5fd' : '#e5e7eb'),
              borderRadius: 6, cursor: canManage ? 'pointer' : 'not-allowed',
            }}
          >
            Re-run
          </button>
        </div>
      )}
    </div>
  )
}

/** Domain-specific config formatter for extraction configs (shape: {model, strategy, thinking, …}). */
function summariseExtractionConfig(c: Record<string, unknown>): string {
  const bits: string[] = []
  if (c.model) bits.push(String(c.model))
  if (c.strategy) bits.push(String(c.strategy))
  if (c.thinking) bits.push('thinking')
  if (c.use_images) bits.push('image-mode')
  const chunkSize = (c as { chunking?: { chunk_size?: number } }).chunking?.chunk_size
  if (typeof chunkSize === 'number') bits.push(`chunk=${chunkSize}`)
  return bits.length > 0 ? bits.join(' · ') : 'default'
}
