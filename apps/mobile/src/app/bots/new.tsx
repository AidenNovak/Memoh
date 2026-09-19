/**
 * 新建 bot 的表单路由。
 *
 * 挂在**根栈**：它是从切换器 sheet 推进来的一页，要盖住底部 tab 栏
 * （瞬时流程用 `present()`，而这是"往下走一层、做完才回来"，见 `docs/presentation.md`）。
 */
import { BotCreateScreen } from '../../screens/BotCreateScreen.tsx';

export default BotCreateScreen;
