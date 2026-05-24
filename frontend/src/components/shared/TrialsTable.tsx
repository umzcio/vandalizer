import { useState } from 'react'
import type { ReactNode } from 'react'

export interface SortOption<TTrial> {
  key: string
  label: string
  /** Comparator passed to Array.sort; return negative if a should come first. */
  compare: (a: TTrial, b: TTrial) => number
}

interface TrialsTableProps<TTrial> {
  trials: TTrial[]
  sortOptions: SortOption<TTrial>[]
  /** Sort key to use initially. Defaults to the first sort option. */
  defaultSortKey?: string
  /** Domain-specific row renderer. Caller controls full row layout. */
  renderRow: (trial: TTrial) => ReactNode
  getRowKey: (trial: TTrial) => string
  title?: string
  maxHeight?: number | string
}

/**
 * Generic scrollable list of optimization trials with a sort-by dropdown.
 *
 * Each domain (KB / extraction / workflow) provides its own row renderer and
 * sort options; the component only owns the chrome (header, dropdown, scroll
 * container) and the sort state.
 */
export function TrialsTable<TTrial>({
  trials, sortOptions,
  defaultSortKey,
  renderRow, getRowKey,
  title = 'Trials',
  maxHeight = 320,
}: TrialsTableProps<TTrial>) {
  const initialKey = defaultSortKey ?? sortOptions[0]?.key ?? ''
  const [sortKey, setSortKey] = useState<string>(initialKey)
  const sorter = sortOptions.find(o => o.key === sortKey) ?? sortOptions[0]
  const sorted = sorter ? [...trials].sort(sorter.compare) : trials

  return (
    <div style={{
      padding: 14, backgroundColor: '#1f1f1f',
      border: '1px solid #2e2e2e', borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>
          {title} ({trials.length})
        </span>
        {sortOptions.length > 1 && (
          <>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#666' }}>Sort by:</span>
            <select
              value={sortKey}
              onChange={e => setSortKey(e.target.value)}
              style={{
                background: '#1a1a1a', color: '#e5e5e5', border: '1px solid #333',
                borderRadius: 4, padding: '2px 6px', fontSize: 11, fontFamily: 'inherit',
              }}
            >
              {sortOptions.map(o => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight, overflowY: 'auto' }}>
        {sorted.map(t => (
          <div key={getRowKey(t)}>
            {renderRow(t)}
          </div>
        ))}
      </div>
    </div>
  )
}
