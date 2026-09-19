/**
 * 面包屑。
 *
 * 手机上的文件浏览是"一页一目录的 push"（没有常驻侧栏，放不下文件树），所以必须有它：
 * 没有面包屑，从 `/data/projects/memoh-ios/apps` 回到 `/data` 要点四次返回。
 *
 * 两个细节：
 *
 * 1. **最后一段不可点**：点当前目录等于原地刷新，是个没有反馈的死控件。
 * 2. 段与段之间的分隔符是 `/`，不是 `›`——它表示的是路径层级，不是导航箭头；
 *    设计稿里也是 `/`。段名用等宽字体，因为它是路径不是文案（也不做本地化）。
 */
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { PRESS_OPACITY } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import type { WorkspaceCrumb } from '../features/files/paths.ts';

export function Breadcrumbs({
  crumbs,
  onNavigate,
}: {
  crumbs: WorkspaceCrumb[];
  /** 传了就可点（列表页）；预览页只展示路径，不传就纯文本。 */
  onNavigate?: (path: string) => void;
}) {
  const palette = usePalette();
  const { spacing, typography } = useTheme();
  if (crumbs.length === 0) return null;

  return (
    // 层级深时横向滚动：宁可滚，也不要折行——折行会让"当前在哪一层"变得难读。
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ alignItems: 'center', gap: spacing.xs }}
    >
      {crumbs.map((crumb, index) => {
        const tappable = onNavigate !== undefined && !crumb.current;
        const content = (
          <Text
            style={[
              typography.mono,
              { color: crumb.current ? palette.label : palette.accent },
              crumb.current ? { fontWeight: '600' } : null,
            ]}
          >
            {crumb.label}
          </Text>
        );
        return (
          <View
            key={crumb.path}
            style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}
          >
            {index > 0 ? (
              <Text style={[typography.mono, { color: palette.tertiaryLabel }]}>/</Text>
            ) : null}
            {tappable ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={crumb.label}
                onPress={() => onNavigate(crumb.path)}
                hitSlop={6}
                style={({ pressed }) => ({ opacity: pressed ? PRESS_OPACITY.control : 1 })}
              >
                {content}
              </Pressable>
            ) : (
              content
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}
