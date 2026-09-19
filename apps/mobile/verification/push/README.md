# 推送负载样例（`xcrun simctl push` 用）

这些是**服务端将来要发的形状**，也是验收用的输入。两侧共用同一份，是因为
"服务端发的"与"客户端认的"漂了之后没有任何东西会报错：通知照旧到达，只是按钮没了、
点不进去、或者分组散开。

| 文件                | 用途                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `approval-1.json`   | 审批等待：`category=approval`（带"允许/拒绝"动作）、`interruption-level=time-sensitive`、badge 1 |
| `approval-2.json`   | 同一会话的**第二条**审批：验证同线程在通知中心归到一组（`thread-id` 相同）                       |
| `run-finished.json` | 跑完：`category=run`（无动作）、`interruption-level=active`、badge 0                             |
| `run-failed.json`   | 失败：正文只说"失败了、哪个 agent"，**不抄错误原文**（锁屏可能被别人看到）                       |
| `foreign-user.json` | 归属是另一个用户：客户端必须**不深链、不提交**（Lody 第 24 条：换号之后串号推送）                |

字段与判据的对应关系（`category` / `thread-id` / `interruption-level`）由
`tests/notifications-bridge.test.mjs` 从 `features/notifications/policy.ts` 反查，
所以这些文件不是手抄的文案，而是**判据的投影**。

跑：

```sh
xcrun simctl push <udid> ai.memoh.ios apps/mobile/verification/push/payloads/approval-1.json
```

整条验收（授权、横幅、分组、动作、深链、前台接住、徽标、未授权不崩）见
`apps/mobile/verification/push/push-run.sh`，服务端契约见
`docs/research/push-contract.md`。

## 整条验收

```sh
pnpm verify:simulator --name 'push acceptance' -- \
  zsh apps/mobile/verification/push/push-run.sh

zsh apps/mobile/verification/push/push-run.sh permission    # 只跑某一步（迭代时用）
```

设备**只来自租约**（`MEMOH_VERIFY_UDID`）：这条验收真的往设备上投推送，挑错设备就是把通知
发到别人正在跑验证的那台上。拿不到租约一律 `exit 2` 并说清谁占着，**不换一台继续跑**；
`MEMOH_PROBE_UDID` 只在 `MEMOH_VERIFY_LEASE_FORCE=1` 时才允许覆盖（判据在
`verification/device.sh`）。**用 `zsh` 跑**，bash 会在最前面明确退出。

它起固定服务端（`verification/fixture/server.mjs`）、全新安装 App、按步骤推负载并截图。
结论与"哪一条没验到"在 [RESULTS.md](./RESULTS.md)；**读它之前不要假定全绿**：

- ✅ 未授权不崩 / 权限由用户触发 / 横幅 / 通知中心 / 分组 / 前台 in_app / 分类注册 /
  提交审批（从同一事件入口注入）/ 跨账号保护；
- ⚠️ **点在系统通知与动作按钮上验不到**（`simctl` 没有触摸注入，Maestro 的坐标点击在
  通知卡片上无效）；徽标也没截到。真机手点那一次得由人做。
