import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'vitest-axe'
import 'vitest-axe/extend-expect'
import { Toggle } from './components/shared/Toggle'
import { ConfirmDialog } from './components/shared/ConfirmDialog'
import { ErrorBanner } from './components/shared/RunBanners'

// Standing automated accessibility gate (WCAG pass 3). Renders representative
// remediated primitives and asserts zero axe-core violations, so a11y
// regressions on these surface in CI. Expand coverage over time.
describe('a11y — no axe violations', () => {
  it('Toggle (role=switch)', async () => {
    const { container } = render(
      <Toggle label="Enable feature" description="Turns the thing on" checked={false} onChange={() => {}} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('ConfirmDialog (dialog + focus trap)', async () => {
    const { container } = render(
      <ConfirmDialog
        open
        title="Delete item?"
        message="This cannot be undone."
        destructive
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('ErrorBanner (role=alert)', async () => {
    const { container } = render(<ErrorBanner message="Something went wrong" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
