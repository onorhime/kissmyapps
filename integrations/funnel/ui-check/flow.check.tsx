import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
// External funnel sources are deliberately resolved by this isolated check config.
// @ts-expect-error external alias is set by ui-check/vitest.config.ts
import { PartnerSignupFunnel } from '@/components/partner/PartnerSignupFunnel'
// @ts-expect-error external alias is set by ui-check/vitest.config.ts
import { WaitlistFunnel } from '@/components/waitlist/WaitlistFunnel'
// @ts-expect-error external alias is set by ui-check/vitest.config.ts
import {
  captureAttributionFromUrl,
  requestCheckout,
  sendBrowserEvent,
} from '@/lib/kma/browser-attribution'

vi.mock('@/lib/analytics', () => ({ setAnalyticsConsent: vi.fn(), track: vi.fn() }))
const stripeMock = vi.hoisted(() => ({
  onComplete: null as null | (() => void),
  mount: vi.fn(),
  destroy: vi.fn(),
}))
vi.mock('@stripe/stripe-js', () => ({
  loadStripe: () =>
    Promise.resolve({
      createEmbeddedCheckoutPage: (options: { onComplete: () => void }) => {
        stripeMock.onComplete = options.onComplete
        return Promise.resolve({ mount: stripeMock.mount, destroy: stripeMock.destroy })
      },
    }),
}))
vi.mock('@/lib/kma/browser-attribution', async (original) => ({
  ...(await original<object>()),
  captureAttributionFromUrl: vi.fn(),
  sendBrowserEvent: vi.fn(),
  requestCheckout: vi.fn(),
}))
const offer = {
  key: 'monthly',
  version: 1,
  name: 'BC Learn monthly',
  currency: 'USD',
  unit_amount_minor: 100,
  billing_mode: 'subscription',
  interval: 'month',
  interval_count: 1,
}
let saveOk = true
let checkoutEnabled = true
let fetcher: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  saveOk = true
  checkoutEnabled = true
  vi.mocked(captureAttributionFromUrl).mockReturnValue({ clickId: 'c'.repeat(48) })
  vi.mocked(sendBrowserEvent).mockResolvedValue({ accepted: true })
  vi.mocked(requestCheckout).mockRejectedValue(new Error('mock provider unavailable'))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('scrollTo', vi.fn())
  fetcher = vi.fn(async (url: string) => {
    if (url === '/api/waitlist')
      return Response.json({ ok: saveOk }, { status: saveOk ? 200 : 503 })
    if (url === '/api/partner/offer')
      return Response.json({ offer, checkout_enabled: checkoutEnabled })
    if (url === '/api/partner/status') return Response.json({ status: 'no_payment_required' })
    throw new Error(`Unexpected network request blocked: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function toEmail(Component = PartnerSignupFunnel) {
  render(<Component />)
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
  fireEvent.click(screen.getByRole('button', { name: /Start speaking/ }))
  fireEvent.click(screen.getByRole('radio', { name: /Grow my career/ }))
  fireEvent.click(await screen.findByRole('radio', { name: /I freeze even/ }))
  fireEvent.click(await screen.findByRole('radio', { name: /Small live speaking groups/ }))
  await screen.findByLabelText('Email address')
  expect(screen.queryByText('Take the next step.')).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
}
function submitEmail() {
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: 'fixture@example.invalid' },
  })
  fireEvent.click(screen.getByRole('button', { name: /Get early access/ }))
}
describe('original speak duplicate with a post-email paywall', () => {
  it('preserves the exact original first-screen markup except its extra progress step', () => {
    const original = renderToStaticMarkup(createElement(WaitlistFunnel))
    const copy = renderToStaticMarkup(createElement(PartnerSignupFunnel))
    const normalize = (html: string) =>
      html
        .replace(/aria-valuemax="[56]"/g, 'aria-valuemax="n"')
        .replace(/<div class="wl-progress"[^>]*>.*?<\/div>/, '<div class="wl-progress"></div>')
    expect(normalize(copy)).toBe(normalize(original))
  })
  it('requires a saved email, then shows the verified $1 offer and terms before checkout', async () => {
    await toEmail()
    fireEvent.click(screen.getByRole('button', { name: /Get early access/ }))
    expect(screen.getByText('Please enter a valid email address.')).toBeTruthy()
    expect(fetcher).not.toHaveBeenCalled()
    submitEmail()
    await screen.findByText('$1.00')
    expect(screen.queryByText('You’re on the list.')).toBeNull()
    const payment = screen.getByRole('button', { name: /Continue to \$0/ }) as HTMLButtonElement
    expect(payment.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(payment)
    await waitFor(() => expect(requestCheckout).toHaveBeenCalledTimes(1))
    const input = vi.mocked(requestCheckout).mock.calls[0][0]
    expect(input).toMatchObject({ clickId: 'c'.repeat(48), offerKey: 'monthly' })
    expect(input.customerEmail).toBe('fixture@example.invalid')
    await screen.findByText(/We couldn’t open checkout/)
    fireEvent.click(payment)
    await waitFor(() => expect(requestCheckout).toHaveBeenCalledTimes(2))
    expect(vi.mocked(requestCheckout).mock.calls[1][0].idempotencyKey).toBe(input.idempotencyKey)
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe(
      'fixture@example.invalid',
    )
    expect(JSON.stringify(localStorage)).not.toContain('fixture@example.invalid')
    expect(JSON.stringify(sessionStorage)).not.toContain('fixture@example.invalid')
    expect(JSON.stringify(vi.mocked(sendBrowserEvent).mock.calls)).not.toContain(
      'fixture@example.invalid',
    )
  })
  it('does not open the paywall when saving the email fails, and can retry', async () => {
    saveOk = false
    await toEmail()
    submitEmail()
    await screen.findByText(/We couldn’t save your place/)
    expect(screen.queryByText('Take the next step.')).toBeNull()
    expect(fetcher.mock.calls.every((call) => call[0] === '/api/waitlist')).toBe(true)
    saveOk = true
    submitEmail()
    await screen.findByText('$1.00')
  })
  it('mounts inline checkout, automatically verifies completion, and never stores its secret', async () => {
    const clientSecret = 'cs_live_InlineFixture123_secret_ephemeral'
    vi.mocked(requestCheckout).mockResolvedValue({
      ui_mode: 'embedded',
      checkout_url: null,
      client_secret: clientSecret,
      session_id: 'cs_live_InlineFixture123',
      publishable_key: 'pk_live_InlineFixture123456',
      attempt_id: 'a'.repeat(48),
      expires_at: '2027-01-01T00:00:00Z',
      request_id: 'fixture',
    })
    await toEmail()
    submitEmail()
    await screen.findByText('$1.00')
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /Continue to \$0/ }))
    await waitFor(() => expect(stripeMock.mount).toHaveBeenCalledTimes(1))
    expect(JSON.stringify(sessionStorage)).not.toContain(clientSecret)
    expect(JSON.stringify(localStorage)).not.toContain(clientSecret)
    await act(async () => stripeMock.onComplete?.())
    await screen.findByText('Your no-charge test subscription is confirmed.')
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(requestCheckout).toHaveBeenCalledTimes(1)
    expect(stripeMock.destroy).toHaveBeenCalled()
  })
  it('does not enable payment for organic visits without partner attribution', async () => {
    vi.mocked(captureAttributionFromUrl).mockReturnValue({ clickId: null })
    await toEmail()
    submitEmail()
    await screen.findByText(/Open this funnel through a partner tracking link/)
    expect(
      (screen.getByRole('button', { name: 'Checkout not ready' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(requestCheckout).not.toHaveBeenCalled()
  })
  it('keeps checkout disabled when the server has not enabled it', async () => {
    checkoutEnabled = false
    await toEmail()
    submitEmail()
    await screen.findByText('Checkout is not enabled for this test yet.')
    expect(
      (screen.getByRole('button', { name: /Continue to \$0/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
  it('leaves the original speak waitlist ending on confirmation without checkout', async () => {
    await toEmail(WaitlistFunnel)
    submitEmail()
    await screen.findByText('You’re on the list.')
    expect(screen.queryByText('Take the next step.')).toBeNull()
    expect(fetcher.mock.calls.every((call) => call[0] === '/api/waitlist')).toBe(true)
    expect(captureAttributionFromUrl).not.toHaveBeenCalled()
  })
})
