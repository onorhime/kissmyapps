export interface DeviceInfo {
  browser?: string
  browser_version?: string
  os_name?: string
  os_version?: string
  device_type: 'mobile' | 'tablet' | 'desktop'
  device_model?: string
}

export interface HighEntropyHints {
  platform?: string
  platformVersion?: string
  model?: string
  mobile?: boolean
  fullVersionList?: { brand: string; version: string }[]
}

const BROWSERS: [name: string, pattern: RegExp][] = [
  ['Instagram', /Instagram[ /]([\d.]+)/],
  ['Facebook', /FB(?:AV|_IAB)\/([\d.]+)/],
  ['TikTok', /(?:musical_ly|BytedanceWebview)[_/]([\d.]+)/],
  ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
  ['Opera', /(?:OPR|OPiOS)\/([\d.]+)/],
  ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
  ['Chrome', /(?:CriOS|Chrome)\/([\d.]+)/],
  ['Safari', /Version\/([\d.]+).*Safari\//],
]

const dotted = (value: string) => value.replace(/_/g, '.')

/** Browser, OS and device from a user agent, refined by Client Hints when the browser offers them. */
export function parseUserAgent(
  userAgent: string,
  touchPoints = 0,
  hints?: HighEntropyHints,
): DeviceInfo {
  const info: DeviceInfo = { device_type: 'desktop' }
  for (const [name, pattern] of BROWSERS) {
    const match = userAgent.match(pattern)
    if (match) {
      info.browser = name
      info.browser_version = match[1]
      break
    }
  }

  let match: RegExpMatchArray | null
  if ((match = userAgent.match(/\((iPhone|iPod|iPad)[^)]*?OS (\d+[_\d]*)/))) {
    info.os_name = match[1] === 'iPad' ? 'iPadOS' : 'iOS'
    info.os_version = dotted(match[2])
    info.device_type = match[1] === 'iPad' ? 'tablet' : 'mobile'
    info.device_model = match[1]
  } else if (/Macintosh/.test(userAgent) && touchPoints > 1) {
    // iPadOS asks for desktop sites with a Mac user agent.
    info.os_name = 'iPadOS'
    info.device_type = 'tablet'
    info.device_model = 'iPad'
    const version = userAgent.match(/Version\/([\d.]+)/)
    if (version) info.os_version = version[1]
  } else if ((match = userAgent.match(/Android (\d+(?:\.\d+)*)/))) {
    info.os_name = 'Android'
    info.os_version = match[1]
    info.device_type = /Mobile/.test(userAgent) ? 'mobile' : 'tablet'
    const model = userAgent.match(
      /Android [\d.]+; (?:[a-z]{2}[-_][a-zA-Z]{2}; )?([^;)]+?)(?: Build\/[^;)]*)?\)/,
    )
    if (model && model[1] !== 'K' && !/^Linux/.test(model[1])) info.device_model = model[1].trim()
  } else if ((match = userAgent.match(/Windows NT (\d+\.\d+)/))) {
    info.os_name = 'Windows'
    info.os_version = { '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7' }[match[1]] ?? match[1]
  } else if ((match = userAgent.match(/Mac OS X (\d+[_.\d]*)/))) {
    info.os_name = 'macOS'
    // Browsers freeze this at 10.15.7, so only a real version from Client Hints is kept.
    const version = dotted(match[1])
    if (version !== '10.15.7') info.os_version = version
  } else if (/CrOS/.test(userAgent)) {
    info.os_name = 'ChromeOS'
  } else if (/Linux/.test(userAgent)) {
    info.os_name = 'Linux'
  }

  if (hints) {
    if (hints.platform === 'Windows' && hints.platformVersion) {
      const major = Number(hints.platformVersion.split('.')[0])
      if (major > 0) info.os_version = major >= 13 ? '11' : '10'
    } else if (hints.platform === 'macOS' && hints.platformVersion) {
      info.os_version = hints.platformVersion.replace(/\.0$/, '')
    } else if (hints.platform === 'Android' && hints.platformVersion) {
      info.os_version = hints.platformVersion
    }
    if (hints.model) info.device_model = hints.model
    const brand = hints.fullVersionList?.find(
      (entry) =>
        info.browser && entry.brand.includes(info.browser === 'Edge' ? 'Edge' : info.browser),
    )
    if (brand) info.browser_version = brand.version
  }
  return info
}
