# 推送通道验收结果（2026-09-16）

跑法（一次租一台模拟器，脚本自己起固定服务端）：

```sh
pnpm verify:simulator --name 'push acceptance' -- zsh -euc '
  MEMOH_PROBE_UDID=$MEMOH_VERIFY_UDID bash apps/mobile/verification/push/push-run.sh'
```

设备：`Memoh push acceptance Verify`（iOS 26.5，iPhone 17 Pro）。
产物：`Memoh.app`（Debug，`verification/.artifacts/derived-data`）。
本文件是**结论**；截图与 payload 是证据（同目录）。

## 逐条结果

| #   | 这一步要证什么                                       | 结果               | 证据                                                                                                                                                                                             |
| --- | ---------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ①   | 未授权时投递**不崩**、也不显示                       | ✅                 | `01-unauthorized.png`（屏幕上没有通知文字）、`payload-unauthorized.json`；脚本另断言进程仍在运行                                                                                                 |
| ②   | 权限**由用户在通知子页主动触发**（不是冷启动弹）     | ✅                 | `02-permission-alert.png`（系统框："Memoh" Would Like to Send You Notifications / Don't Allow / Allow）                                                                                          |
| ③   | 授予之后那一行**消失**（状态真的变了）               | ✅                 | `03-permission-granted.png`（"Turn on notifications" 已不在屏幕上；它只在 `notDetermined` 时出现）                                                                                               |
| ④   | 后台收到审批推送 → **横幅**                          | ✅                 | `03-banner.png`（"Waiting for you" + 正文）、`payload-banner.json`                                                                                                                               |
| ⑤   | 通知中心里看得到它（按会话归线程）                   | ✅                 | `04-notification-center.png`、`payload-*`                                                                                                                                                        |
| ⑥   | 点通知本体 → 冷启动深链到该会话                      | ⚠️ **本机验不了**  | 见下"验不到的"                                                                                                                                                                                   |
| ⑦   | 点「允许」→ 深链 + 提交**那一次**审批                | ✅（除原生那一跳） | `assert-approval.py` 对固定服务端收到的帧逐字段断言：`session_id=fixture-session-untitled`、`decision_id=scene-approval-2`、`decision=approve`、**没有 `option_id`**                             |
| ⑦b  | 归属是别的账号的通知 → **什么都不做**                | ✅                 | 注入前后 `/__last-approval-response` 完全相同（没有新帧）                                                                                                                                        |
| ⑧   | 同一会话的两条**归到一组**                           | ✅                 | `06-grouping.png`（一张卡片 + 叠层边缘；App 图标的组计数为 3）                                                                                                                                   |
| ⑨   | 前台收到推送：**不弹横幅**，判据给 `in_app` / `drop` | ✅                 | `07-foreground.png`（`approval_waiting → in_app (fixture-session-untitled)`，屏幕上**没有**横幅文字）、`08-foreground-finished.png`（`run_finished → drop`）                                     |
| ⑩   | 徽标                                                 | ⚠️ **没验到**      | 见下                                                                                                                                                                                             |
| ⑪   | 分类真的注册进系统了                                 | ✅                 | `99-debug-state.png` 的 `categories` 行：`[{"id":"approval","actions":[{"title":"Allow","id":"memoh.approval.allow"},{"id":"memoh.approval.reject","title":"Deny"}]},{"id":"run","actions":[]}]` |

## 没验到的（不许写成"通过"）

1. **点通知本体 / 点系统动作按钮（⑥⑦的原生那一跳）**：`xcrun simctl` 没有触摸注入；
   Maestro 能拉开通知中心、能长按，但**点在通知卡片上没有任何反应**（试了 75% / 80% /
   84% / 95% 四个纵向位置，锁屏与解锁两种状态，全部无效），系统画的动作按钮更够不到。
   所以：
   - 深链 + 提交那一段是**从同一个事件入口注入**验的（`simulateNotificationOpen`，
     走 `onOpen` → 打开会话 → 等那次审批 → 提交），除原生 `didReceive` 这一跳之外完全相同；
   - 判据本身（`routeFor` / `submissionFor` / `matchesCurrentUser`）在
     `apps/mobile/tests/notifications-bridge.test.mjs`，负载解析在
     `modules/memoh-kit/verification/NotificationContractTests.swift`（构建机上跑）。
   - **真机手点一次才算验过**：手机、锁屏、触感、专注模式都在真机那一轮。
2. **徽标没有截到**：推送带的 `aps.badge` 在这几轮里都没有在图标上出现（App 图标不在
   可截到的首页位置，且最后几条推送到达时 App 在前台、被判成 `drop`）。客户端那半边
   （首页聚合 → `setBadgeCount`）在代码里接着、`badgeCountFor` 有单测，但**没有截图证据**。
3. 真实 APNs 送达、生产 `aps-environment`、`apns-collapse-id` 的合并行为。
4. 服务端"在正确时机投递"——发送方不在本仓库。

## 一个真 bug（这一轮验收抓到的）

第一轮验收的形态是：横幅对、通知中心对、就是**没有"允许/拒绝"两个按钮**。原因不是手势：
分类当时注册在**登录之后**（`startNotificationBridge` 挂在 `SessionProvider` 里），而分类必须
在推送**投递那一刻**就已经在系统里——App 没登录/没打开过时收到的推送就永远没有按钮。
修法：`NotificationCategoryRegistrar` 挂在登录闸门**外面**，任何一次启动都注册一次；
`getNotificationCategories` 读回来的那份（⑪）就是它的证据。
