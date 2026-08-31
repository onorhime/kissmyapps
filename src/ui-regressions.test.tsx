import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import { partnerDocuments } from './features/partner/profileData'

function openPage(page: string) {
  window.history.replaceState(null, '', `/#${page}`)
  return render(<App />)
}

describe('UI review regressions', () => {
  it('uses an associated custom error for an empty link name and Sub ID', async () => {
    const user = userEvent.setup()
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'Create sample link' }))
    await user.click(screen.getByRole('button', { name: 'Add to preview' }))
    const name = screen.getByRole('textbox', { name: 'Link name' })
    expect(name).toHaveFocus()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription('Enter a name for this sample link.')
    await user.type(name, 'Example source')
    await user.click(screen.getByRole('button', { name: 'Add to preview' }))
    const subId = screen.getByRole('textbox', { name: 'Sub ID' })
    expect(subId).toHaveFocus()
    expect(subId).toHaveAttribute('aria-invalid', 'true')
    expect(subId).toHaveAccessibleDescription(/Use 1–64 letters/)
  })

  it('uses the same custom validation for empty and whitespace-only profile names', async () => {
    const user = userEvent.setup()
    openPage('profile')
    const name = screen.getByRole('textbox', { name: 'Full name' })
    await user.clear(name)
    await user.click(screen.getByRole('button', { name: 'Save preview changes' }))
    expect(name).toHaveFocus()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription('Enter a name and public partner name.')
  })

  it('scrolls focus-loop targets into the dialog instead of leaving them clipped', async () => {
    const user = userEvent.setup()
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'Create sample link' }))
    const dialog = screen.getByRole('dialog')
    const close = screen.getByRole('button', { name: 'Close dialog' })
    const submit = screen.getByRole('button', { name: 'Add to preview' })
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 24, 358, 552))
    vi.spyOn(submit, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 700, 160, 44))
    await user.tab({ shift: true })
    expect(submit).toHaveFocus()
    expect(dialog.scrollTop).toBe(184)
    vi.spyOn(close, 'getBoundingClientRect').mockReturnValue(new DOMRect(300, -120, 44, 44))
    await user.tab()
    expect(close).toHaveFocus()
    expect(dialog.scrollTop).toBe(24)
  })

  it('keeps modal copy and pause feedback visible inside the modal', async () => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText')
    openPage('links')
    await user.click(screen.getByRole('button', { name: 'View Social bio link details' }))
    const dialog = screen.getByRole('dialog', { name: 'Social bio' })
    await user.click(within(dialog).getByRole('button', { name: 'Pause sample link' }))
    expect(within(dialog).getByRole('status')).toHaveTextContent('Sample link paused')
    await user.click(within(dialog).getByRole('button', { name: 'Copy sample URL' }))
    expect(copy).toHaveBeenCalledOnce()
    expect(within(dialog).getByRole('status')).toHaveTextContent('Sample link copied')
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).not.toBeInTheDocument()
  })

  it.each(['success', 'failure'])(
    'ignores a stale clipboard %s after switching link dialogs',
    async (outcome) => {
      const user = userEvent.setup()
      let finish!: () => void
      const pending = new Promise<void>((resolve, reject) => {
        finish = outcome === 'success' ? resolve : () => reject(new Error('Clipboard denied'))
      })
      vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(pending)
      openPage('links')
      await user.click(screen.getByRole('button', { name: 'View Social bio link details' }))
      await user.click(screen.getByRole('button', { name: 'Copy sample URL' }))
      await user.click(screen.getByRole('button', { name: 'Close dialog' }))
      await user.click(screen.getByRole('button', { name: 'View Search campaign link details' }))
      await act(async () => finish())
      const dialog = screen.getByRole('dialog', { name: 'Search campaign' })
      expect(within(dialog).getByRole('status')).toBeEmptyDOMElement()
      expect(screen.queryByRole('button', { name: 'Dismiss notification' })).not.toBeInTheDocument()
    },
  )

  it.each([
    ['documents', 'Preview Partner agreement v1'],
    ['payment', 'Preview verification steps'],
  ])('closes the %s dialog when profile history changes', async (section, button) => {
    const user = userEvent.setup()
    openPage(`profile/${section}`)
    await user.click(screen.getByRole('button', { name: button }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await act(async () => {
      window.location.hash = 'profile'
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Full name' })).toBeInTheDocument()
  })

  it('preserves an unsaved profile draft across document review', async () => {
    const user = userEvent.setup()
    openPage('profile')
    const name = screen.getByRole('textbox', { name: 'Full name' })
    await user.clear(name)
    await user.type(name, 'Unsaved example')
    await user.click(screen.getByRole('button', { name: 'Documents' }))
    await user.click(screen.getByRole('button', { name: 'Preview Partner agreement v1' }))
    await act(async () => {
      window.location.hash = 'profile'
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('Unsaved example')
  })

  it('gives each document preview action a distinct accessible name', () => {
    openPage('profile/documents')
    const buttons = screen.getAllByRole('button', { name: /^Preview .+ v\d$/ })
    expect(buttons).toHaveLength(partnerDocuments.length)
    expect(new Set(buttons.map((button) => button.getAttribute('aria-label'))).size).toBe(
      partnerDocuments.length,
    )
  })

  it('reveals the full focused profile tab in a horizontally scrollable navigation row', async () => {
    const user = userEvent.setup()
    openPage('profile')
    const nav = screen.getByLabelText('Profile sections')
    const details = screen.getByRole('button', { name: 'Partner details' })
    const payment = screen.getByRole('button', { name: 'Payout preferences' })
    await user.click(details)
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue(new DOMRect(18, 90, 284, 60))
    vi.spyOn(payment, 'getBoundingClientRect').mockReturnValue(new DOMRect(170, 100, 160, 44))
    await user.tab()
    expect(payment).toHaveFocus()
    expect(nav.scrollLeft).toBe(36)
    vi.spyOn(details, 'getBoundingClientRect').mockReturnValue(new DOMRect(-10, 100, 130, 44))
    await user.tab({ shift: true })
    expect(details).toHaveFocus()
    expect(nav.scrollLeft).toBe(0)
  })
})
