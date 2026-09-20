/**
 * 剪贴板。
 *
 * ## 为什么用 RN core 的 `Clipboard`（一个已弃用的入口）
 *
 * 本轮的约束是不装新依赖：官方替代品 `@react-native-clipboard/clipboard` 和
 * `expo-clipboard` 都不在 `package.json` 里。而 RN core 的实现仍然在
 * `React/CoreModules/RCTClipboard.mm`（已进 App 的 Pod），只是 JS 入口被标记为弃用——
 * 首次访问会打一条 `warnOnce`（开发构建里是一次黄色 LogBox 横幅，发布构建里没有）。
 *
 * 取舍：一条开发期的弃用提示 vs 一个做不了的"复制路径"。选前者，并把整件事收进这一个
 * 文件——哪天装上了 expo-clipboard，只改这里。
 *
 * 另外，`setString` 在原生模块缺失时会抛：这里兜住并返回 false，
 * 让调用方能给出"复制失败"而不是崩一次。
 */
import { Clipboard } from 'react-native';

export function copyText(text: string): boolean {
  try {
    Clipboard.setString(text);
    return true;
  } catch {
    return false;
  }
}
