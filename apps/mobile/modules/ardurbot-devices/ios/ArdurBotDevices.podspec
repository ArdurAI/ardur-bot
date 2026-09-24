Pod::Spec.new do |s|
  s.name = 'ArdurBotDevices'
  s.version = '0.1.0'
  s.summary = 'Device keys and pinned home connections'
  s.description = 'Native device enrollment, presence, and pinned TLS for Dispatch.'
  s.license = { :type => 'Apache-2.0' }
  s.author = 'Ardur Bot maintainers'
  s.homepage = 'https://github.com/ArdurAI/ardur-bot'
  s.platforms = { :ios => '16.0' }
  s.source = { :git => 'https://github.com/ArdurAI/ardur-bot.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'LocalAuthentication', 'AVFoundation', 'CryptoKit'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
