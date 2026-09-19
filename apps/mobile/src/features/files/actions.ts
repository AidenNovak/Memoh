/**
 * 长按的动作清单模型。
 *
 * 形态是**原生 context menu / action sheet**（不是行内 swipe、也不是一排按钮）：
 * 行内 swipe 在只读列表上没有语义（iOS 的 swipe 表示"对这条记录做改变状态的快捷动作"），
 * 而一排按钮会把每一行撑高。见 `docs/research/ios-files-spec.md` §3 与设计稿的说明。
 *
 * 这个模块只产出"该显示哪些动作、哪些点不了、为什么"，不管怎么画——
 * 画法（`ActionSheetIOS`）在屏幕那一层。
 */

import type { DownloadCapability } from './download.ts';

export type FileActionId = 'open' | 'copyPath' | 'download' | 'diff';

export interface FileAction {
  id: FileActionId;
  labelKey: string;
  enabled: boolean;
  /** 不可用的原因（i18n key）。**必须给**：点不了又不说的动作等于坏掉的动作。 */
  reasonKey?: string;
}

export interface FileActionInput {
  isDir: boolean;
  /** 这个文件这次会话里有没有改动（diff 是下一轮，这里只留形状）。 */
  hasDiff: boolean;
  download: DownloadCapability;
}

/**
 * 清单顺序就是用户的心智顺序：先打开，再拿走信息，最后才是"看它改了什么"。
 *
 * 「看改动」只在真的有 diff 时出现——没有 diff 时给一个永远空的页面是负分。
 */
export function fileActions(input: FileActionInput): FileAction[] {
  const actions: FileAction[] = [
    { id: 'open', labelKey: 'files.action.open', enabled: true },
    { id: 'copyPath', labelKey: 'files.action.copyPath', enabled: true },
  ];

  if (input.download.available) {
    actions.push({ id: 'download', labelKey: 'files.action.download', enabled: true });
  } else {
    actions.push({
      id: 'download',
      labelKey: 'files.action.download',
      enabled: false,
      reasonKey: input.download.reasonKey,
    });
  }

  if (input.hasDiff) {
    actions.push({ id: 'diff', labelKey: 'files.action.diff', enabled: true });
  }

  return actions;
}
