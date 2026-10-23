import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { markFormSaved, observeForm, useFormNavigationGuard } from './useFormNavigationGuard'

function Fixture({
  leave,
  pending = false,
  scope = 'account-a',
}: {
  leave: () => void
  pending?: boolean
  scope?: string
}) {
  const guard = useFormNavigationGuard(true, scope)
  const [name, setName] = useState('')
  return (
    <div onFocusCapture={guard.capture} onPointerDownCapture={guard.capture}>
      <form
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault()
          markFormSaved(event.currentTarget)
        }}
      >
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button>Save</button>
      </form>
      <form onSubmit={(event) => event.preventDefault()}>
        <label>
          Other draft
          <input />
        </label>
      </form>
      <button onClick={() => guard.request(leave)}>Another page</button>
      {guard.dialog}
    </div>
  )
}

it('protects drafts during app navigation, returns focus on cancel, and leaves only after discard', async () => {
  const user = userEvent.setup()
  const leave = vi.fn()
  render(<Fixture leave={leave} />)
  await user.type(screen.getByLabelText('Name'), 'Keep my draft')
  await user.click(screen.getByText('Another page'))
  expect(screen.getByRole('dialog', { name: 'Leave unsaved changes?' })).toBeVisible()
  expect(leave).not.toHaveBeenCalled()
  await user.click(screen.getByText('Keep editing'))
  expect(screen.getByLabelText('Name')).toHaveValue('Keep my draft')
  await waitFor(() => expect(screen.getByText('Another page')).toHaveFocus())
  await user.click(screen.getByText('Another page'))
  await user.click(screen.getByText('Discard changes and leave'))
  expect(leave).toHaveBeenCalledTimes(1)
})

it('marks only the saved form clean and keeps unrelated drafts protected', async () => {
  const user = userEvent.setup()
  const leave = vi.fn()
  render(<Fixture leave={leave} />)
  await user.type(screen.getByLabelText('Name'), 'Saved name')
  await user.type(screen.getByLabelText('Other draft'), 'Unsaved')
  await user.click(screen.getByText('Save'))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await user.click(screen.getByText('Another page'))
  expect(screen.getByRole('dialog', { name: 'Leave unsaved changes?' })).toBeVisible()
  await user.click(screen.getByText('Keep editing'))
  await user.clear(screen.getByLabelText('Other draft'))
  await user.click(screen.getByText('Another page'))
  expect(leave).toHaveBeenCalledTimes(1)
})

it('does not offer misleading discard navigation while a write is pending', async () => {
  const user = userEvent.setup()
  const leave = vi.fn()
  render(<Fixture leave={leave} pending />)
  await user.click(screen.getByText('Another page'))
  expect(screen.getByRole('dialog', { name: 'Save in progress' })).toBeVisible()
  expect(screen.queryByText('Discard changes and leave')).not.toBeInTheDocument()
  await user.click(screen.getByText('Stay on this page'))
  expect(leave).not.toHaveBeenCalled()
})

it('warns before a full reload and clears tracked drafts when account scope changes', async () => {
  const user = userEvent.setup()
  const leave = vi.fn()
  const { rerender } = render(<Fixture leave={leave} />)
  await user.type(screen.getByLabelText('Name'), 'Account A')
  const unload = new Event('beforeunload', { cancelable: true })
  fireEvent(window, unload)
  expect(unload.defaultPrevented).toBe(true)
  rerender(<Fixture leave={leave} scope="account-b" />)
  await user.click(screen.getByText('Another page'))
  expect(leave).toHaveBeenCalledTimes(1)
})

it('retains the original baseline when a form is populated for editing before it receives focus', async () => {
  const user = userEvent.setup()
  const leave = vi.fn()
  render(<Fixture leave={leave} />)
  const input = screen.getByLabelText('Other draft') as HTMLInputElement
  observeForm(input.closest('form'))
  fireEvent.change(input, { target: { value: 'Existing record' } })
  await user.click(input)
  // Cancelling the edit restores the original blank create form.
  fireEvent.change(input, { target: { value: '' } })
  await user.click(screen.getByText('Another page'))
  expect(leave).toHaveBeenCalledTimes(1)
})
