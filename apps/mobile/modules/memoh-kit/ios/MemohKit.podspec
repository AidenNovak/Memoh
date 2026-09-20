Pod::Spec.new do |s|
  s.name = 'MemohKit'
  s.version = '0.1.0'
  s.summary = 'Memoh iOS native UI'
  s.description = 'Local Expo module for Memoh native interactions.'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'Memoh iOS contributors'
  s.homepage = 'https://github.com/AidenNovak/memoh-ios'
  s.source = { :git => 'https://github.com/AidenNovak/memoh-ios.git' }
  s.platform = :ios, '26.0'
  s.swift_version = '6.0'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.resource_bundles = {
    'MemohKitStrings' => ['Support/Resources/*.lproj/*.strings'],
    # 设置页 agent 卡片的吉祥物：`assets/images/brand-mark.png` 的副本。原生拿不到 Metro
    # 打包的资源，而两端必须画同一枚图形（见 MemohAssets.swift）。
    'MemohKitAssets' => ['Support/Resources/Assets/*.png'],
  }
end
