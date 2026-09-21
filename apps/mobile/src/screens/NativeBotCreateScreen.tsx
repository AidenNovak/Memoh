/**
 * 新建 bot 的 RN 薄桥（模块 7）。
 *
 * 原生持有分组表单（基本信息 / 访问档位 / 提交）；RN 保留表单状态、名字可用性
 * （本地判形状与保留字 → 400ms 防抖问服务端）、头像选择器（原生 sheet：RN 只组装请求，
 * 见 `features/bots/avatarPicker.ts`）、提交与路由（先创建、再 push 进度页轮询）。
 * 判据全部留在 `features/bots/create.ts`，与桌面端 `new.vue` 的对齐关系见原文件头，未改。
 */
import { NativeBotFormView, type NativeBotFormModel } from '@memoh-ios/kit';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

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
import { useConnectionState, useSession } from '../features/session/store.tsx';
import { useT } from '../lib/i18n/useT.ts';
import { useTheme } from '../lib/theme/context.tsx';
import { presentAvatarPicker } from '../features/bots/avatarPicker.ts';

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

export function NativeBotCreateScreen() {
  const t = useT();
  const router = useRouter();
  const { mode } = useTheme();
  const { state } = useSession();
  // 头像选择器每一格的头像计划要知道"连接恢复了没有"（远程头像失败后原生最多重试一次）。
  const connectionOpen = useConnectionState() === 'open';

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

  const pickAvatar = useCallback(() => {
    void (async () => {
      const outcome = await presentAvatarPicker({ avatarUrl: form.avatarUrl, connectionOpen });
      if (outcome.status !== 'completed') return;
      patch({ avatarUrl: outcome.value.avatarUrl });
    })();
  }, [connectionOpen, form.avatarUrl, patch]);

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

  const model = useMemo<NativeBotFormModel>(() => {
    const sections: NativeBotFormModel['sections'] = [
      {
        id: 'basics',
        header: t('bots.group.basics'),
        rows: [
          {
            id: 'bot-field-display-name',
            kind: 'text',
            label: t('bots.field.displayName'),
            key: 'displayName',
            value: form.displayName,
            placeholder: t('bots.field.displayName.placeholder'),
          },
          {
            id: 'bot-field-name',
            kind: 'text',
            label: t('bots.field.name'),
            key: 'name',
            value: form.name,
            placeholder: 'my-agent',
            hint: nameHint ?? '',
            busy: form.nameStatus === 'checking',
          },
          {
            id: 'bot-field-avatar',
            kind: 'nav',
            label: t('avatar.row'),
            value: t(avatarValueKey(avatarFor({ avatar_url: form.avatarUrl }))),
            action: 'pickAvatar',
          },
        ],
      },
      {
        id: 'access',
        header: t('bots.group.access'),
        footer: t('bots.access.footer'),
        rows: ACL_PRESETS.map((preset) => ({
          id: `bot-acl-${preset}`,
          kind: 'radio' as const,
          label: t(`bots.acl.${preset}`),
          hint: preset === 'allow_all' ? t('bots.acl.allow_all.hint') : '',
          key: 'aclPreset',
          value: preset,
          selected: form.aclPreset === preset,
        })),
      },
    ];
    if (error !== null) {
      sections.push({
        id: 'error',
        rows: [{ id: 'bot-create-error', kind: 'glyph', label: error, glyph: '✕', tone: 'bad' }],
      });
    }
    // 桌面端同一句提示：首次创建要拉基础镜像，会等一会儿。
    sections.push({
      id: 'submit',
      footer: t('bots.create.waitHint'),
      rows: [
        {
          id: 'bot-create-submit',
          kind: 'button',
          label: form.submitting ? t('bots.create.submitting') : t('common.done'),
          disabled: !canSubmit(form),
          action: 'submit',
        },
      ],
    });
    return { status: 'ready', title: t('bots.create'), sections };
  }, [form, error, nameHint, t]);

  return (
    <View style={{ flex: 1 }}>
      <NativeBotFormView
        style={{ flex: 1 }}
        mode={mode}
        modelJson={JSON.stringify(model)}
        onBack={() => {
          if (router.canGoBack()) router.back();
          else router.replace('/');
        }}
        onField={(event) => {
          const key = event.nativeEvent.key;
          const value = event.nativeEvent.value ?? '';
          if (key === 'displayName') onDisplayName(value);
          else if (key === 'name') {
            nameTouched.current = true;
            patch({ name: value });
          } else if (key === 'aclPreset') {
            patch({ aclPreset: value as BotFormState['aclPreset'] });
          }
        }}
        onAction={(event) => {
          const action = event.nativeEvent.action;
          if (action === 'pickAvatar') pickAvatar();
          else if (action === 'submit') submit();
        }}
      />
    </View>
  );
}
