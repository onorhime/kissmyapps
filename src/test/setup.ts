import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// jsdom has no layout engine. Responsive rendering still needs browser review.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverStub)
// Route focus deliberately scrolls the document; jsdom cannot implement this.
window.scrollTo = vi.fn()

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
