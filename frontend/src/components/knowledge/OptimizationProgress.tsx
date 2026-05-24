import type { KBOptimizationRun, OptimizationTrial } from '../../api/knowledge'
import { OptimizationProgressCard } from '../shared/OptimizationProgressCard'

interface Props {
  run: KBOptimizationRun
  onCancel: () => void
  cancelling: boolean
}

export function OptimizationProgress({ run, onCancel, cancelling }: Props) {
  return (
    <OptimizationProgressCard<OptimizationTrial['config']>
      run={run}
      scoreFloor={run.baseline_no_kb_score}
      summariseConfig={summariseConfig}
      onCancel={onCancel}
      cancelling={cancelling}
      scoreFloorLabel="Score to beat (no-KB baseline)"
      scoreFloorDescription="How well the model answers without retrieval — the KB needs to clear this bar."
      liftLabel="vs no-KB"
    />
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
