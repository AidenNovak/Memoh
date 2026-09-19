/**
 * 外观设置页的路由。
 *
 * 挂在**根栈**：它是从设置推进去的"下一页"，要盖住底部 tab 栏。
 * 一页只有三行选项 + 一个开关，所以是 push 而不是瞬时流程的 sheet——
 * 用户在页里挑、挑完自己返回，没有"确认/取消"这个语义。
 */
import { AppearanceScreen } from '../screens/AppearanceScreen.tsx';

export default AppearanceScreen;
