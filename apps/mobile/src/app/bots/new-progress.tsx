/**
 * 新建 bot 的进度路由。
 *
 * URL 里只有 `botId`——payload 与阶段都在内存里（同 `presentation` 那条纪律：
 * 参数不进 URL，URL 只放得下"是哪一次"）。
 */
export { BotCreateProgressRoute as default } from '../../screens/BotCreateProgressScreen.tsx';
