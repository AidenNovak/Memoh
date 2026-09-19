/**
 * agent 头像。
 *
 * ## 六种情况，一个结论
 *
 * 1. bot 自带 `avatar_url` 且能加载 → 用那张图。
 * 2. 没有 `avatar_url` → **Memoh 那枚吉祥物**（`brand-mark.png`，透明底）。
 * 3. 有 `avatar_url` 但**加载失败**（自托管常见：桶挂了、域名不通、图被删了）
 *    → 退回那枚吉祥物。
 * 4. 失败之后**网络恢复**了 → **再试一次**（最多一次）。
 * 5. `avatar_url` 是**我们自己的内置头像标识**（`memoh:avatar/<slug>`）→ 本地画那一枚，
 *    **不联网**（用户在设置页的内置选择器里挑的那个）。
 * 6. 前缀是我们的、但项认不出（更早的版本存的、被别处手改过）→ 也退回吉祥物，
 *    **不去请求**一个 `memoh:` 开头的假地址。
 *
 * 第 3 条是上一版的要点：以前那种"有 url 就画 url"的写法在真机上留下过**一个空白灰方块**
 * （2026-09-15 用户截图）——用户看到的是一个"还没画完"的占位，而不是"这个 bot 没有头像"。
 * 判断本身在 `features/bots/avatar.ts`（那边能直测），这里只管画。
 *
 * 第 4 条是这一版补的：失败态以前是**永久**的，只有换 bot / 换 url 才重置。于是"在电梯里
 * 打开过一次"的 bot，头像就再也不回来了——图没坏，只是那一次没通。现在连接回到 `open`
 * 时清一次失败态、重新加载一次，**同一次 open 只给一次**（图真坏了时不至于变成无限重试）。
 * 状态转移也是纯函数（`avatarRetryOnConnection`），所以这条判据有测试。
 *
 * 第 5/6 条（内置头像）见 `features/bots/avatarPresets.ts`：为什么存标识而不是托管 URL、
 * 好处与代价都记在那里。这里只负责把它画成"系统图标 + 品牌淡底"的圆角方块——与
 * Reminders / Shortcuts 里那种"有色底 + 白色图形"的图标同一个语言，比自绘图形更省事、
 * 也跟着主题色自动明暗适配。
 *
 * 为什么不是字母首字：字母方块在这里既不是品牌也不是标识，只是"我们还没画"的痕迹；
 * 一屏四个 bot 全是灰方块 + 一个字母，用户根本分不清谁是谁。桌面端同一个位置摆的就是
 * 这枚吉祥物，两端对得上。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SymbolView } from 'expo-symbols';

import {
  avatarFor,
  avatarRetryOnConnection,
  type AvatarRetryState,
  type BotAvatarSource,
} from '../features/bots/avatar.ts';
import { builtinAvatarBySlug } from '../features/bots/avatarPresets.ts';
import { useConnectionState } from '../features/session/store.tsx';
import { usePalette } from '../lib/theme/context.tsx';

const MARK = require('../../assets/images/brand-mark.png');

const NO_ATTEMPT: AvatarRetryState = { failed: false, retriedOnOpen: false };

export function BotAvatar({
  bot,
  size = 28,
  style,
}: {
  /**
   props 收 `BotAvatarSource`（`avatar_url?: unknown`）而**不是** `Pick<Bot, 'avatar_url'>`
   （那个声明它是 `string`）。类型比现实乐观过一次：真服务端上 `avatar_url` 整个 key 都可能
   不存在，旧声明把 `bot.avatar_url.trim()` 放进了函数体，于是会话列表整屏红屏
   （见 `features/bots/avatar.ts` 的文件头）。**类型系统必须站在现实这一边**，
   否则下一个搬 `bot.avatar_url` 直接用的人还会踩同一次。
   */
  bot: BotAvatarSource | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = usePalette();
  const [retry, setRetry] = useState<AvatarRetryState>(NO_ATTEMPT);
  const plan = avatarFor(bot);

  // 换了一个 bot 就重新给它一次机会（`failed` 不能跨 bot 粘住：
  // 不然切换器里点过一个坏头像的 bot，之后每个 bot 都显示默认头像）。
  //
  // key 取"这次的画法"，不只看 url：远程图的重试状态只对远程图有意义，但**换了内置头像
  // 也要把上一个 bot 的失败态清掉**——用一个 key 同时覆盖两者，比只盯 uri 少一个漏判。
  const uri = plan.kind === 'remote' ? plan.uri : null;
  const planKey = plan.kind === 'builtin' ? `builtin:${plan.slug}` : uri;
  const [attemptedUri, setAttemptedUri] = useState(planKey);
  if (attemptedUri !== planKey) {
    setAttemptedUri(planKey);
    setRetry(NO_ATTEMPT);
  }

  // 网络回来了就再试一次。纯函数决定"该不该试"，这里只负责把它接到连接状态上：
  // 返回同一个对象时 `setState` 不触发重渲染，所以没恢复的时候这里是零成本。
  const connection = useConnectionState();
  useEffect(() => {
    setRetry((current) => avatarRetryOnConnection(current, connection === 'open'));
  }, [connection]);

  const box = style as StyleProp<ViewStyle>;
  const shape = { width: size, height: size, borderRadius: Math.round(size * 0.29) };
  const onError = useCallback(() => setRetry((current) => ({ ...current, failed: true })), []);

  if (plan.kind === 'remote' && !retry.failed) {
    return (
      <Image
        source={{ uri: plan.uri }}
        style={[shape, { overflow: 'hidden' }, style as StyleProp<never>]}
        onError={onError}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    );
  }

  if (plan.kind === 'builtin') {
    const preset = builtinAvatarBySlug(plan.slug);
    // 理论上到不了（`avatarFor` 已经把认不出的 slug 变成 `mark`），但这里不能赌：
    // 漏了就是画一个空方块——比回退成吉祥物更像"坏了"。
    if (preset !== undefined) {
      return (
        <View
          testID={`bot-avatar-builtin-${preset.slug}`}
          style={[shape, styles.builtin, { backgroundColor: palette.accentSoft }, box]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <SymbolView
            name={preset.symbol}
            size={Math.round(size * 0.56)}
            tintColor={palette.accent}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </View>
      );
    }
  }

  return (
    <View
      style={[shape, styles.mark, box]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Image source={MARK} style={{ width: size, height: size }} />
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { overflow: 'hidden' },
  /** 内置头像：图形本身是系统图标，底色由主题色给，所以只需要裁圆角。 */
  builtin: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
});
