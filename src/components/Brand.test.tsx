import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Brand } from './Brand'

describe('Brand', () => {
  it('uses the canonical KissMyApps mark and optional portal context', () => {
    const { container } = render(<Brand context="Partners" />)

    expect(screen.getByText('Kissmyapps')).toBeInTheDocument()
    expect(screen.getByText('.dev')).toBeInTheDocument()
    expect(screen.getByText('Partners')).toBeInTheDocument()
    expect(container.querySelector('img')).toHaveAttribute('src', '/favicon.svg')
    expect(container.querySelector('img')).toHaveAttribute('alt', '')
  })
})
