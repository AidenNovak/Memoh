import { initI18n } from './index.ts';

// index.js 在 expo-router 之前 import 这个模块，保证首帧就是正确语言。
initI18n();
