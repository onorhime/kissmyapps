import {
  captureAttributionFromUrl,
  FunnelIntegrationError,
  sendBrowserEvent,
  type AttributionCaptureResult,
  type BrowserEventName,
  type BrowserEventOptions,
  type BrowserEventReceipt,
} from '../../integrations/funnel/browser-attribution.ts'

export const BROWSER_EVENTS_ENDPOINT =
  'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/browser-events'

const INTERACTIVE_EVENTS = new Set<BrowserEventName>([
  'funnel_started',
  'payment_viewed',
  'app_store_clicked',
])

interface DemoTracker {
  capture: () => AttributionCaptureResult
  send: (options: BrowserEventOptions) => Promise<BrowserEventReceipt>
}

interface DemoFunnelController {
  ready: Promise<void>
  dispose: () => void
}

interface DemoFunnelOptions {
  document?: Document
  pagePath?: string
  tracker?: DemoTracker
}

interface DemoElements {
  status: HTMLElement
  statusTitle: HTMLElement
  statusMessage: HTMLElement
  buttons: HTMLButtonElement[]
}

const defaultTracker: DemoTracker = {
  capture: () => captureAttributionFromUrl(),
  send: (options) => sendBrowserEvent(options),
}

function requireElement<T extends HTMLElement>(document: Document, selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Demo funnel is missing required element: ${selector}`)
  return element
}

function elementsFrom(document: Document): DemoElements {
  return {
    status: requireElement(document, '#demo-status'),
    statusTitle: requireElement(document, '#demo-status-title'),
    statusMessage: requireElement(document, '#demo-status-message'),
    buttons: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-demo-event]')),
  }
}

function updateStatus(
  elements: DemoElements,
  state: 'checking' | 'ready' | 'missing' | 'error',
  title: string,
  message: string,
): void {
  elements.status.dataset.state = state
  elements.statusTitle.textContent = title
  elements.statusMessage.textContent = message
}

function setButtonsEnabled(elements: DemoElements, enabled: boolean): void {
  for (const button of elements.buttons) {
    button.disabled = !enabled || button.dataset.complete === 'true'
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof FunnelIntegrationError) {
    if (error.code === 'origin_not_allowed') {
      return 'This demo origin is not authorized by the attribution service.'
    }
    if (error.code === 'click_unavailable') {
      return 'The click reference is unavailable or is not active.'
    }
    if (error.status !== null) {
      return `The attribution service rejected the request (${error.code}, HTTP ${error.status}).`
    }
    return `The attribution event could not be prepared (${error.code}).`
  }
  return 'The attribution service could not be reached. Check the connection and try the partner link again.'
}

function readEventName(button: HTMLButtonElement): BrowserEventName | null {
  const eventName = button.dataset.demoEvent
  return INTERACTIVE_EVENTS.has(eventName as BrowserEventName)
    ? (eventName as BrowserEventName)
    : null
}

export function initializeDemoFunnel(options: DemoFunnelOptions = {}): DemoFunnelController {
  const document = options.document ?? globalThis.document
  const tracker = options.tracker ?? defaultTracker
  const pagePath = options.pagePath ?? globalThis.location.pathname
  const elements = elementsFrom(document)
  const abortController = new AbortController()
  let clickId: string | null = null
  let activeEvent = false

  setButtonsEnabled(elements, false)

  const sendEvent = async (
    eventName: BrowserEventName,
    button?: HTMLButtonElement,
  ): Promise<void> => {
    if (!clickId || activeEvent) return
    activeEvent = true
    if (button) {
      setButtonsEnabled(elements, false)
      button.removeAttribute('data-complete')
      button.textContent = 'Recording…'
    }

    try {
      const receipt = await tracker.send({
        endpoint: BROWSER_EVENTS_ENDPOINT,
        eventName,
        clickId,
        properties: {
          page_name: 'tracking_demo',
          page_path: pagePath,
        },
        signal: abortController.signal,
      })

      if (eventName === 'landing_viewed') {
        updateStatus(
          elements,
          'ready',
          receipt.duplicate ? 'Attribution already connected' : 'Attribution connected',
          'The landing event was accepted. The three demo events are now ready to test.',
        )
        setButtonsEnabled(elements, true)
      } else if (button) {
        button.dataset.complete = 'true'
        button.textContent = receipt.duplicate ? 'Event already recorded' : 'Event recorded'
        updateStatus(
          elements,
          'ready',
          receipt.duplicate ? 'Demo event already recorded' : 'Demo event recorded',
          `${eventName} was accepted for this attributed click. You can continue the test sequence.`,
        )
        setButtonsEnabled(elements, true)
      }
    } catch (error) {
      updateStatus(elements, 'error', 'Tracking event not accepted', safeErrorMessage(error))
      setButtonsEnabled(elements, eventName !== 'landing_viewed')
      if (button) button.textContent = 'Try recording again'
    } finally {
      activeEvent = false
      if (button && button.dataset.complete !== 'true') setButtonsEnabled(elements, true)
    }
  }

  const listeners = elements.buttons.map((button) => {
    const listener = (): void => {
      const eventName = readEventName(button)
      if (eventName) void sendEvent(eventName, button)
    }
    button.addEventListener('click', listener)
    return { button, listener }
  })

  let capture: AttributionCaptureResult
  try {
    capture = tracker.capture()
  } catch (error) {
    updateStatus(elements, 'error', 'Attribution could not be checked', safeErrorMessage(error))
    return {
      ready: Promise.resolve(),
      dispose: () => {
        abortController.abort()
        for (const { button, listener } of listeners) button.removeEventListener('click', listener)
      },
    }
  }

  clickId = capture.clickId
  if (!clickId) {
    updateStatus(
      elements,
      'missing',
      'Open this page from a partner link',
      'No active click reference was found. Generate a source link and follow its go.kissmyapps.dev redirect to run this test.',
    )
  } else {
    updateStatus(
      elements,
      'checking',
      capture.captured ? 'Partner click captured' : 'Stored attribution found',
      'Confirming the landing event with the attribution service…',
    )
  }

  const ready = clickId ? sendEvent('landing_viewed') : Promise.resolve()
  return {
    ready,
    dispose: () => {
      abortController.abort()
      for (const { button, listener } of listeners) button.removeEventListener('click', listener)
    },
  }
}
