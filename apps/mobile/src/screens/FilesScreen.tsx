/**
 * 会话页「文件」视图的内容：面包屑 + 目录列表 + 脚注。
 *
 * ## 这一屏不画标题栏
 *
 * 规格（`docs/research/ios-files-spec.md` §1 + 设计稿）里，文件是**会话页里的一个视图**，
 * 大标题 / 右上角的视图切换 / bot 行都由会话页的外壳提供；而 push 出来的子目录由**原生
 * header** 给标题与返回。所以这里只渲染"内容"，不自己写抬头——写一份就会和外壳打架
 * （两个标题、两个返回）。
 *
 * ## 为什么是 FlatList 而不是分组卡片
 *
 * 设置页那种"一张卡片包住所有行"的形态（`ui/GroupedList`）适合十来行；文件目录可以
 * 有几千项（`fs/list` 无分页、无上限）。所以按首页会话列表的做法：`FlatList` 虚拟化 +
 * 每行自己带卡片底色、首尾行给圆角，视觉上是同一张卡片，成本是常数。
 *
 * ## 只读
 *
 * 编辑 / 上传 / rename / delete 都不做（规格 §6）：写接口是乐观锁 + 409 冲突三分支，
 * 而手机上用键盘改代码不现实——这些事更适合让 agent 去做（它有 write / exec 工具）。
 * 长按给的是原生动作清单，不是行内 swipe（swipe 表示"改变这条记录的状态"，只读列表没有）。
 */
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState } from 'react';

import { useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import {
  GROUP_INSET,
  PRESS_OPACITY,
  radius,
  radiusStyle,
  spacing,
  TAB_BAR_CLEARANCE,
} from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { Breadcrumbs } from '../ui/Breadcrumbs.tsx';
import { fileActions } from '../features/files/actions.ts';
import { copyText } from '../features/files/clipboard.ts';
import { directoryCount } from '../features/files/counts.ts';
import { attemptDownload, DOWNLOAD_CAPABILITY } from '../features/files/download.ts';
import type { WorkspaceEntry } from '../features/files/entries.ts';
import { directorySubtitle, fileSubtitle } from '../features/files/format.ts';
import { fileKind, fileSymbol, fileTint } from '../features/files/kind.ts';
import {
  joinWorkspacePath,
  normalizeWorkspacePath,
  truncateMiddle,
  workspaceCrumbs,
  workspaceParentPath,
} from '../features/files/paths.ts';
import { canReadWorkspace } from '../features/files/permissions.ts';
import { filesRoute, previewRoute } from '../features/files/routes.ts';
import { useDirectory, type DirectoryError } from '../features/files/useDirectory.ts';
import { canRetry, reasonKeyOf } from '../features/errors/present.ts';
import { ErrorNotice } from '../ui/ErrorNotice.tsx';

export function FilesScreen({ path }: { path: string }) {
  const normalized = useMemo(() => normalizeWorkspacePath(path), [path]);

  const palette = usePalette();
  const { scheme, spacing: space, typography: type } = useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();
  const router = useRouter();
  const { currentBot, state } = useSession();

  /**
   * 权限门控在这里也要做一次。
   *
   * 外壳决定要不要显示入口（没有 `workspace_read` 就不显示），但深链可以直接落到这一页，
   * 而且还有"bot 还没取到"的中间态。所以这一层再判一次并给出说明——服务端对 `fs/*`
   * 就是要 `workspace_read`，放行只会得到一个 403。
   */
  const allowed = canReadWorkspace(currentBot);
  const directory = useDirectory(normalized, allowed);
  const [notice, setNotice] = useState<string | null>(null);

  const crumbs = useMemo(
    () => (normalized === null ? [] : workspaceCrumbs(normalized)),
    [normalized],
  );

  const openEntry = useCallback(
    (entry: WorkspaceEntry, entryPath: string) => {
      if (entry.isDir) {
        router.push(filesRoute(entryPath) as never);
        return;
      }
      router.push(previewRoute(entryPath) as never);
    },
    [router],
  );

  const runAction = useCallback(
    (entry: WorkspaceEntry, entryPath: string, actionId: string) => {
      if (actionId === 'open') {
        openEntry(entry, entryPath);
        return;
      }
      if (actionId === 'copyPath') {
        setNotice(copyText(entryPath) ? t('files.action.copied') : t('files.action.copyFailed'));
        return;
      }
      if (actionId === 'download') {
        const attempt = attemptDownload({
          capability: DOWNLOAD_CAPABILITY,
          resolveTarget: () =>
            state.client === null
              ? { url: '', headers: {} }
              : state.client.downloadTarget(currentBot?.id ?? '', entryPath),
        });
        if (!attempt.ok) {
          Alert.alert(t('files.action.download'), t(attempt.reasonKey));
          return;
        }
        // 落盘 + QuickLook 需要 expo-file-system / expo-sharing，本轮没有（见 download.ts）。
        return;
      }
    },
    [currentBot, openEntry, state.client, t],
  );

  /** 长按：原生动作清单。行内不做 swipe，理由见 `features/files/actions.ts`。 */
  const showActions = useCallback(
    (entry: WorkspaceEntry, entryPath: string) => {
      const actions = fileActions({
        isDir: entry.isDir,
        // diff 视图是下一轮（规格 §5）。这里不假装有改动。
        hasDiff: false,
        download: DOWNLOAD_CAPABILITY,
      });
      const reasons = actions
        .filter((action) => !action.enabled && action.reasonKey !== undefined)
        .map((action) => t(action.reasonKey ?? ''));
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: entry.name,
          // 原因**写在清单里**：一个灰掉却不解释的项，和一个坏掉的项长得一样。
          message: reasons.length === 0 ? entryPath : `${entryPath}\n${reasons.join('\n')}`,
          options: [...actions.map((action) => t(action.labelKey)), t('common.cancel')],
          cancelButtonIndex: actions.length,
          disabledButtonIndices: actions
            .map((action, index) => (action.enabled ? -1 : index))
            .filter((index) => index >= 0),
          userInterfaceStyle: scheme,
        },
        (index) => {
          const action = actions[index];
          if (action === undefined) return;
          runAction(entry, entryPath, action.id);
        },
      );
    },
    [runAction, scheme, t],
  );

  const header = (
    <View style={{ paddingVertical: space.sm, paddingBottom: space.md }}>
      <Breadcrumbs
        crumbs={crumbs}
        onNavigate={(target) => router.push(filesRoute(target) as never)}
      />
    </View>
  );

  const more =
    directory.hidden > 0 ? (
      <View style={{ paddingTop: space.md }}>
        <Pressable
          accessibilityRole="button"
          onPress={directory.loadMore}
          style={({ pressed }) => [
            {
              alignItems: 'center',
              paddingVertical: space.md,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: palette.separator,
              backgroundColor: pressed ? palette.field : palette.card,
            },
            radiusStyle(radius.md),
          ]}
        >
          <Text style={[type.body, { color: palette.accent }]}>
            {t('files.more', { count: directory.hidden })}
          </Text>
        </Pressable>
      </View>
    ) : null;

  const footer = (
    <View>
      {more}
      <Text
        style={[
          type.footnote,
          { color: palette.secondaryLabel, textAlign: 'center', paddingTop: space.md },
        ]}
      >
        {/* 复制成功/失败的就地反馈借用这一行：没有 toast，也不值得为它弹一个 alert。 */}
        {notice ?? t('files.footer')}
      </Text>
    </View>
  );

  const placeholder = renderPlaceholder();

  /** 三态之一（外加"没权限/路径不合法"两种走不进去的情形）。 */
  function renderPlaceholder() {
    if (!allowed) {
      return <MessageCard title={t('files.permission.title')} body={t('files.permission.body')} />;
    }
    if (normalized === null) {
      return (
        <MessageCard
          title={t('files.error.invalidPath')}
          body={t('files.error.invalidPath.body')}
        />
      );
    }
    if (directory.status === 'loading' || directory.status === 'idle') {
      return (
        <View style={{ alignItems: 'center', paddingVertical: space.xxl }}>
          <ActivityIndicator color={palette.secondaryLabel} />
        </View>
      );
    }
    if (directory.status === 'error') {
      const failure = directory.error;
      if (failure === null) return null;
      /**
        动作由**错误的性质**决定，不由这一屏决定（`features/errors/present.ts`）：
        没网/超时/5xx 才给重试；404 给"回上一层"（那里通常还在）；凭据失效给重新登录；
        协议形状不对不给动作——重发一百次还是同一个形状。
      */
      const parent = failure.up === true ? workspaceParentPath(normalized ?? '') : null;
      const onUp = parent === null ? null : () => router.push(filesRoute(parent) as never);
      return (
        <ErrorNotice
          testID="files-error"
          title={t(failure.titleKey)}
          reason={t(reasonKeyOf(failure))}
          action={fileErrorAction(failure, onUp, directory.reload, t)}
        />
      );
    }
    // 空目录只给一句话（不是插图）：这是正常状态，不是故障。
    return (
      <View style={{ alignItems: 'center', paddingVertical: space.xxl }}>
        <Text style={[type.body, { color: palette.secondaryLabel }]}>{t('files.empty')}</Text>
      </View>
    );
  }

  const ready = allowed && normalized !== null && directory.status === 'ready';
  const entries = ready ? directory.entries : [];

  return (
    <FlatList
      data={entries}
      keyExtractor={(item) => (item.path === '' ? item.name : item.path)}
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{
        paddingHorizontal: GROUP_INSET,
        paddingTop: space.sm,
        // 让开悬浮 tab 栏（同 ScheduleScreen 的注释）。
        paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
      }}
      ListHeaderComponent={normalized === null ? null : header}
      ListEmptyComponent={placeholder}
      ListFooterComponent={footer}
      refreshControl={
        <RefreshControl
          refreshing={directory.refreshing}
          onRefresh={directory.reload}
          tintColor={palette.secondaryLabel}
        />
      }
      renderItem={({ item, index }) => (
        <FileRow
          entry={item}
          first={index === 0}
          last={index === entries.length - 1}
          parent={normalized ?? ''}
          onPress={openEntry}
          onLongPress={showActions}
        />
      )}
    />
  );
}

/**
 * 一行。
 *
 * 两行结构，与首页会话行一致：文件名 + 次要信息。目录的副标题写「目录 · 12 项」——
 * 项数**只有进过这个目录才知道**（服务端不给），拿不到就只写「目录」，不显示 0
 * （0 会被读成"空目录"，而那是另一个状态）。
 */
function FileRow({
  entry,
  first,
  last,
  parent,
  onPress,
  onLongPress,
}: {
  entry: WorkspaceEntry;
  first: boolean;
  last: boolean;
  parent: string;
  onPress: (entry: WorkspaceEntry, path: string) => void;
  onLongPress: (entry: WorkspaceEntry, path: string) => void;
}) {
  const palette = usePalette();
  const { scheme, spacing: space, typography: type } = useTheme();
  const t = useT();

  // 服务端给的 path 已经是绝对路径；缺了就用父路径 + 名字拼（仍然过一遍白名单校验）。
  const entryPath = entry.path === '' ? joinWorkspacePath(parent, entry.name) : entry.path;
  const kind = fileKind(entry.name, entry.isDir);
  const subtitle = entry.isDir
    ? directorySubtitle(entryPath === null ? null : directoryCount(entryPath), t)
    : fileSubtitle(entry, t, Date.now());

  const corners = {
    borderTopLeftRadius: first ? radius.md : 0,
    borderTopRightRadius: first ? radius.md : 0,
    borderBottomLeftRadius: last ? radius.md : 0,
    borderBottomRightRadius: last ? radius.md : 0,
  };

  if (entryPath === null) return null;

  return (
    <Pressable
      // 行上的 testID：列表行的文字在无障碍树里是**子节点**，按文字点会随文案碎掉
      // （这一屏为此栽过两次：`notes.txt` 这种点不到，只能退回坐标点）。
      testID={`file-row-${entry.name}`}
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${subtitle}`}
      accessibilityHint={t('files.row.hint')}
      onPress={() => onPress(entry, entryPath)}
      onLongPress={() => onLongPress(entry, entryPath)}
      style={({ pressed }) => [
        styles.row,
        corners,
        {
          backgroundColor: pressed ? palette.field : palette.card,
          paddingHorizontal: space.lg,
        },
      ]}
    >
      <View
        style={{
          width: 29,
          height: 29,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: fileTint(kind, scheme),
          ...radiusStyle(7),
        }}
      >
        <SymbolView
          name={fileSymbol(kind)}
          size={17}
          tintColor="#FFFFFF"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={[type.body, { color: palette.label }]} numberOfLines={1}>
          {truncateMiddle(entry.name)}
        </Text>
        <Text style={[type.footnote, { color: palette.secondaryLabel }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <Text style={[type.body, { color: palette.tertiaryLabel }]}>›</Text>
      {!last ? (
        <View
          style={{
            position: 'absolute',
            left: 48,
            right: 0,
            bottom: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: palette.separator,
          }}
        />
      ) : null}
    </Pressable>
  );
}

/** 卡片形态的一句话状态（空目录 / 进不去 / 失败）。失败时多给一个「重试」。 */
function MessageCard({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
}) {
  const palette = usePalette();
  const { spacing: space, typography: type } = useTheme();
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
      {action === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={action.onPress}
          hitSlop={8}
          style={({ pressed }) => ({
            opacity: pressed ? PRESS_OPACITY.control : 1,
            paddingTop: space.xs,
          })}
        >
          <Text style={[type.body, { color: palette.accent }]}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * 一次列目录失败该给哪个按钮。
 *
 * 抽成函数是为了让"不给按钮"也是一种**显式**的结论，而不是漏写：`undefined` 在这里
 * 的含义是"这件事没有用户能做的动作"，这是允许的答案（规则 R19）。
 */
function fileErrorAction(
  failure: DirectoryError,
  onUp: (() => void) | null,
  reload: () => void,
  t: (key: string) => string,
): { label: string; onPress: () => void } | undefined {
  if (onUp !== null) return { label: t('files.error.action.up'), onPress: onUp };
  if (canRetry(failure)) return { label: t('common.retry'), onPress: reload };
  return undefined;
}

const styles = StyleSheet.create({
  row: {
    // 两行文字 + 上下 10pt；不低于 44pt 的触控下限。
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
  },
});

/** 悬浮 tab 栏让开的高度。 */
