import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ActionNotice } from './ActionNotice'

afterEach(() => vi.useRealTimers())

it('announces a success in the shared host and dismisses after six seconds', () => {
  vi.useFakeTimers()
  const dismiss = vi.fn()
  render(
    <StrictMode>
      <ActionNotice notice={{ kind: 'success', message: 'Saved changes.' }} onDismiss={dismiss} />
    </StrictMode>,
  )
  act(() => vi.advanceTimersByTime(0))
  expect(screen.getByRole('status')).toHaveTextContent('Saved changes.')
  expect(document.getElementById('action-notice-stack')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(6000))
  expect(dismiss).toHaveBeenCalledTimes(1)
})

it('pauses success dismissal while reading or focusing the notification', () => {
  vi.useFakeTimers()
  const dismiss = vi.fn()
  render(<ActionNotice notice={{ kind: 'success', message: 'Saved.' }} onDismiss={dismiss} />)
  act(() => vi.advanceTimersByTime(0))
  fireEvent.pointerEnter(screen.getByRole('status').parentElement!)
  act(() => vi.advanceTimersByTime(9000))
  expect(dismiss).not.toHaveBeenCalled()
  fireEvent.pointerLeave(screen.getByRole('status').parentElement!)
  fireEvent.focus(screen.getByRole('button', { name: 'Dismiss notification' }))
  act(() => vi.advanceTimersByTime(9000))
  expect(dismiss).not.toHaveBeenCalled()
})

it('retains errors until dismissed and re-announces an identical new outcome', () => {
  vi.useFakeTimers()
  const dismiss = vi.fn()
  const { rerender } = render(
    <ActionNotice notice={{ kind: 'error', message: 'Try again.' }} onDismiss={dismiss} />,
  )
  act(() => vi.advanceTimersByTime(20_000))
  expect(dismiss).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('Try again.')
  rerender(<ActionNotice notice={{ kind: 'error', message: 'Try again.' }} onDismiss={dismiss} />)
  expect(screen.getByRole('alert')).toBeEmptyDOMElement()
  act(() => vi.advanceTimersByTime(0))
  expect(screen.getByRole('alert')).toHaveTextContent('Try again.')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
  expect(dismiss).toHaveBeenCalledTimes(1)
})
