# The optional native module KissMyAppsAttribution for iOS: the device key, the Apple Ads
# token and the clipboard handoff for install attribution. Linked by autolinking with
# `pod install`; without it the SDK still runs, minus those fields.
require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'KissMyAppsReactNative'
  s.version          = package['version']
  s.summary          = 'Native part of @kissmyappss/react-native: device key and Apple Ads attribution.'
  s.homepage         = package['homepage']
  s.license          = { :type => package['license'], :file => 'LICENSE' }
  s.author           = 'KissMyApps'
  s.source           = { :path => '.' }
  s.platforms        = { :ios => '12.4' }
  s.swift_version    = '5.0'
  s.source_files     = 'ios/**/*.{h,m,swift}'
  s.resource_bundles = { 'KissMyAppsReactNativePrivacy' => ['ios/PrivacyInfo.xcprivacy'] }
  # AdServices is there from iOS 14.3; older systems skip Apple Ads.
  s.weak_frameworks  = 'AdServices'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }

  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
  end
end
