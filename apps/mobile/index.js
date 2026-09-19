// Expo Router 入口。
// i18n 必须在 router 之前初始化：否则首帧文案与传给原生的语言标签会读到默认 locale。
import './src/lib/i18n/boot';
import 'expo-router/entry';
