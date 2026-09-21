/**
 * 头像选择器：**组装原生选择器的模型 + 等一个结论**。
 *
 * 这一份替掉 `ui/AvatarPickerPage.tsx`（那张 RN sheet 已删除）。原来那页的两条判据
 * 原样保留，它们都有"写错了也不明显"的分岔：
 *
 * 1. **当前值是内置标识时不许回填进自定义输入框**（`isBuiltinAvatar`）：它长得像个 scheme，
 *    用户会以为要照着它改；而且那样打开选择器时看起来像"我选的是自定义"，与他实际挑的
 *    那一枚对不上。
 * 2. **自定义网址不校验格式**：服务端本来就不校验（`strings.TrimSpace` 直接进库），
 *    在这里做一套只有我们认的校验，只会把"我们的桶地址"挡在外面。画不出来时
 *    `BotAvatar` 会退回吉祥物（那条判据有测试），所以坏值不会变成空白方块。
 *
 * ## 落库形态仍然只有一个字符串
 *
 * 挑内置 → `memoh:avatar/<slug>`；挑默认 → 空串（回到吉祥物）；自定义 → 用户打的那个网址。
 * 三种值都走同一条差分保存（`features/bots/settings.ts` 的 `patchFrom`），服务端形状照旧
 * ——没有新端点、没有新字段。为什么这么存、代价是什么，见 `avatarPresets.ts` 的文件头。
 *
 * ## 网格里画的是什么（与原页的差别，明说）
 *
 * 原页每一格画的是**真组件**（`BotAvatar`：远程图 / 吉祥物 / 内置图形），因为"选择器里
 * 看到的必须就是列表里将要画出来的样子"。原生网格只能画 SF Symbol 符号块
 * （契约里行只有 `symbol` 一个图形字段），所以：
 *
 * - 内置那 10 枚：同一个符号名，图形一模一样（`BUILTIN_AVATARS.symbol`）。
 * - 「默认」那一格：原页画的是 Memoh 吉祥物（`brand-mark.png`），这里退成系统人物剪影
 *   `person.crop.circle`——与 `HubChrome.swift` / `NativeSessionsView.swift` 里
 *   "这个 bot 没有头像"用的是同一颗 glyph，不是新发明一个形状。
 * - **当前值是远程图片时不画缩略图**（原页会画）：`symbol` 是 SF Symbol 名，塞不进一张
 *   网络图。判据没丢——自定义那一栏仍然填着它。
 *
 * 自定义那一栏也变了一处：原页只在"输入框里有字"时才画「用这个图片」那一行（空的时候
 * 没有东西可提交），原生那颗按钮**常显**。空着按它 = 提交空串 = 回到「默认」，
 * 与上面那一格是同一个结果，所以没有多出什么状态。
 */
import { symbolName } from '@memoh-ios/kit';

import { t } from '../../lib/i18n/index.ts';
import {
  presentNativePicker,
  type NativePickerHandle,
  type NativePickerRequest,
} from '../../lib/presentation/nativePicker.ts';
import type { PresentationResult } from '../../lib/presentation/sessions.ts';
import { avatarFor } from './avatar.ts';
import { BUILTIN_AVATARS, builtinAvatarToken, isBuiltinAvatar } from './avatarPresets.ts';

export interface AvatarPickerParams {
  /** 当前草稿值（空串 = 默认吉祥物；`memoh:avatar/<slug>` = 内置；其余 = 自定义网址）。 */
  avatarUrl: string;
}

export interface AvatarPickerResult {
  avatarUrl: string;
}

/** 「默认」那一格的图形。见文件头：吉祥物是图片资源，原生网格只认 SF Symbol 名。 */
const DEFAULT_SYMBOL = 'person.crop.circle';

export function presentAvatarPicker(
  params: AvatarPickerParams,
): Promise<PresentationResult<AvatarPickerResult>> {
  const current = params.avatarUrl;

  // 自定义网址那一栏的初值：**当前值就是网址**时才填进去（见文件头第 1 条）。
  let custom = current !== '' && !isBuiltinAvatar(current) ? current : '';

  const plan = avatarFor({ avatar_url: current });
  const selectedSlug = plan.kind === 'builtin' ? plan.slug : null;
  /** 当前值是空串 = 选的是"默认"。 */
  const defaultSelected = plan.kind === 'mark';

  const buildRequest = (): NativePickerRequest => ({
    title: t('avatar.row'),
    sections: [
      {
        id: 'builtin',
        header: t('avatar.builtin.group'),
        layout: 'grid',
        rows: [
          // 「默认」排第一个：它是"我什么都不挑"的那个选项，也是现在不加任何东西时的样子。
          {
            id: 'default',
            label: t('avatar.default'),
            symbol: DEFAULT_SYMBOL,
            selected: defaultSelected,
            valueJson: JSON.stringify({ avatarUrl: '' }),
          },
          ...BUILTIN_AVATARS.map((preset) => ({
            id: preset.slug,
            label: t(preset.nameKey),
            symbol: symbolName(preset.symbol),
            selected: selectedSlug === preset.slug,
            valueJson: JSON.stringify({ avatarUrl: builtinAvatarToken(preset) }),
          })),
        ],
      },
    ],
    input: {
      label: t('avatar.custom'),
      placeholder: t('avatar.custom.placeholder'),
      // 受控：击键过桥回到这里（`onInput`），改完再推回去。
      value: custom,
      submitLabel: t('avatar.custom.apply'),
    },
  });

  /** 提交自定义网址（键盘的"完成"与底部那颗按钮是同一条路）。 */
  const applyCustom = (text: string, handle: NativePickerHandle) => {
    custom = text;
    handle.finish({ avatarUrl: custom.trim() });
  };

  return presentNativePicker<AvatarPickerResult>(buildRequest(), {
    onInput: (text, handle) => {
      custom = text;
      handle.update(buildRequest());
    },
    onSubmit: applyCustom,
  });
}
