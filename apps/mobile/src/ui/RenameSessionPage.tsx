/**
 * 重命名会话（会话行长按 → 重命名）。
 *
 * ## 形态：一张只干一件事的原生 sheet
 *
 * 与 `LanguagePickerPage` / `ModelPickerPage` 同一套 `present` 契约：进来就是一个输入框
 * 加一个"完成"。不做成"行内直接编辑"：会话列表的行是**点击即进入会话**的，让它的标题
 * 同时可编辑会让"点一下"产生两种结果（实测反馈里"点名字没进去"是最烦的一类）。
 *
 * ## 保存是差分的
 *
 * 只发 `{title}`，而且**没改就不发**（`renamePatch` 返回 null → 按钮禁用）。
 * `PATCH /bots/{id}/sessions/{id}` 是字段级更新，整份回写会把桌面端同时改的东西带回去
 * （与 bot 设置同一条规矩，见 `features/bots/settings.ts` 的文件头）。
 *
 * 部署实例上实测过这条路：`PATCH` 带 `{title}` → 200，回声里的 `title` 就是发过去的那个。
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { renamePatch } from '../features/session/actions.ts';
import { presentError, reasonKeyOf, type ErrorPresentation } from '../features/errors/present.ts';
import { useSession } from '../features/session/store.tsx';
import { definePage, usePageRuntime } from '../lib/presentation/page.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { MIN_TOUCH_TARGET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { ErrorNotice } from './ErrorNotice.tsx';

export interface RenameSessionParams {
  sessionId: string;
  /** 当前标题（进来先填上，用户改的是它，不是从空白开始写）。 */
  title: string;
}

export interface RenameSessionResult {
  title: string;
}

function RenameSessionPresentedView() {
  const palette = usePalette();
  const t = useT();
  const runtime = usePageRuntime<RenameSessionParams, RenameSessionResult>();
  const { state, refreshSessions } = useSession();
  const [draft, setDraft] = useState(runtime.params.title);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ErrorPresentation | null>(null);

  const patch = renamePatch(runtime.params.title, draft);

  const save = useCallback(() => {
    const client = state.client;
    const botId = state.currentBotId;
    if (client === null || botId === null || patch === null || busy) return;
    setBusy(true);
    setFailure(null);
    void (async () => {
      try {
        await client.updateSession(botId, runtime.params.sessionId, patch);
        // 列表上那份标题是本地缓存的，不重拉就还是旧的——用户会以为改名没生效。
        await refreshSessions();
        runtime.finish({ title: patch.title });
      } catch (caught) {
        setBusy(false);
        setFailure(presentError(caught));
      }
    })();
  }, [busy, patch, refreshSessions, runtime, state.client, state.currentBotId]);

  return (
    <View
      style={{
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        paddingBottom: spacing.lg,
        gap: spacing.md,
      }}
    >
      <Text style={[typography.title3, { color: palette.label }]}>{t('session.rename.title')}</Text>
      <TextInput
        testID="session-rename-input"
        value={draft}
        onChangeText={setDraft}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={save}
        placeholder={t('session.rename.placeholder')}
        placeholderTextColor={palette.placeholder}
        style={[
          typography.body,
          {
            color: palette.label,
            backgroundColor: palette.field,
            borderRadius: radius.md,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.sm,
            minHeight: MIN_TOUCH_TARGET,
          },
        ]}
      />

      {failure === null ? null : (
        <ErrorNotice
          testID="session-rename-error"
          title={t('session.rename.failed')}
          // 服务端写好的原因原样转达（换个名字失败通常就是权限或参数）。
          reason={t(reasonKeyOf(failure))}
        />
      )}

      <Pressable
        testID="session-rename-save"
        accessibilityRole="button"
        accessibilityState={{ disabled: patch === null || busy }}
        disabled={patch === null || busy}
        onPress={save}
        style={({ pressed }) => ({
          marginHorizontal: 0,
          minHeight: 48,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radius.md,
          backgroundColor: pressed ? palette.field : palette.card,
          opacity: patch === null || busy ? 0.5 : 1,
        })}
      >
        {busy ? (
          // 保存是**一个明确的请求**，所以这里可以给转圈（与"等确认"那种不确定状态不同：
          // 那个给转圈才是撒谎，见 `features/chat/pending.ts`）。
          <ActivityIndicator color={palette.secondaryLabel} />
        ) : (
          <Text style={[typography.body, { color: palette.accent }]}>{t('common.done')}</Text>
        )}
      </Pressable>
    </View>
  );
}

export const RenameSessionSheet = definePage<RenameSessionParams, RenameSessionResult>({
  id: 'sessionRename',
  title: 'Rename',
  Component: RenameSessionPresentedView,
  parseRouteParams: (params) => ({
    sessionId: String(params.sessionId ?? ''),
    title: String(params.title ?? ''),
  }),
  presentation: {
    dismissible: true,
    // 内容就这两行：贴着内容高度最自然（同会话信息页的理由）。
    detents: 'fitToContents',
    grabber: true,
    headerShown: false,
  },
});
