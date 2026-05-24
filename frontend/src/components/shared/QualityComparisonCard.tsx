import { CheckCircle2 } from 'lucide-react'
import { BarRow } from './BarRow'

export interface BaselinePoint {
  id: string
  label: string
  /** Score in [0, 1] or null if not measured. Null entries render as 0% bars. */
  score: number | null
  /** Bar color (hex). */
  color: string
  /** Visually emphasise (larger, bold) — typically the optimized row. */
  emphasised?: boolean
}

interface QualityComparisonCardProps {
  /**
   * Ordered list of baselines to render top-to-bottom (typically 2–4 entries).
   * For KB Autovalidate this is no-KB / default / optimized; extraction will
   * have no-tool / default / optimized; workflow no-workflow / default / optimized.
   */
  baselines: BaselinePoint[]
  /** Judge variance (stddev of judge re-runs); drives the 95% CI badge and the "significant?" check. */
  variance: number
  /**
   * Which baseline is the "default" the optimized result is compared against.
   * The lift readout shows "+N pts over default". Defaults to baseline id `default`.
   */
  defaultBaselineId?: string
  /**
   * Which baseline is the optimized result. Defaults to baseline id `optimized`.
   */
  optimizedBaselineId?: string
  /**
   * Optional secondary baseline to show as a tiny "+N pts over X" suffix
   * after the primary lift readout. Typical: the no-tool floor.
   */
  secondaryBaselineId?: string
  title?: string
  /** Lift smaller than this (pts) is flagged as inside judge noise. Default 5. */
  insignificantThreshold?: number
}

export function QualityComparisonCard({
  baselines, variance,
  defaultBaselineId = 'default',
  optimizedBaselineId = 'optimized',
  secondaryBaselineId,
  title = 'Optimization complete',
  insignificantThreshold = 5,
}: QualityComparisonCardProps) {
  const ci = variance * 1.96  // 95% confidence interval
  const defaultBaseline = baselines.find(b => b.id === defaultBaselineId)
  const optimizedBaseline = baselines.find(b => b.id === optimizedBaselineId)
  const secondaryBaseline = secondaryBaselineId
    ? baselines.find(b => b.id === secondaryBaselineId)
    : undefined

  const liftVsDefault = optimizedBaseline?.score != null && defaultBaseline?.score != null
    ? (optimizedBaseline.score - defaultBaseline.score) * 100
    : null
  const liftVsSecondary = optimizedBaseline?.score != null && secondaryBaseline?.score != null
    ? (optimizedBaseline.score - secondaryBaseline.score) * 100
    : null
  const liftSignificant = liftVsDefault != null && Math.abs(liftVsDefault / 100) > 2 * ci

  return (
    <div style={{
      padding: 16, backgroundColor: '#1f1f1f',
      border: '1px solid #2e2e2e', borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <CheckCircle2 size={16} style={{ color: '#22c55e' }} />
        <h3 style={{ margin: 0, fontSize: 14, color: '#fff' }}>{title}</h3>
        {ci > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: '#666' }}>
            95% CI: ±{(ci * 100).toFixed(1)}pts
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {baselines.map(b => (
          <BarRow
            key={b.id}
            label={b.label}
            pct={(b.score ?? 0) * 100}
            color={b.color}
            emphasised={b.emphasised}
          />
        ))}
      </div>

      {liftVsDefault != null && (
        <div style={{
          marginTop: 14, padding: '10px 12px',
          backgroundColor: liftVsDefault > 0 ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
          border: '1px solid ' + (liftVsDefault > 0 ? 'rgba(34, 197, 94, 0.25)' : 'rgba(239, 68, 68, 0.25)'),
          borderRadius: 6,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 18, fontWeight: 700,
              color: liftVsDefault > 0 ? '#22c55e' : '#ef4444',
            }}>
              {liftVsDefault > 0 ? '+' : ''}{liftVsDefault.toFixed(0)}pts
            </span>
            <span style={{ fontSize: 12, color: '#aaa' }}>over {defaultBaseline?.label ?? 'default'}</span>
            {liftVsSecondary != null && secondaryBaseline && (
              <>
                <span style={{ fontSize: 12, color: '#666' }}>·</span>
                <span style={{ fontSize: 12, color: '#aaa' }}>
                  +{liftVsSecondary.toFixed(0)}pts over {secondaryBaseline.label}
                </span>
              </>
            )}
          </div>
          {!liftSignificant && Math.abs(liftVsDefault) < insignificantThreshold && (
            <div style={{ marginTop: 6, fontSize: 11, color: '#f59e0b' }}>
              ⚠ Improvement is within judge noise — consider this "no significant change."
            </div>
          )}
        </div>
      )}
    </div>
  )
}
