# The iOS side of the KissMyApps Flutter plugin, for apps that use CocoaPods. Apps on Swift
# Package Manager use kissmyapps/Package.swift instead.
Pod::Spec.new do |s|
  s.name             = 'kissmyapps'
  s.version          = '1.0.0'
  s.summary          = 'KissMyApps analytics for Flutter apps.'
  s.description      = 'Device details and time to send in the background for the KissMyApps Flutter SDK.'
  s.homepage         = 'https://kissmyapps.dev'
  s.license          = { :type => 'MIT', :file => '../LICENSE' }
  s.author           = 'KissMyApps'
  s.source           = { :path => '.' }
  s.source_files     = 'kissmyapps/Sources/kissmyapps/**/*.swift'
  s.dependency 'Flutter'
  s.platform         = :ios, '12.0'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
  s.swift_version    = '5.0'
end
