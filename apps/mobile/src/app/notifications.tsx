/**
 * 通知设置页的路由。
 *
 * 和 `/appearance` 同构：挂在**根栈**，是从设置推进去的"下一页"，要盖住底部 tab 栏。
 * 页里有可点的行（打开系统设置），但整页没有"确认/取消"这个语义，所以是 push 而不是
 * 瞬时流程的 sheet——用户看完、点完，自己返回。
 */
import { NotificationsScreen } from '../screens/NotificationsScreen.tsx';

export default NotificationsScreen;
