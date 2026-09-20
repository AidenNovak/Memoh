/**
 * 主题（RN 侧）。
 *
 * ## 为什么分成两个文件
 *
 * `tokens.ts` 是**纯数据**：零 RN 依赖，Node 可以直接 import 它跑测试
 * 这个文件再加一层 hook 与再导出。
 *
 * Lody 也是这个结构，理由一样：对比度、间距档位、行高这类规则必须在**不需要
 * 模拟器**的地方就能验证。放进带 RN 依赖的文件里，Node 连解析都过不去——
 * 那就只能靠肉眼，而肉眼看不出 4.35:1 和 4.5:1 的差别。
 *
 * 业务代码从 `lib/theme/context.tsx` 取（hook），或从这里取类型；
 * 需要纯数值时可以直接 import `tokens.ts`。
 */
import { useColorScheme } from 'react-native';

export * from './tokens.ts';

/** 读取系统明暗。用 RN 的 hook，因为主题本身就在这一层。 */
export function useSystemScheme(): 'light' | 'dark' {
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}
