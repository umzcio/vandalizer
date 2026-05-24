/**
 * 3-step wizard for extraction autovalidate: test cases → budget → confirm.
 *
 * Built on the shared `AutovalidateWizard` shell. Each step is a `WizardStep`
 * whose `render` function returns the step body. The wizard owns the options
 * state; this component supplies the renders + the final start handler.
 *
 * Step 1 (test cases): show count; if zero, offer to generate from documents.
 *   The user must have at least one test case to advance.
 * Step 2 (budget): pick Quick / Standard / Thorough → max_candidates.
 * Step 3 (confirm): summary + apply-on-finish toggle + Start.
 */
import { useEffect, useState } from 'react'
import { useToast } from '../../contexts/ToastContext'
import { getUserConfig } from '../../api/config'
import { formatBudgetEstimate } from '../../api/knowledge'
import type { ModelInfo } from '../../types/workflow'
import {
  listTestCases,
  startExtractionOptimization,
  type StartExtractionOptimizationOptions,
} from '../../api/extractions'
import { AutovalidateWizard, type WizardStep } from '../shared/AutovalidateWizard'
import { BudgetTierPicker } from '../shared/BudgetTierPicker'
import {
  EXTRACTION_BUDGET_TIERS,
  type ExtractionBudgetTier,
} from '../shared/budgetTiers'
import { Toggle } from '../shared/Toggle'
import { GenerateTestCasesModal } from './GenerateTestCasesModal'

interface Props {
  searchSetUuid: string
  onClose: () => void
  /** Called after the optimization is queued; parent typically begins polling. */
  onStarted: (runUuid: string) => void
}

type Tier = typeof EXTRACTION_BUDGET_TIERS[number]['id'] | 'custom'

interface ExtractionWizardOptions {
  tier: Tier
  customCandidates: number
  applyOnFinish: boolean
  includeJudge: boolean
}

const INITIAL_OPTIONS: ExtractionWizardOptions = {
  tier: 'standard',
  customCandidates: 6,
  applyOnFinish: false,
  includeJudge: true,
}

export function ExtractionAutovalidateWizard({ searchSetUuid, onClose, onStarted }: Props) {
  const { toast } = useToast()
  const [testCaseCount, setTestCaseCount] = useState<number | null>(null)
  const [showGenerateModal, setShowGenerateModal] = useState(false)
  const [userModel, setUserModel] = useState<ModelInfo | null>(null)

  // Load test case count + user model once
  useEffect(() => {
    listTestCases(searchSetUuid)
      .then(cases => setTestCaseCount(cases.length))
      .catch(() => setTestCaseCount(0))
    getUserConfig()
      .then(cfg => {
        const target = cfg.model
        const match = cfg.available_models.find(m => m.tag === target || m.name === target)
          || cfg.available_models[0]
          || null
        setUserModel(match)
      })
      .catch(() => { /* tokens-only fallback */ })
  }, [searchSetUuid])

  const candidatesFor = (opts: ExtractionWizardOptions): number => {
    if (opts.tier === 'custom') return Math.max(1, opts.customCandidates)
    const tier = EXTRACTION_BUDGET_TIERS.find(t => t.id === opts.tier)
    return tier?.maxCandidates ?? 8
  }

  const handleConfirm = async (opts: ExtractionWizardOptions) => {
    const payload: StartExtractionOptimizationOptions = {
      token_budget: 0,
      max_candidates: candidatesFor(opts),
      apply_on_finish: opts.applyOnFinish,
      include_judge: opts.includeJudge,
    }
    try {
      const { run_uuid } = await startExtractionOptimization(searchSetUuid, payload)
      onStarted(run_uuid)
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to start optimization', 'error')
    }
  }

  const steps: WizardStep<ExtractionWizardOptions>[] = [
    {
      id: 'test-cases',
      label: 'Test cases',
      render: () => (
        <TestCasesStep
          count={testCaseCount}
          onGenerate={() => setShowGenerateModal(true)}
        />
      ),
      // Can't optimize without test cases — gate Next on having at least one
      canAdvance: () => (testCaseCount ?? 0) > 0,
    },
    {
      id: 'budget',
      label: 'Budget',
      render: (opts, set) => (
        <BudgetStepContent
          tier={opts.tier}
          onTier={(id) => set(o => ({ ...o, tier: id as Tier }))}
          customCandidates={opts.customCandidates}
          onCustomCandidates={(n) => set(o => ({ ...o, customCandidates: n }))}
          includeJudge={opts.includeJudge}
          onIncludeJudge={(b) => set(o => ({ ...o, includeJudge: b }))}
          userModel={userModel}
          candidatesForOpts={candidatesFor}
          opts={opts}
        />
      ),
    },
    {
      id: 'confirm',
      label: 'Confirm',
      render: (opts, set) => (
        <ConfirmStep
          candidates={candidatesFor(opts)}
          applyOnFinish={opts.applyOnFinish}
          onApplyOnFinish={(b) => set(o => ({ ...o, applyOnFinish: b }))}
          includeJudge={opts.includeJudge}
          testCaseCount={testCaseCount ?? 0}
        />
      ),
    },
  ]

  return (
    <>
      <AutovalidateWizard<ExtractionWizardOptions>
        steps={steps}
        initialOptions={INITIAL_OPTIONS}
        onConfirm={handleConfirm}
        onClose={onClose}
        title="Improve extraction quality"
        confirmLabel="Start optimization"
      />
      {showGenerateModal && (
        <GenerateTestCasesModal
          searchSetUuid={searchSetUuid}
          onClose={() => setShowGenerateModal(false)}
          onSaved={() => {
            setShowGenerateModal(false)
            // Refresh count so canAdvance unlocks
            listTestCases(searchSetUuid)
              .then(cases => setTestCaseCount(cases.length))
              .catch(() => {})
          }}
        />
      )}
    </>
  )
}


// ---------------------------------------------------------------------------
// Step bodies
// ---------------------------------------------------------------------------


function TestCasesStep({
  count, onGenerate,
}: { count: number | null; onGenerate: () => void }) {
  if (count === null) {
    return <div style={{ fontSize: 13, color: '#6b7280' }}>Loading test cases…</div>
  }
  if (count === 0) {
    return (
      <div style={{ fontSize: 13, color: '#ccc', lineHeight: 1.6 }}>
        <h4 style={{ margin: '0 0 8px 0', fontSize: 13, color: '#fff' }}>You don't have any test cases yet</h4>
        <p style={{ margin: '0 0 12px 0', color: '#bbb' }}>
          We need at least one example to check the AI's work against. Pick a few documents
          and we'll suggest expected values for each one — you review them before they're saved.
        </p>
        <button
          onClick={onGenerate}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
            color: '#fff',
            background: 'linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%)',
            border: '1px solid #7c3aed',
            borderRadius: 6, cursor: 'pointer',
          }}
        >
          Generate test cases from documents
        </button>
        <p style={{ marginTop: 12, fontSize: 11, color: '#888' }}>
          Once you save at least one test case, the Next button below will unlock.
        </p>
      </div>
    )
  }

  return (
    <div style={{ fontSize: 13, color: '#ccc', lineHeight: 1.6 }}>
      <h4 style={{ margin: '0 0 8px 0', fontSize: 13, color: '#fff' }}>
        {count} test case{count === 1 ? '' : 's'} ready
      </h4>
      <p style={{ margin: '0 0 12px 0', color: '#bbb' }}>
        We'll run the AI against {count === 1 ? 'this test case' : 'these test cases'} with
        different settings and score how close each result is to your expected values.
        More test cases = more reliable scoring — you can add more, then come back here.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onGenerate}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
            color: '#a78bfa', background: 'transparent',
            border: '1px solid rgba(124, 58, 237, 0.4)',
            borderRadius: 6, cursor: 'pointer',
          }}
        >
          + Generate more from documents
        </button>
      </div>
      <p style={{ marginTop: 14, fontSize: 11, color: '#888' }}>
        Tip: 3–5 carefully-checked test cases work better than 20 rushed ones. The optimizer is
        only as good as the test cases you give it.
      </p>
    </div>
  )
}


function BudgetStepContent({
  tier, onTier, customCandidates, onCustomCandidates,
  includeJudge, onIncludeJudge,
  userModel, candidatesForOpts, opts,
}: {
  tier: Tier
  onTier: (id: string) => void
  customCandidates: number
  onCustomCandidates: (n: number) => void
  includeJudge: boolean
  onIncludeJudge: (b: boolean) => void
  userModel: ModelInfo | null
  candidatesForOpts: (o: ExtractionWizardOptions) => number
  opts: ExtractionWizardOptions
}) {
  // Compute display labels for the picker's summary line
  const selectedTier = EXTRACTION_BUDGET_TIERS.find(t => t.id === tier)
  const selectedTokens = tier === 'custom'
    ? customCandidates * 80_000   // rough estimate per trial
    : (selectedTier?.tokens ?? 0)
  const { tokens_label, cost_label } = formatBudgetEstimate(selectedTokens, userModel)

  return (
    <div>
      <BudgetTierPicker
        tiers={EXTRACTION_BUDGET_TIERS as readonly ExtractionBudgetTier[]}
        selected={tier}
        onSelect={onTier}
        customTokens={customCandidates}
        onCustomTokens={onCustomCandidates}
        tokensLabel={`${candidatesForOpts(opts)} configurations tried`}
        costLabel={cost_label ?? tokens_label}
        formatTierRow={(t) => {
          const { tokens_label, cost_label } = formatBudgetEstimate(t.tokens, userModel)
          return { tokensLabel: tokens_label, costLabel: cost_label }
        }}
        title="How thorough?"
        description="More configurations tried = better chance of finding the best one. Each configuration is run against every test case."
      />
      <div style={{ marginTop: 14 }}>
        <Toggle
          label="Score by meaning, not exact text (recommended)"
          description="Treats 'Jan 5, 2026' and '2026-01-05' as the same answer. Uses a small amount of extra AI usage; turn off for strict character-by-character matching."
          checked={includeJudge}
          onChange={onIncludeJudge}
        />
      </div>
    </div>
  )
}


function ConfirmStep({
  candidates, applyOnFinish, onApplyOnFinish, includeJudge, testCaseCount,
}: {
  candidates: number
  applyOnFinish: boolean
  onApplyOnFinish: (b: boolean) => void
  includeJudge: boolean
  testCaseCount: number
}) {
  return (
    <div style={{ fontSize: 13, color: '#ccc' }}>
      <h4 style={{ margin: '0 0 8px 0', fontSize: 13, color: '#fff' }}>Ready to start</h4>
      <p style={{ margin: '0 0 14px 0', color: '#bbb', lineHeight: 1.5 }}>
        Here's what will happen:
      </p>
      <ul style={{ margin: '0 0 16px 0', paddingLeft: 18, color: '#bbb', lineHeight: 1.7, fontSize: 12 }}>
        <li>Measure how extraction performs <b>without any custom settings</b> — the floor we need to beat</li>
        <li>Measure how it performs with your <b>current settings</b></li>
        <li>Try <b>{candidates} different configuration{candidates === 1 ? '' : 's'}</b> against your {testCaseCount} test case{testCaseCount === 1 ? '' : 's'}</li>
        {includeJudge && <li>Use AI to <b>score by meaning</b> (different formats of the same answer still match)</li>}
        <li>Pick the best one and show you the comparison</li>
      </ul>
      <Toggle
        label="Apply optimized settings automatically when finished"
        description="If unchecked, we'll show you the results and you can apply them manually."
        checked={applyOnFinish}
        onChange={onApplyOnFinish}
      />
      <div style={{
        marginTop: 14, padding: '10px 12px',
        backgroundColor: 'rgba(124, 58, 237, 0.08)',
        border: '1px solid rgba(124, 58, 237, 0.3)', borderRadius: 6,
        fontSize: 12, color: '#e5e5e5',
      }}>
        Click <b>Start optimization</b> below to begin. You can cancel anytime.
      </div>
    </div>
  )
}
