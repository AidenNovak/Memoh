/**
 * 时区选择器：**组装原生选择器的模型 + 等一个结论**。
 *
 * 这一份替掉 `ui/TimezonePickerPage.tsx`（那张 RN sheet 已删除）。值域是 **419 项**
 * （`TIMEZONES`），所以三件事照着原页的裁决原样保留：
 *
 * | 裁决 | 这里 |
 * | --- | --- |
 * | 必须可搜索（别让用户滚 419 项） | 搜索框 + `filterTimezones`（`new york`、`shanghai`、`asia/` 都能命中） |
 * | 进来先回答"我现在是哪个" | 分组标题那一行写当前生效值（继承时说清是部署默认），列表里那项也打勾 |
 * | 给一个显式的"继承/默认"档，不猜 | `INHERIT_TIMEZONE` 那一行排在最上面，搜索时收起来 |
 *
 * ## 与 spec 的偏差：当前值那一行放哪
 *
 * 原页在搜索框**上面**固定画一行 `timezone-current`（"现在生效的是哪个"），而原生契约里
 * 没有"副标题/提示行"这个位置——只有 `title`、分组 `header`、行。
 *
 * 所以那一行**放进分组标题**（`sections[0].header`）：语义没变（它仍然在列表上方、
 * 仍然回答"我现在是哪个"），而且原页这个列表本来就没有分组标题，占这个位置不挤掉任何东西。
 * 代价说清楚：原生把 header 画成**大写小标题**，这句话的观感会比原来那一行更"标题化"；
 * 以及它只在列表可见时在（加载/失败态下不画）。
 *
 * 另外：`FlatList` 的虚拟化不需要了——列表由原生画，419 行不再经过 RN 的视图树。
 */
import { t } from '../../lib/i18n/index.ts';
import {
  presentNativePicker,
  type NativePickerHandle,
  type NativePickerRequest,
} from '../../lib/presentation/nativePicker.ts';
import type { PresentationResult } from '../../lib/presentation/sessions.ts';
import {
  INHERIT_TIMEZONE,
  effectiveTimezone,
  filterTimezones,
  normalizeTimezone,
  timezoneCity,
  timezoneSubtitle,
} from './timezones.ts';

export interface TimezonePickerParams {
  /** 当前选择：`''`（继承部署默认）或 IANA 名字。 */
  timezone: string;
}

export interface TimezonePickerResult {
  timezone: string;
}

export function presentTimezonePicker(
  params: TimezonePickerParams,
): Promise<PresentationResult<TimezonePickerResult>> {
  const selected = normalizeTimezone(params.timezone);
  /** 顶部那句话说的就是"现在生效的是哪个"——不是"你选过哪个"。 */
  const current = effectiveTimezone(selected);
  /** 搜索框里的字。过滤留在 RN（`filterTimezones`），原生只把击键报回来。 */
  let query = '';

  const buildRequest = (): NativePickerRequest => {
    const searching = query.trim() !== '';
    const zones = filterTimezones(query);
    return {
      title: t('timezone.label'),
      searchPlaceholder: t('timezone.search'),
      // 沿用原页的标识（`ui/TimezonePickerPage.tsx` 的搜索框就是 `timezone-search`）。
      searchTestID: 'timezone-search',
      sections: [
        {
          id: 'zones',
          header: current.inherited
            ? t('timezone.current.inherited', { timezone: current.zone })
            : t('timezone.current.set', { timezone: current.zone }),
          rows: [
            // 搜索时把"继承"那一行收起来（与语言选择器同一条规矩）：用户已经在按地名
            // 找某个具体时区了。
            ...(searching
              ? []
              : [
                  {
                    // 行 id 用 `inherit` 而不是空串：`''` 在 testID 里拼不出可断言的名字。
                    id: 'inherit',
                    label: t('timezone.inherit'),
                    detail: t('timezone.inherit.hint'),
                    selected: selected === INHERIT_TIMEZONE,
                    valueJson: JSON.stringify({ timezone: INHERIT_TIMEZONE }),
                  },
                ]),
            ...zones.map((zone) => ({
              id: zone,
              label: timezoneCity(zone),
              // 全名 + 城市：手机上列表窄，先看城市，但全名也得给出来（重名的城市不止一个）。
              detail: `${zone} · ${timezoneSubtitle(zone)}`,
              selected: selected === zone,
              valueJson: JSON.stringify({ timezone: zone }),
            })),
          ],
        },
      ],
      emptyLabel: t('timezone.empty'),
    };
  };

  return presentNativePicker<TimezonePickerResult>(buildRequest(), {
    onSearch: (text, handle: NativePickerHandle) => {
      query = text;
      handle.update(buildRequest());
    },
  });
}
