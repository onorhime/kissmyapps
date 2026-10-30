// What React Native itself can tell about the device, with no native module to link.

import { Dimensions, NativeModules, Platform } from 'react-native'
import type { DeviceInfo } from './client'

function timezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function language(): string {
  const fromSettings: unknown =
    Platform.OS === 'ios'
      ? (NativeModules.SettingsManager?.settings?.AppleLocale ??
        NativeModules.SettingsManager?.settings?.AppleLanguages?.[0])
      : NativeModules.I18nManager?.localeIdentifier
  if (typeof fromSettings === 'string' && fromSettings)
    return fromSettings.replace(/_/g, '-').split('@')[0]
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    return 'en'
  }
}

export function deviceInfo(): DeviceInfo {
  const screen = Dimensions.get('screen')
  const shortSide = Math.min(screen.width, screen.height)
  const constants = (Platform.constants ?? {}) as Record<string, unknown>
  if (Platform.OS === 'ios') {
    const pad = Platform.isPad === true || constants.interfaceIdiom === 'pad'
    return {
      platform: 'ios',
      os_name: pad ? 'iPadOS' : 'iOS',
      os_version: String(constants.osVersion ?? Platform.Version),
      device_type: pad ? 'tablet' : 'mobile',
      device_model: pad ? 'iPad' : 'iPhone',
      screen_width: screen.width,
      screen_height: screen.height,
      timezone: timezone(),
      language: language(),
    }
  }
  const model = typeof constants.Model === 'string' ? constants.Model : undefined
  return {
    platform: 'android',
    os_name: 'Android',
    os_version: String(constants.Release ?? Platform.Version),
    device_type: shortSide >= 600 ? 'tablet' : 'mobile',
    device_model: model,
    screen_width: screen.width,
    screen_height: screen.height,
    timezone: timezone(),
    language: language(),
  }
}
