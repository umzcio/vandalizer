/**
 * Budget tier presets for autovalidate optimization runs.
 *
 * Each domain (KB / extraction / workflow) defines its own array and passes it
 * to the shared BudgetTierPicker. Tier sizes are domain-specific because trial
 * costs differ: workflow trials run a full multi-step flow per trial, so the
 * same token budget yields fewer trials than for KB or extraction.
 */
export interface BudgetTier {
  id: string
  label: string
  tokens: number
  /** Short description shown alongside the tier label, e.g. "~25 trials". */
  trialsEstimate: string
  /** Wall-time estimate, e.g. "10–20 min". */
  timeEstimate: string
}

export const KB_BUDGET_TIERS: readonly BudgetTier[] = [
  { id: 'conservative', label: 'Conservative', tokens: 500_000, trialsEstimate: '~5 trials', timeEstimate: '2–5 min' },
  { id: 'standard', label: 'Standard', tokens: 2_500_000, trialsEstimate: '~25 trials', timeEstimate: '10–20 min' },
  { id: 'thorough', label: 'Thorough', tokens: 10_000_000, trialsEstimate: '~100 trials', timeEstimate: '45–90 min' },
] as const


/**
 * Extraction tiers map to `max_candidates` (the # of configs to try) rather
 * than a strict token budget. The `tokens` field carries an order-of-magnitude
 * estimate for cost display when System Config has model cost fields; the
 * actual stop signal is candidate count.
 *
 * Each candidate runs `num_runs` extractions per test case + judge calls if
 * enabled, so cost scales with test case count too. The estimates below
 * assume ~3 test cases and judge=on.
 */
export interface ExtractionBudgetTier extends BudgetTier {
  /** Number of candidate configs to try in the sweep. */
  maxCandidates: number
}

export const EXTRACTION_BUDGET_TIERS: readonly ExtractionBudgetTier[] = [
  { id: 'quick', label: 'Quick', maxCandidates: 4, tokens: 200_000, trialsEstimate: '~4 trials', timeEstimate: '3–6 min' },
  { id: 'standard', label: 'Standard', maxCandidates: 8, tokens: 600_000, trialsEstimate: '~8 trials', timeEstimate: '8–15 min' },
  { id: 'thorough', label: 'Thorough', maxCandidates: 12, tokens: 1_500_000, trialsEstimate: '~12 trials', timeEstimate: '20–35 min' },
] as const
