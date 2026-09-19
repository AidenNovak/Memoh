/**
 * bot 设置页的路由。
 *
 * 挂在**根栈**并带 `botId` 查询参数：它是"从某处推进去的一页"，要盖住底部 tab 栏
 * （与 `schedule/edit` 同一个形态）。
 *
 * 为什么不把 `botId` 放进路径段：这一页没有"给自己一个地址"的必要（不像会话要能深链回
 * 某一轮对话），而查询参数与 `presentation` 那套"参数不进 URL 段"的纪律一致。
 */
export { BotSettingsRoute as default } from '../../screens/BotSettingsScreen.tsx';
