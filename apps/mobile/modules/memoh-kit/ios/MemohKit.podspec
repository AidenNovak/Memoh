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
    # 原生页面使用的品牌与登录供应商图标。原生拿不到 Metro 打包的资源，所以这里随
    # MemohKit 一起打包与 RN 资产逐字节相同的副本（见 MemohAssets.swift）。
    'MemohKitAssets' => ['Support/Resources/Assets/*.png'],
  }
end
