/**
 * 定时编辑页的几何：**正在编辑的那一栏不许被键盘盖住**。
 *
 * ## 为什么单独成文件
 *
 * 这一页在实机上失败过（`docs/research/review-ux-flows.md` §7.2），而失败的样子不像
 * "输入框坏了"：键盘升起时 `KeyboardAvoidingView` 只把 `ScrollView` 的高度让开，
 * **内容不会自己让位**，于是最下面那一栏有一截留在键盘底下；用户点它时手指落在键盘上
 * → 焦点没换 → 接着打的字被追加进**上一层仍是焦点的框**里（描述框），
 * 而底部还挂着 `Can't save yet — Tell the agent what to do`。
 *
 * 修法是"谁拿到焦点，谁就整个在键盘上面"，它由两步算术组成：
 *
 * 1. `visibleBottom` —— 现在**真正看得见的下边界**在哪（没有键盘时是屏幕底，键盘升起时是
 *    键盘顶边；两个都取一遍，动画中途也不会算错）；
 * 2. `scrollOverlap` —— 这一栏还要往上滚多少才整个露出来（含"贴着键盘顶边看着仍像被压着"
 *    的一行间距）。
 *
 * 为什么把这半步挪出来：它有清楚的几何边界；留在屏幕里的话，只能靠一台特定尺寸的
 * 手机碰巧暴露。
 */

/** 看得见的下边界（窗口坐标：往下越大）。 */
export function visibleBottom(input: {
  /** 键盘顶边；`null` = 键盘不在（还没起来 / 刚收起）。 */
  keyboardTop: number | null;
  windowHeight: number;
  bottomInset: number;
}): number {
  const screenBottom = input.windowHeight - input.bottomInset;
  if (input.keyboardTop === null) return screenBottom;
  // 取更靠上的那个：键盘盖住屏幕底时是键盘说了算；键盘只有一小条（或外接键盘把
  // 安全区让开了）时仍是屏幕底说了算，免得把内容白滚一段。
  return Math.min(input.keyboardTop, screenBottom);
}

/**
 * 这一栏还要往上滚多少（窗口坐标里的一截长度）。
 *
 * 已经整个露出来 → `0`（别为了"对齐"白滚一下，用户会看到页面自己动）。
 */
export function scrollOverlap(input: {
  /** 这一栏在窗口坐标里的上缘与高度（`measureInWindow` 给的）。 */
  inputTop: number;
  inputHeight: number;
  /** `visibleBottom` 的结果。 */
  limit: number;
  /** 留的间距：贴着键盘顶边的那一栏看起来仍然像"被压着"。 */
  gap: number;
}): number {
  const overflow = input.inputTop + input.inputHeight + input.gap - input.limit;
  if (overflow <= 0) return 0;
  return overflow;
}
