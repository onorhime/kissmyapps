import { describe, expect, it } from 'vitest'
import { parseUserAgent } from './src/device'

describe('parseUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      {
        browser: 'Safari',
        browser_version: '18.1',
        os_name: 'iOS',
        os_version: '18.1',
        device_type: 'mobile',
        device_model: 'iPhone',
      },
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
      {
        browser: 'Chrome',
        browser_version: '129.0.6668.69',
        os_name: 'iPadOS',
        os_version: '17.4',
        device_type: 'tablet',
        device_model: 'iPad',
      },
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      {
        browser: 'Samsung Internet',
        browser_version: '25.0',
        os_name: 'Android',
        os_version: '14',
        device_type: 'mobile',
        device_model: 'SM-S918B',
      },
    ],
    [
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
      {
        browser: 'Chrome',
        browser_version: '129.0.0.0',
        os_name: 'Android',
        os_version: '10',
        device_type: 'mobile',
      },
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; Pixel Tablet Build/TQ3A.230805.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      {
        browser: 'Chrome',
        browser_version: '120.0.0.0',
        os_name: 'Android',
        os_version: '13',
        device_type: 'tablet',
        device_model: 'Pixel Tablet',
      },
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.65',
      {
        browser: 'Edge',
        browser_version: '129.0.2792.65',
        os_name: 'Windows',
        os_version: '10',
        device_type: 'desktop',
      },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
      {
        browser: 'Firefox',
        browser_version: '131.0',
        os_name: 'macOS',
        os_version: '10.15',
        device_type: 'desktop',
      },
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      { browser: 'Safari', browser_version: '18.0', os_name: 'macOS', device_type: 'desktop' },
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.31.94',
      {
        browser: 'Instagram',
        browser_version: '350.0.0.31.94',
        os_name: 'iOS',
        os_version: '17.5',
        device_type: 'mobile',
        device_model: 'iPhone',
      },
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      {
        browser: 'Chrome',
        browser_version: '129.0.0.0',
        os_name: 'ChromeOS',
        device_type: 'desktop',
      },
    ],
  ])('reads %s', (userAgent, expected) => {
    expect(parseUserAgent(userAgent)).toEqual(expected)
  })

  it('treats a touch Mac as an iPad', () => {
    const info = parseUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      5,
    )
    expect(info).toMatchObject({
      os_name: 'iPadOS',
      os_version: '17.4',
      device_type: 'tablet',
      device_model: 'iPad',
    })
  })

  it('takes exact versions and models from Client Hints', () => {
    const windows = parseUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      0,
      {
        platform: 'Windows',
        platformVersion: '15.0.0',
        fullVersionList: [{ brand: 'Google Chrome', version: '129.0.6668.90' }],
      },
    )
    expect(windows).toMatchObject({ os_version: '11', browser_version: '129.0.6668.90' })
    const mac = parseUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      0,
      { platform: 'macOS', platformVersion: '14.6.0' },
    )
    expect(mac.os_version).toBe('14.6')
    const android = parseUserAgent(
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
      0,
      { platform: 'Android', platformVersion: '15.0.0', model: 'Pixel 8' },
    )
    expect(android).toMatchObject({ os_version: '15.0.0', device_model: 'Pixel 8' })
  })
})
