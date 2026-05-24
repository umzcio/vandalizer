import { useEffect, useState } from 'react'
import {
  formatBudgetEstimate,
  type StartOptimizationOptions,
  type OptimizationCoverage,
} from '../../api/knowledge'
import { getUserConfig } from '../../api/config'
import type { ModelInfo } from '../../types/workflow'
import { Toggle, Radio } from '../shared/Toggle'
import { BudgetTierPicker } from '../shared/BudgetTierPicker'
import { KB_BUDGET_TIERS } from '../shared/budgetTiers'
import { AutovalidateWizard, type WizardStep } from '../shared/AutovalidateWizard'

interface Props {
  kbUuid: string
  onConfirm: (opts: StartOptimizationOptions) => void
  onClose: () => void
}

type Tier = typeof KB_BUDGET_TIERS[number]['id'] | 'custom'

interface KBWizardOptions {
  tier: Tier
  customTokens: number
  coverage: OptimizationCoverage
  applyOnFinish: boolean
}

const INITIAL_OPTIONS: KBWizardOptions = {
  tier: 'standard',
  customTokens: 1_000_000,
  coverage: 'standard',
  applyOnFinish: false,
}

export function AutovalidateModal({ onConfirm, onClose }: Props) {
  // The user's resolved model (incl. cost_per_1m_*) — drives the dollar-cost
  // display when admins have populated those fields. Tokens-only fallback.
  const [userModel, setUserModel] = useState<ModelInfo | null>(null)

  useEffect(() => {
    getUserConfig().then(cfg => {
      const target = cfg.model
      const match = cfg.available_models.find(m => m.tag === target || m.name === target)
        || cfg.available_models[0]
        || null
      setUserModel(match)
    }).catch(() => { /* silent fallback to tokens-only */ })
  }, [])

  const tokensFor = (opts: KBWizardOptions): number =>
    opts.tier === 'custom'
      ? opts.customTokens
      : (KB_BUDGET_TIERS.find(t => t.id === opts.tier)?.tokens ?? 0)

  const steps: WizardStep<KBWizardOptions>[] = [
    {
      id: 'concept',
      label: 'Concept',
      render: () => <ConceptStep />,
    },
    {
      id: 'testset',
      label: 'Test set',
      render: (opts, set) => (
        <TestSetStep
          coverage={opts.coverage}
          onChange={(c) => set(o => ({ ...o, coverage: c }))}
        />
      ),
    },
    {
      id: 'budget',
      label: 'Budget',
      render: (opts, set) => {
        const tokens = tokensFor(opts)
        const { tokens_label, cost_label } = formatBudgetEstimate(tokens, userModel)
        return (
          <BudgetTierPicker
            tiers={KB_BUDGET_TIERS}
            selected={opts.tier}
            onSelect={(id) => set(o => ({ ...o, tier: id as Tier }))}
            customTokens={opts.customTokens}
            onCustomTokens={(n) => set(o => ({ ...o, customTokens: n }))}
            tokensLabel={tokens_label}
            costLabel={cost_label}
            formatTierRow={(t) => {
              const { tokens_label, cost_label } = formatBudgetEstimate(t.tokens, userModel)
              return { tokensLabel: tokens_label, costLabel: cost_label }
            }}
          />
        )
      },
    },
    {
      id: 'advanced',
      label: 'Advanced',
      render: (opts, set) => {
        const tokens = tokensFor(opts)
        const { tokens_label, cost_label } = formatBudgetEstimate(tokens, userModel)
        return (
          <AdvancedStep
            applyOnFinish={opts.applyOnFinish}
            onApplyOnFinish={(b) => set(o => ({ ...o, applyOnFinish: b }))}
            tokensLabel={tokens_label}
            costLabel={cost_label}
          />
        )
      },
    },
  ]

  const handleConfirm = (opts: KBWizardOptions) => {
    onConfirm({
      token_budget: tokensFor(opts),
      apply_on_finish: opts.applyOnFinish,
      autogen_coverage: opts.coverage,
      include_indexing_track: false,
    })
  }

  return (
    <AutovalidateWizard<KBWizardOptions>
      steps={steps}
      initialOptions={INITIAL_OPTIONS}
      onConfirm={handleConfirm}
      onClose={onClose}
      title="Autovalidate"
      confirmLabel="Start optimization"
    />
  )
}

function ConceptStep() {
  return (
    <div style={{ fontSize: 13, color: '#ccc', lineHeight: 1.6 }}>
      <h4 style={{ margin: '0 0 8px 0', fontSize: 13, color: '#fff' }}>What is Autovalidate?</h4>
      <p style={{ margin: '0 0 10px 0' }}>
        We try many ways of using your knowledge base — different retrieval
        settings, prompts, and models — and keep whichever combination answers
        your test questions best. The LLM acts as a judge, comparing each
        answer to a canonical expected answer.
      </p>
      <h4 style={{ margin: '0 0 6px 0', fontSize: 13, color: '#fff' }}>What it changes</h4>
      <ul style={{ margin: '0 0 10px 0', paddingLeft: 18, color: '#bbb' }}>
        <li>Retrieval depth (top-k chunks)</li>
        <li>LLM model used to answer</li>
        <li>Query rewriting on/off</li>
        <li>System prompt variant (default / strict / concise)</li>
        <li>Whether source labels are visible to the model</li>
      </ul>
      <h4 style={{ margin: '0 0 6px 0', fontSize: 13, color: '#fff' }}>What it doesn't change</h4>
      <ul style={{ margin: '0 0 10px 0', paddingLeft: 18, color: '#bbb' }}>
        <li>Sources (we suggest improvements but never add or remove)</li>
        <li>Test queries</li>
        <li>Settings — until you click Apply</li>
      </ul>
      <h4 style={{ margin: '0 0 6px 0', fontSize: 13, color: '#fff' }}>Caveats</h4>
      <ul style={{ margin: 0, paddingLeft: 18, color: '#bbb' }}>
        <li>Costs LLM tokens (you'll set the budget next)</li>
        <li>Optimization quality depends on test-question quality</li>
        <li>Judge scores have ~3-5pt noise; we report the confidence interval</li>
      </ul>
    </div>
  )
}

function TestSetStep({
  coverage, onChange,
}: { coverage: OptimizationCoverage; onChange: (c: OptimizationCoverage) => void }) {
  return (
    <div style={{ fontSize: 13, color: '#ccc', lineHeight: 1.5 }}>
      <h4 style={{ margin: '0 0 8px 0', fontSize: 13, color: '#fff' }}>Test set source</h4>
      <p style={{ margin: '0 0 12px 0', color: '#bbb' }}>
        If you've already created test queries (manually or auto-generated),
        we'll use those. If not, we'll generate them from your KB content
        before the trials begin. Pick how thorough that generation should be:
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(['quick', 'standard', 'exhaustive'] as const).map(c => {
          const active = coverage === c
          const counts: Record<typeof c, number> = { quick: 5, standard: 10, exhaustive: 25 } as Record<OptimizationCoverage, number>
          return (
            <button
              key={c}
              onClick={() => onChange(c)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 12px', textAlign: 'left',
                backgroundColor: active ? 'rgba(124, 58, 237, 0.12)' : '#262626',
                border: '1px solid ' + (active ? '#7c3aed' : '#333'),
                borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', color: '#e5e5e5',
              }}
            >
              <Radio active={active} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>{c}</div>
                <div style={{ fontSize: 11, color: '#888' }}>up to {counts[c]} questions</div>
              </div>
            </button>
          )
        })}
      </div>
      <p style={{ marginTop: 10, fontSize: 11, color: '#888' }}>
        Generated queries persist after the run, so future re-runs reuse them.
      </p>
    </div>
  )
}

function AdvancedStep({
  applyOnFinish, onApplyOnFinish, tokensLabel, costLabel,
}: {
  applyOnFinish: boolean
  onApplyOnFinish: (b: boolean) => void
  tokensLabel: string
  costLabel: string | null
}) {
  return (
    <div style={{ fontSize: 13, color: '#ccc' }}>
      <h4 style={{ margin: '0 0 8px 0', fontSize: 13, color: '#fff' }}>Advanced options</h4>
      <Toggle
        label="Apply optimized settings automatically when finished"
        description="If unchecked, we'll show you the results and you can apply them manually."
        checked={applyOnFinish}
        onChange={onApplyOnFinish}
      />
      <Toggle
        label="Try re-chunking documents (advanced)"
        description="Coming in v2 — disabled. Re-chunks + re-embeds for each chunking trial. Slower."
        checked={false}
        disabled
      />
      <Toggle
        label="Try alternate embedding models (advanced)"
        description="Coming in v2 — disabled. Re-embeds the entire KB for each embedding-model trial."
        checked={false}
        disabled
      />
      <div style={{
        marginTop: 16, padding: '10px 12px',
        backgroundColor: 'rgba(124, 58, 237, 0.08)',
        border: '1px solid rgba(124, 58, 237, 0.3)', borderRadius: 6,
      }}>
        <div style={{ fontSize: 11, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
          Ready to start
        </div>
        <div style={{ fontSize: 13, color: '#e5e5e5' }}>
          Budget: <b>{tokensLabel}</b>{costLabel && <> · <b>{costLabel}</b></>}
        </div>
      </div>
    </div>
  )
}
