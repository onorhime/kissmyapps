/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Vitest stubs CSS imports by default. Read the real source so this guard cannot
// silently pass against an empty stylesheet or an unconfigured CSS transform.
const baseStyles = readFileSync('src/index.css', 'utf8')
const appStyles = readFileSync('src/App.css', 'utf8')
const authStyles = readFileSync('src/features/auth/AuthPreview.css', 'utf8')
const brandStyles = readFileSync('src/brand.css', 'utf8')

function token(name: string) {
  const value = baseStyles.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))?.[1]
  if (!value) throw new Error(`Missing color token: ${name}`)
  return value
}

function luminance(hex: string) {
  const [red, green, blue] = hex
    .slice(1)
    .match(/../g)!
    .map((part) => parseInt(part, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('reviewed accessibility color tokens (not a rendered-page audit)', () => {
  it.each(['#111111', '#222222', '#2e2e2e', '#3b3b3b'])(
    'keeps muted text above 4.5:1 on %s',
    (background) => expect(contrast(token('brand-muted'), background)).toBeGreaterThanOrEqual(4.5),
  )

  it.each(['#111111', '#222222', '#2e2e2e', '#3b3b3b'])(
    'keeps interactive field boundaries above 3:1 on %s',
    (background) => expect(contrast(token('control-border'), background)).toBeGreaterThanOrEqual(3),
  )

  it.each(['#111111', '#222222', '#2e2e2e', '#3b3b3b'])(
    'keeps the focus indicator above 3:1 on %s',
    (background) =>
      expect(contrast(token('brand-light-blue'), background)).toBeGreaterThanOrEqual(3),
  )

  it('loads the reviewed dark-brand overrides after the legacy component styles', () => {
    expect(baseStyles).toContain('outline: 3px solid var(--focus)')
    expect(baseStyles).toContain('--focus: #66ccff')
    expect(brandStyles).toContain('background: var(--brand-bg-deep)')
    expect(brandStyles).toContain('color: var(--brand-muted)')
    expect(brandStyles).toContain("background: url('/kissmyapps-mark.svg')")
    expect(appStyles.length).toBeGreaterThan(0)
    expect(authStyles.length).toBeGreaterThan(0)
  })

  it('keeps the narrow authentication card on a dark branded surface', () => {
    expect(authStyles).toContain('background: #fff')
    expect(brandStyles).toMatch(
      /@media \(max-width: 800px\)[\s\S]*?\.auth-form-panel \{[\s\S]*?background: var\(--brand-card\);[\s\S]*?color: var\(--brand-text\);/,
    )
  })

  it('keeps both switch-thumb states distinguishable from their track', () => {
    expect(contrast(token('brand-muted'), token('brand-control'))).toBeGreaterThanOrEqual(3)
    expect(contrast(token('brand-bg-deep'), token('brand-green'))).toBeGreaterThanOrEqual(3)
  })

  it('recolors the workspace context for the dark branded surface', () => {
    expect(brandStyles).toContain('.workspace-context .context-label')
    expect(brandStyles).toContain('color: var(--brand-light-blue)')
    expect(brandStyles).toContain('-webkit-text-fill-color: var(--brand-text)')
    expect(contrast(token('brand-light-blue'), token('brand-control'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(token('brand-muted'), token('brand-control'))).toBeGreaterThanOrEqual(4.5)
  })
})
