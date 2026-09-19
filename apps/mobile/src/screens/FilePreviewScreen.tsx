/**
 * 文件预览页。**push 出来的一页**，不是 sheet。
 *
 * 为什么是 push：预览是"往下看一层"（从目录里点进去），native stack 的返回与右滑交互
 * 就是为这种层级准备的；sheet 留给"从当前上下文升起、做完就收回"的瞬时流程
 * （见 `docs/presentation.md`）。标题由路由侧通过原生 header 给，这一屏只画内容。
 *
 * ## 三种内容态，判定顺序不能改（见 `features/files/kind.ts`）
 *
 * - **文本**：等宽 + 行号，长行横向滚动不折行。
 * - **二进制**：不读内容（`fs/read` 对二进制有损），给一句原因 + 下载入口。
 * - **超大**：超过 512 KiB 只给下载——"太大"是一等结果，不是错误。
 *
 * 另外几态也必须能分辨：`fs` 返回 404 = 文件已不存在（不是网络坏了）、真的读失败、
 * 以及"这是个目录"（别装成空文件）。
 */
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo } from 'react';

import { useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { canRetry, reasonKeyOf } from '../features/errors/present.ts';
import { GROUP_INSET, radius, radiusStyle, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { ErrorNotice } from '../ui/ErrorNotice.tsx';
import { Breadcrumbs } from '../ui/Breadcrumbs.tsx';
import { attemptDownload, DOWNLOAD_CAPABILITY } from '../features/files/download.ts';
import { formatBytes } from '../features/files/format.ts';
import { type FileKind } from '../features/files/kind.ts';
import { normalizeWorkspacePath, workspaceCrumbs } from '../features/files/paths.ts';
import { canReadWorkspace } from '../features/files/permissions.ts';
import { useFilePreview, type PreviewState } from '../features/files/useFilePreview.ts';

/** 行号栏宽度。四位数以内的行号都排得下，右侧留一点缝。 */
const GUTTER_WIDTH = 44;

export function FilePreviewScreen({ path }: { path: string }) {
  const normalized = useMemo(() => normalizeWorkspacePath(path), [path]);
  const palette = usePalette();
  const { spacing: space } = useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();
  const router = useRouter();
  const { currentBot, state } = useSession();

  const allowed = canReadWorkspace(currentBot);
  const { state: preview, reload } = useFilePreview(normalized, allowed);

  /** 下载入口。本轮没有落盘能力，所以点它给的是**原因**，不是静默失败。 */
  const onDownload = useCallback(() => {
    const attempt = attemptDownload({
      capability: DOWNLOAD_CAPABILITY,
      resolveTarget: () =>
        state.client === null
          ? { url: '', headers: {} }
          : state.client.downloadTarget(currentBot?.id ?? '', normalized ?? ''),
    });
    if (!attempt.ok) {
      Alert.alert(t('files.action.download'), t(attempt.reasonKey));
      return;
    }
    // 落盘 + QuickLook 需要 expo-file-system / expo-sharing，本轮没有（见 download.ts）。
  }, [currentBot, normalized, state.client, t]);

  const crumbs = useMemo(
    () => (normalized === null ? [] : workspaceCrumbs(normalized)),
    [normalized],
  );

  /** 状态 → 内容。用 if 链而不是三元：这里的每一种状态都有自己的形状。 */
  function renderBody() {
    if (!allowed) {
      return <Notice title={t('files.permission.title')} body={t('files.permission.body')} />;
    }
    if (normalized === null) {
      return (
        <Notice title={t('files.error.invalidPath')} body={t('files.error.invalidPath.body')} />
      );
    }
    if (preview.status === 'loading' || preview.status === 'idle') {
      return (
        <View style={{ alignItems: 'center', paddingVertical: space.xxl }}>
          <ActivityIndicator color={palette.secondaryLabel} />
        </View>
      );
    }
    if (preview.status === 'notFound') {
      // 404：文件真的不在了。重试没有意义，有用的一步是回到列表（可以在那里挑别的）。
      return (
        <Notice
          title={t('files.error.notFound')}
          body={t('files.error.notFound.body')}
          action={{ label: t('common.back'), onPress: () => router.back() }}
        />
      );
    }
    if (preview.status === 'error') {
      /**
        原因与动作都由 `features/errors/present.ts` 给：能重试才给重试。
        以前这里无条件给"重试"，包括协议形状不对（重发一百次还是同一个形状）和
        凭据失效（等到天亮也不会好）——那种按钮是在让用户白做功。
      */
      return (
        <ErrorNotice
          testID="preview-error"
          title={t(preview.titleKey)}
          reason={t(reasonKeyOf(preview))}
          action={canRetry(preview) ? { label: t('common.retry'), onPress: reload } : undefined}
        />
      );
    }
    if (preview.status === 'folder') {
      return <Notice title={t('files.preview.folder')} body={t('files.preview.folder.body')} />;
    }
    if (preview.status === 'image') {
      return (
        <ImagePreview
          uri={preview.uri}
          headers={preview.headers}
          size={preview.size}
          onDownload={onDownload}
        />
      );
    }
    if (preview.status === 'binary') {
      // 标题按**具体类型**给（PDF / 视频 / 压缩包…），不笼统说"二进制文件"：
      // 用户看到"PDF 不能内嵌预览"和看到"二进制文件"是两种体验。
      return (
        <Notice
          title={t(KIND_TITLE_KEY[preview.kind] ?? 'files.preview.kind.binary')}
          body={t(REASON_KEY[preview.kind] ?? 'files.preview.reason.binary', {
            size: formatBytes(preview.size),
          })}
          download={{ label: t('files.action.download'), onPress: onDownload }}
        />
      );
    }
    if (preview.status === 'tooLarge') {
      return (
        <Notice
          title={t('files.preview.tooLarge.title')}
          body={t('files.preview.tooLarge.body', {
            size: formatBytes(preview.size),
            limit: formatBytes(preview.limit),
          })}
          download={{ label: t('files.action.download'), onPress: onDownload }}
        />
      );
    }
    return <CodeBlock state={preview} />;
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{
        paddingHorizontal: GROUP_INSET,
        paddingTop: space.sm,
        paddingBottom: insets.bottom + space.xxl,
        gap: space.md,
      }}
    >
      {crumbs.length === 0 ? null : <Breadcrumbs crumbs={crumbs} />}
      {renderBody()}
    </ScrollView>
  );
}

/** 类型 → 标题文案键。没有映射的（未知二进制）走 binary 那句。 */
const KIND_TITLE_KEY: Partial<Record<FileKind, string>> = {
  image: 'files.preview.kind.image',
  pdf: 'files.preview.kind.pdf',
  video: 'files.preview.kind.video',
  audio: 'files.preview.kind.audio',
  archive: 'files.preview.kind.archive',
  sheet: 'files.preview.kind.sheet',
};

/** 类型 → "为什么不能内嵌预览"的文案键。每种都**说实话**，不写"不支持"三个字了事。 */
const REASON_KEY: Partial<Record<FileKind, string>> = {
  pdf: 'files.preview.reason.pdf',
  video: 'files.preview.reason.video',
  audio: 'files.preview.reason.audio',
  archive: 'files.preview.reason.archive',
  sheet: 'files.preview.reason.sheet',
};

/**
 * 图片预览。
 *
 * 两个刻意的选择：
 *
 * 1. **让 `expo-image` 直接按 URL 取**（带鉴权头），不先读进 JS 再转 base64——
 *    `fs/download` 没有上限，转 base64 会让一张 20 MB 的图先吃 27 MB 堆。
 * 2. **给一个固定高度的画布**、`contentFit="contain"`：不知道图片尺寸也没关系，
 *    提前知道尺寸反而要等一次 stat。留白用 `field` 底，让它看起来是"画框"而不是错位。
 */
function ImagePreview({
  uri,
  headers,
  size,
  onDownload,
}: {
  uri: string;
  headers: Record<string, string>;
  size: number;
  onDownload: () => void;
}) {
  const palette = usePalette();
  const { spacing: space } = useTheme();
  const t = useT();
  const [failed, setFailed] = React.useState(false);

  if (failed) {
    return (
      <Notice
        title={t('files.preview.image.failed')}
        body={t('files.preview.image.failed.body', { size: formatBytes(size) })}
        download={{ label: t('files.action.download'), onPress: onDownload }}
      />
    );
  }

  return (
    <View style={{ gap: space.sm }}>
      <Image
        source={{ uri, headers }}
        contentFit="contain"
        transition={120}
        onError={() => setFailed(true)}
        style={{
          width: '100%',
          height: 420,
          borderRadius: radius.md,
          backgroundColor: palette.field,
        }}
        accessibilityLabel={t('files.preview.kind.image')}
      />
      <Text style={[typography.footnote, { color: palette.secondaryLabel }]}>
        {t('files.preview.image.meta', { size: formatBytes(size) })}
      </Text>
    </View>
  );
}

/**
 * 等宽 + 行号。
 *
 * 长行不折行靠的是"父容器宽度不受限"：每一行是 `flexDirection: row` 的 View，放在横向
 * `ScrollView` 里按内容宽度排版。所以这里**不给文本设宽度**——设了就等于自己决定在
 * 哪里折行，而折行的代码没法读。
 */
function CodeBlock({ state }: { state: Extract<PreviewState, { status: 'text' }> }) {
  const palette = usePalette();
  const { spacing: space, typography: type } = useTheme();
  const t = useT();

  return (
    <View
      style={[
        {
          backgroundColor: palette.card,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.separator,
          paddingVertical: space.md,
        },
        radiusStyle(radius.md),
      ]}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          {state.lines.map((line, index) => (
            <View key={index} style={{ flexDirection: 'row', paddingHorizontal: space.md }}>
              <Text
                style={[
                  type.mono,
                  { width: GUTTER_WIDTH, textAlign: 'right', color: palette.tertiaryLabel },
                ]}
              >
                {index + 1}
              </Text>
              <Text style={[type.mono, { color: palette.label }]} numberOfLines={1}>
                {line === '' ? ' ' : line}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
      {state.truncated > 0 ? (
        <Text
          style={[
            type.footnote,
            {
              color: palette.secondaryLabel,
              textAlign: 'center',
              paddingTop: space.md,
              paddingHorizontal: space.md,
            },
          ]}
        >
          {t('files.preview.truncated', { count: state.truncated })}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * 一句状态 + 可选动作。
 *
 * 「下载」是真按钮，但本轮点了会说明原因（没有落盘能力），而不是静默失败；
 * 原因文案来自 `download.ts`，与长按清单里用的是同一句。
 */
function Notice({
  title,
  body,
  action,
  download,
}: {
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
  download?: { label: string; onPress: () => void };
}) {
  const palette = usePalette();
  const { spacing: space, typography: type } = useTheme();

  const pressable = (label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: palette.separator,
        backgroundColor: pressed ? palette.field : palette.card,
        paddingVertical: space.sm,
        paddingHorizontal: space.lg,
        ...radiusStyle(radius.pill),
      })}
    >
      <Text style={[type.subhead, { color: palette.accent }]}>{label}</Text>
    </Pressable>
  );

  return (
    <View
      style={[
        { backgroundColor: palette.card, padding: space.lg, gap: space.sm },
        radiusStyle(radius.md),
      ]}
    >
      <Text style={[type.body, { color: palette.label }]}>{title}</Text>
      {body === undefined || body === '' ? null : (
        <Text style={[type.footnote, { color: palette.secondaryLabel }]}>{body}</Text>
      )}
      {action === undefined && download === undefined ? null : (
        <View style={{ flexDirection: 'row', gap: space.sm, paddingTop: space.xs }}>
          {action === undefined ? null : pressable(action.label, action.onPress)}
          {download === undefined ? null : pressable(download.label, download.onPress)}
        </View>
      )}
    </View>
  );
}
