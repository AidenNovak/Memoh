/**
 * 新建 bot（agent）——单页表单。
 *
 * ## 形态照桌面端（`apps/web/src/pages/bots/new.vue`），但只搬能搬的
 *
 * 桌面端是三张卡：**基本信息 / 设置 / 访问控制**，底部一行"首次创建可能要拉基础镜像"的提示。
 * iOS 这里保持同样的三段与同样的必填规则，**不搬**的是：
 *
 * - **备份导入（zip）**：那是桌面端同一页里的另一个 tab，规格 §9 明确不做。
 * - **成员授权（grants）**：桌面端只在创建时就加别人（默认行是自己、不提交）。iOS 没有
 *   多人概念页面，先不做。
 * - **Codex / Claude Code 直连运行时的凭据面板**：那一整套（登录、凭据申领）规格里排除了。
 *   所以 Agent 类型固定在"内置 Memoh"。
 *
 * ## 名字是这一页最要紧的一件事
 *
 * URL 名要**服务端认可**（`^[a-z0-9][a-z0-9-]{1,62}$`、非保留字、不重名）。三件事分开报：
 * "被占用"和"保留字"给用户的下一步动作不一样。这里先本地判形状与保留字（省一次请求），
 * 再 400ms 防抖问服务端，并把四态显示在输入框下面。
 *
 * ## 提交走"先创建、再轮询"
 *
 * `POST /bots` 不带 `wait_for_ready`（理由见 `client.createBot`：服务端那条同步路会一直
 * 等到容器就绪，任何一跳先超时都会让人以为失败）。拿到 `creating` 就 push 到进度页，
 * 由它轮询到 `ready`。
 */
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  buildCreatePayload,
  canSubmit,
  emptyBotForm,
  localNameProblem,
  nameStatusFromReason,
  slugifyBotName,
  type BotFormState,
  type NameStatus,
} from '../features/bots/create.ts';
import { avatarFor, avatarValueKey } from '../features/bots/avatar.ts';
import { useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { present } from '../lib/presentation/index.ts';
import { GROUP_INSET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette } from '../lib/theme/context.tsx';
import { AvatarPickerSheet } from '../ui/AvatarPickerPage.tsx';
import { BackButton } from '../ui/BackButton.tsx';
import { Group, Row } from '../ui/GroupedList.tsx';

/** 防抖时长与桌面端一致（`new.vue` 的 400ms）。 */
const NAME_DEBOUNCE_MS = 400;

/** 访问档位：与桌面端 `constants/acl-presets.ts` 同一组，顺序也照它。 */
const ACL_PRESETS = [
  'allow_all',
  'private_only',
  'group_only',
  'group_and_thread_only',
  'deny_all',
] as const;

export function BotCreateScreen() {
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state } = useSession();

  const [form, setForm] = useState<BotFormState>(emptyBotForm);
  const [error, setError] = useState<string | null>(null);
  /** 用户改过 URL 名之后就不再跟着显示名联动（桌面端同样：`nameTouched`）。 */
  const nameTouched = useRef(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patch = useCallback((next: Partial<BotFormState>) => {
    setForm((prev) => ({ ...prev, ...next }));
  }, []);

  const onDisplayName = useCallback((displayName: string) => {
    setForm((prev) => ({
      ...prev,
      displayName,
      // 没手改过就跟着显示名走（中文名 slug 化后为空，那时用户必须自己填）。
      name: nameTouched.current ? prev.name : slugifyBotName(displayName),
      nameStatus: nameTouched.current ? prev.nameStatus : 'idle',
    }));
  }, []);

  /** 名字可用性：本地先判，再防抖问服务端。 */
  useEffect(() => {
    if (debounce.current !== null) clearTimeout(debounce.current);
    const local = localNameProblem(form.name);
    if (local !== null) {
      patch({ nameStatus: local });
      return;
    }
    if (form.name.trim() === '' || state.client === null) {
      patch({ nameStatus: 'idle' });
      return;
    }
    patch({ nameStatus: 'checking' });
    debounce.current = setTimeout(() => {
      void (async () => {
        try {
          const result = await state.client?.checkBotNameAvailability(form.name.trim());
          if (result === undefined) return;
          patch({ nameStatus: nameStatusFromReason(result.available, result.reason) });
        } catch {
          // 问不到就退回 idle：**不猜"可用"**，否则用户会提交一个必然 409 的名字。
          patch({ nameStatus: 'idle' });
        }
      })();
    }, NAME_DEBOUNCE_MS);
    return () => {
      if (debounce.current !== null) clearTimeout(debounce.current);
    };
  }, [form.name, patch, state.client]);

  const nameHint = useMemo(() => {
    const keys: Record<NameStatus, string | null> = {
      idle: 'bots.name.idle',
      checking: 'bots.name.checking',
      available: 'bots.name.available',
      taken: 'bots.name.taken',
      invalid: 'bots.name.invalid',
      reserved: 'bots.name.reserved',
    };
    const key = keys[form.nameStatus];
    return key === null ? null : t(key);
  }, [form.nameStatus, t]);

  /**
   头像：**挑是主路径**（内置选择器），手打网址降级成选择器里的次要分组。

   与设置页同一套（`ui/AvatarPickerPage.tsx` + `features/bots/avatarPresets.ts`），不是
   第二份实现：改前这里是这一页唯一一个手输的 `Avatar URL`——想换头像得**先自己拥有一个
   图片地址**，而新建流程里"不打字就选一个"是最该成立的时刻。落库形态照旧走 `avatar_url`
   那一个字段（`memoh:avatar/<slug>`），提交时由 `buildCreatePayload` 带上去。

   不选就什么都不变：空串仍然**不进**请求体（`buildCreatePayload` 只发填了的），
   也就是"默认行为不变、不产生补丁"。
   */
  const pickAvatar = useCallback(() => {
    void (async () => {
      const outcome = await present(AvatarPickerSheet, { avatarUrl: form.avatarUrl });
      if (outcome.status !== 'completed') return;
      patch({ avatarUrl: outcome.value.avatarUrl });
    })();
  }, [form.avatarUrl, patch]);

  const submit = useCallback(() => {
    if (!canSubmit(form) || state.client === null) return;
    setError(null);
    patch({ submitting: true });
    void (async () => {
      try {
        const created = await state.client?.createBot(buildCreatePayload(form));
        if (created === undefined) return;
        // 进度页只拿 id：payload 不往 URL 里塞（presentation 契约的同一条纪律）。
        router.push(`/bots/new-progress?botId=${encodeURIComponent(created.id)}`);
      } catch (caught) {
        patch({ submitting: false });
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, [form, patch, router, state.client]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1, backgroundColor: palette.groupedBackground }}
        contentContainerStyle={{
          // 标题自己画，所以要自己让开顶部安全区：这是 push 进来的页，没有原生导航栏兜着。
          // 不写 `insets.top` 的话标题会压在状态栏上（第一版就是这样，被验收截图抓到）。
          paddingTop: insets.top + spacing.sm,
          paddingBottom: insets.bottom + spacing.xxl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            paddingHorizontal: GROUP_INSET,
            marginBottom: spacing.md,
          }}
        >
          <BackButton testID="bot-create-back" fallback="/" />
          <Text style={[typography.title2, { color: palette.label, flex: 1 }]}>
            {t('bots.create')}
          </Text>
        </View>

        <Group header={t('bots.group.basics')}>
          <Row
            testID="bot-field-display-name"
            title={t('bots.field.displayName')}
            last={false}
            accessory={
              <TextInput
                testID="bot-field-display-name-input"
                value={form.displayName}
                onChangeText={onDisplayName}
                placeholder={t('bots.field.displayName.placeholder')}
                placeholderTextColor={palette.tertiaryLabel}
                autoCapitalize="sentences"
                style={[typography.body, styles.input, { color: palette.label }]}
              />
            }
          />
          <Row
            testID="bot-field-name"
            title={t('bots.field.name')}
            subtitle={nameHint ?? undefined}
            last={false}
            accessory={
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <TextInput
                  testID="bot-field-name-input"
                  value={form.name}
                  onChangeText={(name) => {
                    nameTouched.current = true;
                    patch({ name: name });
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="my-agent"
                  placeholderTextColor={palette.tertiaryLabel}
                  style={[typography.body, styles.input, { color: palette.label }]}
                />
                {form.nameStatus === 'checking' ? (
                  <ActivityIndicator size="small" color={palette.secondaryLabel} />
                ) : null}
              </View>
            }
          />
          <Row
            testID="bot-field-avatar"
            // 名字与设置页同一句（`avatar.row`）：这一行是**一个选择器**，不是要贴地址的输入框。
            title={t('avatar.row')}
            // 右边只说"选的是哪一种"（默认 / 某一枚内置 / 自定义），不摆值本身——内置是
            // 一条标识、自定义是一串网址，摆上去都会把标签挤没（设置页真机截图上
            // "Avata/r URL" 就是这么来的）。
            value={t(avatarValueKey(avatarFor({ avatar_url: form.avatarUrl })))}
            disclosure
            last
            onPress={pickAvatar}
          />
        </Group>

        <Group header={t('bots.group.access')} footer={t('bots.access.footer')}>
          {ACL_PRESETS.map((preset, index) => (
            <Row
              key={preset}
              testID={`bot-acl-${preset}`}
              title={t(`bots.acl.${preset}`)}
              subtitle={preset === 'allow_all' ? t('bots.acl.allow_all.hint') : undefined}
              selected={form.aclPreset === preset}
              last={index === ACL_PRESETS.length - 1}
              onPress={() => patch({ aclPreset: preset })}
            />
          ))}
        </Group>

        {error === null ? null : (
          <Text
            style={[
              typography.footnote,
              {
                color: palette.destructive,
                paddingHorizontal: GROUP_INSET,
                marginBottom: spacing.md,
              },
            ]}
          >
            {error}
          </Text>
        )}

        {/* 桌面端同一句提示：首次创建要拉基础镜像，会等一会儿。 */}
        <Text
          style={[
            typography.footnote,
            {
              color: palette.secondaryLabel,
              paddingHorizontal: GROUP_INSET,
              marginBottom: spacing.md,
            },
          ]}
        >
          {t('bots.create.waitHint')}
        </Text>

        <Pressable
          testID="bot-create-submit"
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit(form) }}
          disabled={!canSubmit(form)}
          onPress={submit}
          style={({ pressed }) => ({
            marginHorizontal: GROUP_INSET,
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.md,
            backgroundColor: pressed ? palette.field : palette.card,
            opacity: canSubmit(form) ? 1 : 0.4,
          })}
        >
          <Text style={[typography.body, { color: palette.accent }]}>
            {form.submitting ? t('bots.create.submitting') : t('common.done')}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // `maxWidth` 的理由同 BotSettingsScreen：大字号下输入框不设上限会把标签挤成断词。
  input: { minWidth: 96, maxWidth: '55%', textAlign: 'right', paddingVertical: 2 },
});
