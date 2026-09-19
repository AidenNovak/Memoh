# MemohKit

本地、仅 iOS 的 Expo Swift 模块，唯一 JS 出口为 `@memoh-ios/kit`。本轮只承接消息
列表，未迁移其他原生能力；不提供 Android 实现，也不提供第二套 RN 消息渲染。
参考 Lody 的目录与桥接契约，代码独立实现。

## 使用

```tsx
import { NativeMessageList } from '@memoh-ios/kit';

<NativeMessageList
  key={sessionId}
  turnsJson={JSON.stringify(turns)}
  onReachTop={loadEarlier}
  emptyTitle="Say something"
  emptyBody="This agent is online and waiting."
  style={{ flex: 1 }}
/>;
```

`turns` 必须是 `src/models/chat.ts` 的 `RenderTurn[]`；排序、实时协议、文本追加、
审批和历史分页属于上层。列表不自行请求网络。`ChatScreen` 已接入，未新增分页 API；
有分页能力的宿主可接 `onReachTop`，由宿主负责请求去重和是否还有历史。事件只在用户
进入顶部区域时触发，离开再进入才再次触发，不因布局更新循环请求。

切换会话必须改变 React `key`，销毁旧列表及其跟随状态。没有原生模块或相应 View
时，只展示不可用提示（可传 `unavailableLabel`），不在 import 时加载原生 View，
不暗中切换到 FlatList。安装到旧开发客户端后需要正常 prebuild / pods / 签名构建。

## 渲染与滚动边界

- 使用 UICollectionView、diffable data source、自适应高度和六种独立 cell reuse 类型。
  文本、思考、工具摘要、错误、通知和附件名称均可显示。助手全宽左对齐；用户右对齐、
  最宽 78%，采用系统语义背景与文本色，不沿用 Web 品牌紫。
- **表面的分工**：用户气泡用 `.secondarySystemBackground`（实心，你说的话是实体），
  agent 的机器活动卡片（思考／附件）用 `.tertiarySystemBackground`（容器，
  装着机器活动）。两者**必须不同**——曾经用同一种灰，实测一张工具场景截图里那种灰
  占了 49% 的像素，整屏没有层级。政策由 `MessageListMetrics.{userSurface,activitySurface}`
  表达，颜色映射只在 `MessageBlockCell.color(for:)` 一处。层级靠形态区分，不靠第三个
  灰阶：浅色模式里根本没有第三个能和页面分开的灰。
- **连续工具聚合成一条活动行，不再逐条做卡片**（Lody 规格 §2.2、§7.3）。
  `TranscriptDisplayRow.grouped` 在解码后、后台任务内投影；同一 turn/message/role 内
  连续 tool 合并，任何非 tool 块都会打断。`TranscriptRow` / `BlockKind` 桥接契约不变。
  `ToolActivityGroup` 保存全部原始行，以首个 block 的完整 ID 做 diffable 身份；追加
  工具或非首个工具的 input/output/status 更新都参与相等性比较，不会漏刷新。
- 工具行全宽、透明、无边框，文字 `.footnote` + `.secondaryLabel`，随 Dynamic Type
  缩放；通常一行，辅助字号允许自然折行。图标表达**类型而非状态**：读取、编辑、
  执行、网络、其他；混合用工具图标。类别按首次出现去重，最多三类，中文顿号连接。
  名称忽略大小写按 read/list/search → write/edit/patch/apply → exec/bash/shell/
  command/terminal → fetch/web/http 的顺序匹配，重叠名称按此前后优先级判定。
- 任一工具 running 时右侧显示一个 `UIActivityIndicatorView`，其余状态停掉；预留
  20pt 槽位避免完成时文字重新换行，`prepareForReuse` 必须停动画。视觉上不写
  Running/Done/Failed，不给完成对勾；VoiceOver 的 value 仍会读「运行中」。
- **工具出错不改措辞、不着色**。非零退出码或 `isError` 不等于任务失败，真正失败
  仍由独立 error 块表达（`verified-behaviour.md` 第 15 条，优先于 Lody 的失败配色）。
  诊断沿用 `ToolResultDiagnosis.read`，只进入无障碍描述，不在活动行显示。
- 暂无点击/展开/跳转。整组保留 `message-block-<首个 blockKey>` 标识，VoiceOver
  label 含全部工具的名字、执行位置、标题、入参摘要与诊断；原始 input/output 不丢。
  不从任意 input 猜文件变更数，编辑类统一「编辑了文件」，路径/diff 留待详情功能。
  旧 `ToolState` 与 `MessageListMetrics` 工具卡片政策保留兼容及原有逻辑测试，
  **不再驱动聚合行的视觉状态**。
- 用户气泡上**不写** "You"：右对齐 + 实心气泡已经说明是谁，贴一个 headline 字号的
  "You" 会比用户自己写的话还显眼。屏幕阅读器仍会念角色。
- 复合标识包含 turn、message、role、block 和 kind，不包含文本/时间/高度。
  同一内容增长只 reconfigure 已变化的 item，无 reloadData、无差异动画。
  输入顺序是权威顺序。相同身份的重复块或无效 JSON 拒绝整帧，保留上次有效内容；
  空列表解码失败显示错误提示，不输出原始 JSON 或错误内容到日志。
- 输入合并到最多约 30 次/秒，解码放在后台且一次只有一个解码任务。完成帧仍发布，
  避免高频输入导致饿死；UIKit 与 snapshot 应用只在主线程。完整 JSON 序列化、
  解码与差异比对仍是 O(n)，不是零成本增量协议，不能据此宣称几千条下无掉帧。
- 默认贴底。用户拖动先解除跟随，距底部 24pt 内可重新跟随；上翻露出 44pt 系统
  回底按钮。历史前插/上方高度变化时恢复首个可见 item 的相对位置。估算高度后续
  收敛及容器变化也会重新贴底；跟随期间不播放滚动动画，不抢正在拖动的手势。
- Dynamic Type 使用 preferredFont 与自动字号更新，所有颜色用 UIColor 语义色。
  VoiceOver 标签包含角色和内容；工具运行状态用 value 文字，视觉用 spinner。原生静态文案资源
  随模块提供中英两种语言，空态文案由宿主现有 i18n 传入。
- 工具入参摘要仅保留在 VoiceOver（扁平对象摊成 `key: value`，嵌套退回紧凑 JSON，
  按 600 字符截断）；**output 不在视觉上展示**；附件不下载/预览；思考可展开收起。不含完整
  Markdown、高亮、diff、文本选择菜单或工具交互。这些应分别扩展对应 cell，
  不加入列表调度器。

没有模块级事件订阅；view 事件随 React View 生命周期解绑。UIKit delegate 是弱引用，
布局回调及后台任务返回均弱持有 view，不会在卸载后保活视图。trait 注册随 view 释放。

## 新增 View

1. 在 `ios/<Feature>/` 添加 ExpoView，UIKit 更新留在主线程；复杂 props 使用 JSON 字符串。
2. 在现有 `MemohKitModule.definition()` 注册 View、Prop 和 Events；不创建第二个模块。
3. 在 `src/<feature>/` 添加 typed wrapper，由 `src/index.ts` 导出。命令式能力应在同一
   feature 建 typed facade，异步 UIKit 方法显式 `.runOnQueue(.main)`。
4. 需要订阅模块事件时，在 React effect cleanup 中 remove；原生侧释放 observer/task。
5. 加无凭据行为检查，并在每个宿主补截图和时序录屏。不要只改生成的 `apps/mobile/ios`。

Expo 配置、package、podspec 已提供，不增加第三方 Swift 依赖；现有 tsconfig 已有别名。
Podspec 的源码范围仅 `ios/`，verification 不参与产品构建。

## 验证

纯逻辑部分（数据、政策、折叠状态、布局计算）**已能在任何机器上跑**：

```sh
pnpm ios:test:swift      # 传到构建机的 swift 容器里编译运行，不需要模拟器
pnpm ios:typecheck:kit   # UIKit 文件的类型检查（本机，几秒）
```

`ios:test:swift` 跑 `verification/MessageListTests.swift` 里 `#if !canImport(UIKit)` 那一半
（Foundation-only，用 swift-corelibs-xctest 的 runner）。当前 17 项通过：原有 10 项未改，
新增聚合边界、分类、混合措辞上限、运行状态、中性色与原始数据/稳定身份检查。

但**它看不见 UIKit 文件里的编译错误**——踩过两次（`let` 变量做 `+=`、把 UILabel 属性
遮蔽成 String），都是纯逻辑测试全绿、iOS 构建才报错，代价是等一轮几分钟的 xcodebuild。
`ios:typecheck:kit` 补上这一环：`swiftc -typecheck` 走完整类型检查但不链接、不要模拟器，
几秒出结果，已接进 `pnpm ios:check`。

覆盖范围有边界，别当成"Swift 都查了"：它检查 `MessageCells.swift`（六种 cell 的
渲染逻辑，也就是上面那两个错所在），**不检查 `NativeMessageList.swift`**——那个文件
`import ExpoModulesCore`，而 Pods 里那份预编译 xcframework 是稍旧的编译器构建的
（SDK 6.3.1 vs 本机 6.3.3），本机 swiftc 解析不了它的 swiftinterface。列表调度那一块
只能靠真正的 xcodebuild 兜底。

UIKit 宿主部分（`testActivitySurfaceDiffersFromUserBubble`、工具聚合行样式/无障碍/复用、
非首个工具结束时列表刷新、列表虚拟化、贴底、上翻保持、回底与非法帧保留）跑在
**hosted XCTest target** 里：config plugin `plugins/withKitTests.js` 在 prebuild 时把它
注入生成工程（宿主 = App，源码直接编进测试 bundle），跑法是

```sh
pnpm ios:test:hosted     # 需要先 ios:prebuild + ios:pods
```

它要 prebuild + pods + 一次模拟器构建，所以**不在 `ios:check` 里**（那条要几十秒给出
"代码自洽"的答复）。改了 `modules/memoh-kit/ios/` 的原生代码就要跑它。

视觉与交互的现状用**场景截图**看，不靠回忆（场景台本身还在 App 里：`/debug/scene/<id>`，
从设置进入，不需要服务端也不需要凭据）：

- **自动截图的 harness 已删**（2026-09-19，重写形态待定，见 memoh-ios-dev.md §9），
  所以现在只能在模拟器里人工打开场景、人工截图。
- 同一批删除里还带走了 `verification/ui/tools/measure_surfaces.py`（像素配色测量，
  它当年量出"用户气泡和活动卡是同一种灰、占 49% 像素"）。要重做分层判据时先把它写回来。
- 像素级判据（字号、间距、截断）本来就不该只靠工具看，**看图仍是必须的**。

人工验收仍需检查（待验证项，不是已通过结论）：

- 千条历史中最后一项持续增字，录屏观察换行与贴底，无闪烁/跳动；用 Instruments 看帧耗时。
- 上翻期间持续流式输出，不夺走位置；前插历史保持同一行；回底按钮恢复跟随。
- 字号切到最大、亮暗切换、横竖屏/iPad、键盘开合，确认高度、锚点和按钮安全区。
- VoiceOver 朗读角色/工具状态、三指滚动与回底、超长单块、空态、全部 block 类型。
- 无原生模块的旧 dev client 能显示不可用提示；标题、输入器、审批流程未回归。

截图记录视觉状态，录屏记录时序；以上均为待验证项，不是已通过结论。

## 设计决定为什么这么定

这个模块的每条视觉规则都应该能回答"为什么"，否则下一轮改的人会以为是随手写的。
依据分三类，都写在代码注释里：

1. **平台惯例**：用户气泡不写 "You"、"工具名是主体状态是修饰" 这类。
2. **上游产品规则**：工具出错不着色直接引自上游 Web 客户端的注释
   （`apps/web/src/pages/home/components/tool-call-inline.vue:225`），
   见 `docs/research/verified-behaviour.md` 第 15 条。
3. **实测数据**：表面分层那条来自真实截图的像素测量，不是审美偏好。

如果你要推翻某条规则，请连依据一起推翻——"我觉得不好看"不足以推翻第 2、3 类。
