# Memoh iOS 开发说明

**这份是 iOS 侧唯一的文档。** 设计基线、协议契约、我们对上游做的每一处改动，都在这里。
（2026-09-19 口径：不引入过多新文档。iOS 客户端代码里引用的 `docs/…` 是 memoh-ios 时期的
文档，见 §8。）

---

## 1. 这个仓库是什么

`felinics/Memoh` 的 fork：**上游整仓 + 我们的 iOS 客户端（`apps/mobile`）**。

|                                                               | 是什么                         | 谁在改                 |
| ------------------------------------------------------------- | ------------------------------ | ---------------------- |
| `apps/mobile/`                                                | iOS 客户端（**唯一交付物**）   | 我们                   |
| `apps/mobile/modules/memoh-kit/`                              | 一方原生能力与原生 UI（Swift） | 我们                   |
| `cmd/ios-push-gateway/`                                       | 设备注册与 APNs 推送 sidecar   | 我们                   |
| `tools/`                                                      | iOS 侧编译检查、资产与发布脚本 | 我们                   |
| `infra/`                                                      | 联调隧道与 dev 栈脚本          | 我们                   |
| 其余（Go 服务端 / `apps/web` / `apps/desktop` / `packages/`） | 上游                           | 上游，**我们尽量不动** |

- **上游基线**：`22752cd`（2026-09-19 上游 `main`），`spec/swagger.json` **267 条路径**。
- **客户端来源**：`AidenNovak/memoh-ios`（同一份代码，换了落点）。
- **为什么是 fork 而不是独立仓库**：协议的事实源就是上游源码本身，而"这个功能现在能不能用"
  只有部署实例能回答。把 iOS 放进上游树里，三件事一次解决——读协议不用另开副本、服务端要改时
  落点唯一、跟着上游走只差一次 rebase。
- **rebase 的代价要记住**：我们改上游文件越少，rebase 越便宜。§6 那张表就是全部改动，
  加一行之前先想想能不能不加。
- **怎么跟上游**：`git fetch upstream && git merge upstream/main`（或 rebase）。
  远程约定：`upstream` = `felinics/Memoh`，`origin` = 我们在 GitHub 上的这个 fork。
  冲突只会落在 §6 那 6 个文件上，其余是纯新增。

---

## 2. 跑起来

```bash
pnpm install                  # 根安装（含上游依赖；iOS 侧的依赖也在这里）
pnpm ios:check                # Swift 类型检查 + 类型/i18n/三元/按压态/lint/格式
pnpm ios:typecheck:foundation # 只查 Foundation-only 的 Swift（macOS SDK，几秒）
pnpm ios:typecheck:kit        # 查 UIKit 那批 Swift（要 iOS SDK，几秒）
pnpm ios:bundle               # expo export（证明 JS bundle 能产出，不碰 Xcode）
pnpm ios:run                  # 装到模拟器/真机（要 Xcode）
pnpm ios:prebuild && pnpm ios:pods   # 从 app config 生成原生工程 + 装 Pods
pnpm ios:dev-env              # 起 dev 栈隧道（18080 API / 18082 Web）
pnpm ios:release:testflight --upload     # 取下一个构建号、归档、签名、上传并挂内部组
```

- 根脚本全部带 `ios:` 前缀，**与上游脚本不重名**：`pnpm lint` / `pnpm test` 仍然是上游的
  整仓门禁，`pnpm ios:*` 才是我们这一侧。两者都要绿。
- **提交会走上游的 husky 钩子**（`check-large-files` / `check-go` / `check-go-test` / `check-web`）。
  本机没装 Go 工具链时那两条自己跳过；`check-web` 会跑 `lint-staged`，iOS 侧由
  `apps/mobile/package.json` 里那份配置接管（见 §7 第 4 条）。

### TestFlight 发布

- App Store Connect 的正式边界是 team `7533A52C52`、bundle `ai.memoh.ios`；凭据只从
  `ASC_KEY_PATH` / `ASC_KEY_ID` / `ASC_ISSUER_ID` 读取，私钥与签名材料不进仓库。
- `pnpm ios:release:testflight` 只生成并核对签名 IPA；只有显式加 `--upload` 才写入 ASC。
  脚本先要求 tracked worktree 干净，再从 ASC 取最大构建号 + 1，重跑 prebuild/Pods，生成
  未签名 archive，以 `Memoh iOS App Store (mini)` 手工签名导出，并逐一核对 archive 与 IPA
  的 bundle/version/build。上传后等到 `VALID` 才挂到现有内部测试组；失败或超时不会假报成功。
- CLI 的 archive/export 都带 ASC API key。脚本从仓库外的 loose key/cert 每次创建一次性
  keychain，所以**不需要知道旧签名钥匙串密码**；结束即恢复 search list 并删除临时钥匙串。
  archive 阶段就用手工发行身份/profile 签名，export 再用同一 profile；不能先做未签名
  archive，因为实测那会让最终 IPA 丢失 production APNs entitlement。
  `manageAppVersionAndBuildNumber=false`，构建号只由 `MEMOH_BUILD_NUMBER` → `app.config.ts`
  决定，避免 Apple 在导出期悄悄改号。
- Release 默认服务器是 `https://memoh.yetodawn.com`。TestFlight 身份与 Memoh 身份是两层：
  ASC 决定谁能装包，Memoh member 决定谁能登录与看哪个 Bot；内测账号只授予共享
  `ios-dev` 的 Bot 级 `manage`（覆盖 App 的聊天/文件/schedule/设置），**不授予服务器
  admin**。这个 Bot 是内测专用；增加第二位测试员前要给每人独立 Bot，避免彼此看见会话。

### 构建检查

| 检查                                           | 覆盖                                                                                                            | 本机可跑                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `ios:check`                                    | **Swift 类型检查（Foundation-only + UIKit 两批）** + TS 类型、i18n 键、禁嵌套三元、按压态两档、ESLint、Prettier | ✅（Swift 那两条要 Swift 工具链 / Xcode） |
| `ios:typecheck:foundation`                     | 4 个 Foundation-only 的 Swift 文件（`swiftc -typecheck`，不要 Xcode SDK）                                       | ✅                                        |
| `ios:typecheck:kit`                            | UIKit 文件的类型检查（要 iOS SDK；**不含** `NativeMessageList.swift`，见 `tools/typecheck-kit.sh`）             | ✅（要 Xcode）                            |
| `ios:bundle`                                   | Metro 能出 iOS bundle                                                                                           | ✅                                        |
| Xcode Debug build                              | 生成工程、Pods、原生模块注册与 Swift/ObjC 链接                                                                  | ✅（要 Xcode）                            |

---

## 3. iOS 端设计

### 3.1 硬规则

**颜色**

- 系统语义色是默认答案。必须自定义的只有 5 类：微暖背景 `backgroundPrimary`、品牌紫两档、
  用户气泡两档、chat 过程标题色。
- 背景**不用纯白 systemBackground**，用微暖 `#FBFAF8`（暗色 `#060606`）—— 微暖是品牌特征。
- 品牌紫 = `oklch(0.55 0.22 290)`（亮）/ `oklch(0.72 0.16 290)`（暗）。
- 用户气泡**不是简单反相**：亮 = 浅薰衣草 `rgb(238,229,254)` + 深紫黑字；暗 = 实心深紫
  `rgb(83,45,141)` + 白字。
- 语义色用 systemGreen/Orange/Blue/Red 的 soft 变体（0.12 alpha 底 + 纯色字）；
  destructive 用系统红，不自定义。
- 橙色是全 App **唯一**允许表达"需要你"的语义色，只用在待审批聚合区。
- 换肤（ocean/forest/rose/amber）**不做**，只取 memoh 一套。

**字体与字号**

- SF Pro / PingFang 系统栈，**全部走 Dynamic Type**：正文 `.body`、工具卡内文 `.footnote`、
  消息 meta `.caption`、区块标题 `.headline`/`.title3`。
- 唯一的豁免是代码块：13pt `monospacedSystemFont`。
- 不搬 Web 的中英分 script 字重补偿（Latin 420 / CJK 340）—— 那是 CSS 手法。

**触控与无障碍**

- 触控目标最小 44×44pt：视觉可以小，hit test 不行。
- 正文到 `accessibilityExtraExtraExtraLarge` 不截断；气泡宽度用比例不用定值。
- 状态**始终有文字**，颜色只是辅助。
- 错误必须被播报：iOS 用 `announceForAccessibility`（`accessibilityLiveRegion` 在 iOS 上是空转的）。
- 一个可点区域读屏只读容器标签 → 容器标签必须含全部信息。
- `fontScale ≥ 2` 时，位移类动效的距离归零，只留透明度。

**导航与布局**

- 导航栏、列表、卡片一律**实色**。iOS 26 导航栏自带玻璃，**不要叠第二层**。
- 玻璃只给"浮在内容上且需要看到背后"的层：composer 背景、审批背板、↓新消息 pill。
- 间距 4pt 基网格：4/8/12/16/20/24/32。圆角：列表卡 10pt、气泡与 composer 16pt、
  设置列表用系统 inset grouped 默认。
- 阴影体系性排斥；只有真浮层（alert/popover/悬浮 pill）用系统投影，内容一律 hairline 分隔线。
- 设置类列表用系统 Form / inset grouped，不用"小圆角卡片 + 边框"。
- 居中弹窗只用于破坏性 alert，其余用 sheet。
- 不做自绘滚动条；不用 hover 语言（改按压态）；链接不加点状下划线。
- 列表滑动删除用系统 `UISwipeActionsConfiguration`，不要全宽红按钮。
- Chat 页下拉 = 加载更早历史（分页），**不用 refreshControl**（那是"刷新"语义）。
- composer 贴 `keyboardLayoutGuide`，不硬编码 Home 条高度。

**动效**

- 单一曲线 `cubic-bezier(0.16,1,0.3,1)`（easeOutExpo），全 App 统一。
- 系统有现成的就用系统的，**一行动画都不加**：转场、交互式 pop、sheet detent、键盘、
  长按菜单、tab、`UIActivityIndicatorView`。
- 判据：**"用户做了一件事、世界因此变了" → 可有动效；"世界自己在变" → 不加**。
- 动效取消后信息必须还在，且不许让人等动画播完才能操作。
- 流式不闪不跳三条铁律：追加只改文本、不重建 cell；自动滚动只调 `contentOffset`、不动画；
  正文不换字体。
- 整份转录的 JS 投影/序列化与原生 prop 合并同步限制为约 30fps；审批、错误、
  pending 与连接态不经这条节流。离开会话会释放该会话的历史/队列/状态缓存。
- 错误不自动消失，不做 time-boxed。
- Reduce Motion 每个动效点都要有答案；判定 `'unknown'` 时先不启动动画。
- 按压 scale 0.97 / 150ms（继承自 Web 基线）。

### 3.2 信息架构

- **底部 2 个 tab**：会话 / 设置（用 iOS 26 `NativeTabs`，不自绘 tab bar）。
  第二个 tab **直接就是 bot settings**，顶部放 agent 切换器。
- **会话 tab 内三视图互斥**：会话 / 文件 / 定时。当前视图名就是大标题，搜索在同一行右侧。
  定时与文件**不是"另一件事"**，是同一个 agent 的另外两种看法。
- 设置 tab 四组照抄上游 bot 详情（对话 / 能力 / 运行 / 安全），App 自己的设置
  （通知 / 外观 / 语言 / 账号 / 关于）最后单独一组。
- 落地页 = **最近会话**，不是 dashboard（继承上游"落地即 Chat"）。
- **push**：一切"往里钻"的浏览 —— 会话 → Chat → diff、文件目录 → 文件、列表 → 详情。
  文件视图是**一页一目录的 push**，根固定 `/data`。
- **sheet（`present`）**：审批、`ask_user`、会话信息、各种选择器、短任务编辑、媒体预览、BotSwitcher。
- **alert**：仅破坏性确认（删会话 / 删 bot / 删定时任务）与系统权限。
- Onboarding = 登录**之前**的全屏门 3 页（不是 sheet），可跳过。

### 3.3 已经裁决过的取舍（桌面端有什么 → iOS 怎么做 → 为什么）

| 桌面端                          | iOS                                                                                  | 为什么                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 审批在 composer panel           | 做成系统级体验：推送 → 一键进审批                                                    | 手机最大的差异化价值                                                   |
| 容器桌面串流（WebRTC 键鼠回传） | 砍。远期可"看"，不做"控"                                                             | 小屏远程桌面是伪需求                                                   |
| 终端 xterm pane                 | 砍。远期只读 tail                                                                    | 手机打字进终端体验极差                                                 |
| dockview 六 pane 分屏           | 砍，改全屏页间切换                                                                   | 手机没有多窗格空间                                                     |
| 会话/文件/定时三 panel          | 保留；文件只读浏览 + 预览                                                            | 三视图是同一 agent 的三种看法                                          |
| 会话信息 = 上下文环             | 用 `chart.bar.xaxis`；服务端给 `context_window` 再改回环                             | 环只能空着等于骗人                                                     |
| 助手消息是内容                  | 全宽裸文本，不加气泡                                                                 | Messages 就是全宽文本                                                  |
| 用户气泡有尾巴                  | 只靠底色区分，排版与助手一致                                                         | 尾巴是拟物残留                                                         |
| 明暗切换要做                    | 什么都不用做（asset catalog 变体 + 设置三档）                                        | 跟随系统                                                               |
| 配置面（providers 等 6 页）     | **不砍**，给同等能力：可 push 的栈、list↔detail、schema 驱动表单                     | 取舍原则是"手机能不能把 memoh 的形态表达清楚"                          |
| 逐页表单                        | 写**一个** schema → 原生表单渲染器                                                   | 上游加字段自动跟上                                                     |
| provider 密钥                   | 照接口写，但**本地不落任何 provider 密钥**（Keychain 只放登录 token）                | 密钥不落客户端                                                         |
| 5 步建 bot 向导                 | 不做向导；单页表单 + 轮询                                                            | 建 bot 是重决策                                                        |
| 定时任务只读                    | **完整编辑**                                                                         | 与桌面同结构                                                           |
| Cloud 与自托管登录边界          | 首页对齐 Cloud，官方入口先做有明确反馈的 UI 占位；自托管继续用服务器 + 用户名 + 密码 | OSS 服务端没有账号型 OIDC/Google 路由；Cloud 是另一个鉴权边界，见 §4.7 |
| 工具卡完成态贴 "Done"           | 只在 running/failed 贴状态词                                                         | 完成态不贴                                                             |
| 工具失败 = 正文标红             | 标题保持中性，正文照实标红                                                           | 两个不同对象                                                           |
| running 用静态沙漏              | 用系统 spinner                                                                       | 静止会被读成卡住                                                       |
| 每条回复 7 个动作图标           | 一枚可见 `⋯`：复制 / 分享 / 从这一轮分叉                                             | 其余是死按钮                                                           |
| 列表第二行放消息预览            | 第二行**状态优先**：等你批准 / 在跑 / 兜底"来源·类型"                                | 接口不返回最后一条消息，且手机扫列表问的是"哪个有事"                   |
| iPad 分栏                       | 先单列 + 写死 + 有 case                                                              | 同时做两件会互相掩盖失败                                               |

### 3.4 明确不做

- 容器桌面串流 / 手机接管输密码；👍👎、朗读、重生成（无服务端落点）；标记未读（spec 没有这个字段）。
- 把主力功能藏进长按（读屏用户不会长按）。
- 抄 Grok 的配色 / 营销美术 / composer 内联模型菜单；自研 Markdown 渲染引擎。
- 逐字淡入、列表逐行入场、自绘 shimmer、自定义页面转场、连接状态条补间。
- 给「跳过」引导加确认；给错误加"联系我们"入口（自托管产品，用户就是管理员）。
- 给没有进度信息的请求编进度条。
- 不引入 `ContentUnavailableView`；不用 UIKit alert 展示错误。
- 不新增服务端端点。要新端点先走上游 spec，再进客户端。

### 3.5 还没裁决 / 还没落地

- **审批位置**：设计基线说"主体在 composer 上方"，产品主张"就地卡片 + sheet 降级"——
  **未裁决**。已落地的是原生 formSheet（detents `[0.5,1]`、有抓手、`dismissible: false`）。
- 触感三处直接冲突（发送消息、下拉加载、长按菜单给不给 / 给哪一档）**未裁决**。
- 空态要不要给建议 prompt（上游只有 `POST /quick-actions/execute`，没有列表端点）**未裁决**。
- 顶栏入口数（设计基线三入口 vs 产品主张"一个主动作 + 一个 `…`"）**未裁决**。
- 首页 FAB（56pt 新建会话）与"两 tab + 三视图外壳"**未裁决**。
- 会话行缺 leading 状态槽（运行中 / 待审批 / 空）。
- 三视图各自的搜索入口；设置 tab 四组配置（等 schema 表单渲染器）；文件视图的 diff 页。
- iPad 的决定与 case。
- 按压态收敛成两档（20+ 文件，单独一轮）。
- 辅助字号下品牌标记的缩小/收起。

### 3.6 RN → Apple 原生迁移路线

迁移按模块进行，**一个模块一个分支、一个 PR**。模块完成的判据是可见 UI 与直接交互均由
SwiftUI/UIKit 持有；RN 可以暂时保留路由、服务端状态、i18n 和薄桥，但必须在最终阶段移除。
涉及登录、数据或实时行为的模块须使用 `vultr-sg` 上的真实自部署实例联调；自动化与 agent
验收不计作 Human QA。

| 顺序 | 模块 | 状态 / 边界 |
| ---- | ---- | ----------- |
| 1 | 外观 | 完成；原生 Form/Picker/Toggle，RN 暂持主题状态、路由与 i18n |
| 2 | 通知与 App 设置 | 原生权限、设置列表与系统入口 |
| 3 | 登录与鉴权 | 原生表单、Keychain、自部署登录 |
| 4 | 会话壳与列表 | 原生导航、列表、筛选与加载状态 |
| 5 | 文件 | 原生目录栈、预览与 diff |
| 6 | 定时任务 | 原生列表、编辑表单与删除确认 |
| 7 | Bot 设置与表单 | 原生 schema 表单覆盖配置模块 |
| 8 | Chat | 原生消息、composer、审批与 `ask_user` |
| 9 | App 壳收口 | 移除剩余 Expo Router/RN UI、桥接状态与不再需要的 RN 依赖 |

每个 PR 必须写清：本模块范围、原生与 RN 各自仍持有什么、行为兼容性、自动化与模拟器证据、
Human QA 状态，以及下一模块；合并前不得把后续模块顺手带入。

---

## 4. 协议契约

> 这一节的每一条都来自上游源码、swagger 或部署实例实测。**改协议层之前先读它**，
> 更详细的原文在 memoh-ios 的 `docs/research/memoh-api.md`（见 §8）。

### 4.1 实时通道

- 主通道是**一条 bot 一条 WebSocket**：`GET /bots/{bot_id}/web/ws`，用
  `Authorization: Bearer <jwt>`。原生客户端**不要用 `?token=`**（那是浏览器妥协），
  也不要碰 `/web/stream`（SSE，旧 channel 抽象）与 `POST /web/messages`（旧入口）。
- 权限门要 `workspace_exec` 或 `manage`：**只有 `chat` 权限的用户连不上**。
- 2026-09-20 对 `vultr-sg` 当前部署做过一次可恢复权限探测：把既有内测 member 的 `ios-dev`
  grant 临时从 `manage` 降到 `chat`，在 `finally` 恢复原权限并以 Schedule 200 复核。chat-only 下
  profile、bot 列表/详情、checks、sessions、GET settings 都是 200；Files、Schedule、user-access 与
  `/web/ws` 都是 403。由此 iOS 的边界不是“低权限聊天”，而是**REST 历史只读**：只显示 Sessions，
  不建 WS，也不画任何会触发 Files/Schedule/实时写入的入口。
- **发消息的连接收不到正文。** 正确顺序是：连 WS → `runtime_subscribe` → 收 `runtime_snapshot`
  → 才发 `message`。文本/思考/工具增量只以 `runtime_delta` 发给**订阅了该会话**的连接。
- `runtime_subscribe` 幂等，服务端会替换旧订阅并重发 snapshot。cursor 会被接受并回报，
  但**不用来续传**：服务端没有持久事件日志，也没有增量补齐，任何"合成历史"都是伪造。
- **增量语义分两条通道**：`text_delta` / `reasoning_delta` → `message_appends`
  （**按 id 追加内容**，不是整块替换）；`tool_call_*`、审批、`agent_end` / `agent_abort` / `error`
  → `message_upserts`（整块）。把 appends 当 upsert 处理会让长回复卡死；只按 upsert 顺序登记
  会让屏幕变成"全部工具 → 全部文字"。
- **`epoch` + `seq` 必须校验**：epoch 变了 seq 从 0 重来；`seq <= 本地` 丢重复帧；
  `seq != 本地 + 1` 视为空洞 → 重订阅；收到 `runtime_dropped` → 重订阅。
- **服务端不发心跳**（不发 ping、不设 read deadline），nginx 普通 location 300s 超时。
  客户端自己保活：**25–45s 重发一次幂等的 `runtime_subscribe`**，并在重连后重订阅全部活跃会话。
- 弱网五种形状（服务端扮演故障实测）：flap（重连间隔回到 1s，不是退避增长）、silent（40s 后
  仍说 open 但没有 snapshot）、hang（15s 后仍 connecting）、gap（空洞触发**订阅风暴**）、
  掉线期间发消息（补发比订阅先出队，正文丢失）。已落地的对策：退避只在连接活够一段时间后清零；
  心跳即探针；建连超时 10s；空洞后重订阅要节流；**重连后先订阅、后补发**；401/403 不重试。
- **run 状态机**：`admitting → running → waiting_decision → running → finishing → completed`；
  另有 `aborting → aborted` 与 `errored` / `lost`。**`waiting_decision` 是"正在等你批准"的
  权威信号**，比在 UI 层看 tool block 的审批状态可靠。`/status` 与 `/sessions/events` 都**不含**
  决策状态，跨 bot 的待审批聚合只能靠订阅 runtime。
- **审批**：批准请求挂在 tool block 上，必须渲染 agent 给的 `approval.options[]`
  （`allow_once` / `allow_always` / `reject_once` / `reject_always`），只做两个写死按钮会让
  需要选作用域的 agent 卡住。**实测 `options` 可能整个字段缺失** → 回退到"批准/拒绝"，
  且**不能回传伪造的 option_id**。`user_input_response`（`ask_user`）走同一套机制，
  **漏掉它 run 会永久卡在 `waiting_decision`**。
- **工具块没有失败状态**：传输层只有 `running *bool`，没有 `is_error` / `status`。
  非零退出码不等于用户任务失败 —— 标题保持中性，诊断只在 output 内部。
- 客户端**不能假设 run 一定到 completed**：上游偶发 `persistence fence is stale` 会让 run
  直接落 `failed`。

### 4.2 消息渲染

- 正文 Markdown 支持：H1–H3（H4–H6 收在 H3 以下）、段落、有序/无序列表、行内代码、
  围栏代码块（等宽 + 横向滚动，**不做高亮**）、粗斜删、链接（白名单 http/https/mailto）、
  引用块、分隔线、自动链接。
- 不做：表格布局（`|…|` 按等宽块呈现）、HTML 内联、参考式链接、任务列表、脚注、语法高亮。
  图片 `![]()` **不下载**，画成链接。
- **用户气泡不做 Markdown**（用户敲的是原文）。**思考也不渲染 Markdown**。
- 流式：只对正文最后一行、且 `streaming == true` 时容忍半截语法；流结束或读历史时严格模式。
- thinking：**没有 reasoning 内容就完全不出现那套 UI**（含 5 种空白写法）；折叠态标题显示
  "思考了 N 秒"（缺失 / 0 / 负 / NaN / 999ms 都不显示）。
- **"同一轮画两遍"**（打开已完成的会话时）：判据是"**历史里有没有这一轮**"（按 `turn_id` 认），
  不是"状态是不是终态" —— 服务端 run 结束后仍会长期带 `status: "completed"` 的
  `current_run_view`（实测 11 小时后还在）。

### 4.3 REST 里容易踩的点

- `GET /container/fs/list` 的 JSON 是 **camelCase**（`modTime` / `isDir`），**全仓唯一的
  camelCase**，其余是 snake_case。
- `fs/read` **没有任何大小限制**，且对二进制有损（非法 UTF-8 变 U+FFFD）。超过 256KB–1MB
  就别调，二进制走 `download`。
- **没有 refresh token**：`/auth/refresh` 需要当前有效的 Bearer，只换 `iat`/`exp`；默认有效期
  168h，过期只能重新登录。
- **401 一律当"清 Keychain 回登录页"信号**：中间件每请求做一次服务端会话校验，账号停用/删除
  会立刻 401（即使 token 未过期），不能只按 `exp` 判断。token 存 **Keychain**，
  不要 UserDefaults、不要 cookie。
- `messages` 分页：`limit` 默认 30 / 上限 100；服务端会把页首**向前延伸到 turn 边界**，
  所以**返回条数可能多于 limit**；**没有 `has_more`**；`items` 是按 turn 聚合的。
  用户与助手是**两条独立轮次**，`turn_position` 都是 1，**不能靠 position 分先后**。
- 队列端点（`/queue`、`steer-queue`、`follow-up-queue`）在**当前部署一律 404** → 客户端按能力
  探测降级：运行中发送键回到"停止"语义。
- `PUT /bots/{id}/settings` 的形状必须与 GET **完全一致**：多传字段整个请求被拒，但**响应仍是
  200**（"200 但没生效"）。bot `timezone` 清空 = 连 key 都不返回。
- `PATCH /sessions/{id}` 改 (model, effort) 是 compare-and-set，必须带
  `expected_model_preference_revision`。
- 服务端**没有任何应用层限流**：`invocation_id` 幂等是唯一防线，不要设计"无限重试"。
- `run_rejected`（这次提交不会变成 run）与 `error`（运行期错误）要分开处理。
- slash 命令走 WS，不走 REST。

### 4.4 定时任务 / 推送 / present

- **定时任务三个动词三套 payload**：`GET` / `POST` 是**平铺**（九个执行字段在顶层），
  `PUT` 是**嵌套且整块替换**（`{"execution": {...}}`）。写回必须把九个字段原样带回，
  漏了会**静默清空**模型 / 推理强度。`max_calls` 是 omitempty 指针：没设上限时键根本不在响应里。
  列表**没有** `next_run` / `last_run`，要去 `/schedule/logs` 聚合。
  服务端**没有任何重复触发防护**（裸 cron + 每 tick 独立 goroutine）。
- **推送是三类事件的封闭集合**：`approval_waiting` / `run_finished` / `run_failed`，不加第四类。
  `aps.thread-id` 必须是 `session:<session_id>`；徽标由客户端按待审批聚合同步，不放进 APNs payload；`sessionId` 必填
  （没有它整条点击被丢）；`recipientUserId` 必填且要与当前登录用户比对。
  **正文永远不放对话内容 / 命令原文 / 路径 / URL / 错误原文。**
  点通知本体只深链、**不做任何决定**；点"允许/拒绝"只在挂着的 `approvalId` 完全相等时提交一次，
  20 秒等不到就放弃。
  `/devices` 由独立 `ios-push-gateway` sidecar 承接：它把 Bearer token 交回 Memoh
  `/users/me` 核验，`user_id` 不一致直接拒绝；同一 App/device token 全局只绑定一个用户，
  换号会清掉旧用户尚未发送的 delivery。gateway 从持久化审批与 run ledger 中只提取上述三类
  事件，用游标 + 唯一键防重，再通过 APNs HTTP/2 投递。Apple `.p8` 只挂载进只读 sidecar，
  **不进入 Memoh server、Bot workspace 或 microVM**。
- **present 出席契约**：`definePage` / `usePageRuntime` / `present`。四条规则 ——
  参数只在内存（URL 里只有 `presentationId`）、`await present(...)` 永远有结论
  （`completed` / `cancelled`）、同一次出席只结算一次、写入必须幂等。
  形态由宿主路由声明，契约目前**只承诺 `formSheet`**。
  **关这一屏要走 `router.back()`，不是 `dismiss()`**（后者是静默 no-op）。

### 4.5 哪一层是权威

同时存在**四个版本的"Memoh"**，日期和内容都不一样。分不清这一层是这里最大的坑。

| 层                             | 在哪                                                                     | 唯一能回答                                     |
| ------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------- |
| 上游 `felinics/Memoh`          | 本仓库（基线 `22752cd`，swagger **267** 路径）                           | 「上游把它设计成什么样、为什么」               |
| 我们的 fork `AidenNovak/Memoh` | `vultr-sg:/opt/memoh-dev/src`（`05b8491`，**266** 路径，**无自有补丁**） | 服务端改动的唯一落点                           |
| 部署实例（dev 栈）             | `vultr-sg` 的 `memoh-dev` compose，经隧道 `127.0.0.1:18080`              | **「这个功能现在到底能不能用」——只有它能回答** |
| 本仓库的 iOS 客户端            | `apps/mobile`                                                            | 交付物本身                                     |

- 三层的 swagger 路径数真的不一样（历史上 254 / 266 / 236）。**任何写进文档的条数、版本号、
  日期都要带来源**（哪台机器、哪条命令、哪一天）。
- 判"能不能用"**不看上游 main，也不看 fork 检出**（都比部署新）。
- 更可靠的判据是**能力探测**：真发一次请求，**404 = 这个版本没有它，405 = 存在但方法不对**。

### 4.6 客户端有意偏离桌面端/上游

| #   | 偏离点                       | 桌面端 / 上游                | iOS                                          | 理由                                                      |
| --- | ---------------------------- | ---------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| 1   | 不做 Android                 | 只有 Web 与桌面端            | 只有 iOS，无 stub、无 Android 构建脚本       | 产品定位；加 Android 会让原生面变成两套几乎无法共享的实现 |
| 2   | 不向上游提交                 | 上游接受 PR                  | 服务端改动一律走 fork                        | 独立维护的第三方客户端                                    |
| 3   | 切换器选中后的落点           | 进该 bot 的设置页            | **切到那个 bot**（设置走另外一行）           | 切换器是"换一个来聊"的语境                                |
| 4   | GUI 工具不自动开桌面分屏     | 会开着（上游自己也在收）     | 只有按需浮窗                                 | 每次 GUI 调用都会把用户从对话里拽走                       |
| 5   | 思考强度                     | 下拉选择                     | 点一下换下一个                               | 可选项通常两三个                                          |
| 6   | bot 设置只做手机上意义的几组 | 十几个 tab                   | 基本信息 / 对话 / 桌面 / 运行检查 / 危险操作 | 手机装不下；那是"产房"里的活                              |
| 7   | 不做多面板工作台             | 可拖拽分割的 8 种面板        | 单栈导航 + 按需浮窗                          | 手机装不下                                                |
| 8   | 不做桌面配置向导             | 5 步向导                     | 三屏说明页                                   | 小屏填 API key 体验极差                                   |
| 9   | Web 的 CSS 手法不搬          | 卡片阴影、hover、居中 dialog | HIG：语义色、动态字号、原生 sheet/列表       | 系统有现成的就用现成的                                    |
| 10  | 队列能力按探测降级           | 新版有会话队列/插话          | 404 就记 `support:'no'`，发送键回到"停止"    | 不探测等于给用户一个必然失败的入口                        |

### 4.7 Cloud 与自托管的连接边界

**已验证的事实（2026-09-19）：**

- OSS/self-host 是一个 Memoh Server：`/auth/login` 换 JWT，手机直接调 REST +
  WebSocket。iOS 先用 `<base>/ping` 确认 `status: "ok"`，再发送口令。公网裸域名
  优先探测 `/api`，本地/内网与明示 8080/18080 先探测根路径；发现到的确切
  base URL 与 JWT 一起进 Keychain。非内网 `http://` 被拒绝，避免口令明文上网。
- Memoh Cloud 不是"把 Cloud 域名填进自托管登录框"：`app.memoh.net/api/ping`
  是 Cloud 健康端点，当前 Web 客户端的账号鉴权走 `/api/v1`（email code / OAuth /
  password / MFA）与 secure cookie，实例的 Memoh API 走 `/api/memoh`，并带 team 上下文。
  当前 iOS 的 JWT 合同无法安全复用这份浏览器 cookie。
- 公开材料能证明 Cloud 给 bot 持久卷、独立文件/桌面/网络与持续运行的
  compute；OSS 的官方 server image 默认用 containerd + CNI。**没有公开证据证明
  Cloud 用 Firecracker/其他 microVM**，所以不把这个猜测写进客户端契约。

**Cloud 原生登录的预留（服务端合同先行，手机端不猜端点）：**

当前 iOS 登录首页先展示与 Web/Desktop 一致的 GitHub、Google、邮箱入口，但三者仅是
**有明确反馈的前端占位**：只做本地邮箱形状校验，按下后说明 Cloud 登录尚未开放，不发网络请求、
不拉起 WebView，也不收集凭据。自部署作为独立入口放在其下，进入现有的 server + username +
password 流程。以下合同落地后再把占位接成真实登录：

1. 用 `ASWebAuthenticationSession` 走 Authorization Code + PKCE，复用 Cloud 的 email/OAuth/MFA
   页面；不把 Google token 或 Web cookie 偷进 App。
2. Cloud 用一次性 code 回调 App，App 换可撤销的移动端 access/refresh credential；回应
   明确给 `apiBaseUrl` / `teamId` / `authMode`，不让 App 猜某个租户或沙箱在哪。
3. self-host 也可在将来提供同一套 device authorization/PKCE 端点；在那之前，就保持
   当前的显式 server + username + password，不做 WebView 填密码或长期 pairing secret。

**手机 ↔ 用户 VPS 的推荐路径：**手机连的是 Memoh Server，不是 bot workspace。
VPS 有公网 IP 时用普通 HTTPS 反代暴露 `/api` 与 WebSocket；无入站条件时再用
outbound-only tunnel。Tailscale Serve 适合只给自己的 tailnet；Cloudflare Tunnel 适合要稳定
公网域名又不想开入站端口的部署。Tailscale Funnel 为公网临时共享，不作为默认
生产入口。无论哪条路，鉴权都留在 Memoh；tunnel 不发明第二套账号。

公开依据：[Memoh Cloud / Quick Start](https://docs.memoh.ai/guides/quick-start)、
[Workspace Backends](https://docs.memoh.ai/self-hosted/workspace-backends.html)、
[Computers / Remote Runtimes](https://docs.memoh.ai/guides/computers.html)、
[Apple `ASWebAuthenticationSession`](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession)、
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) 与
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)。

---

## 5. 客户端分层与落点

依赖方向**单向**：`app → screens → features → models/api → lib`。反过来就是错的。

| 目录                     | 放什么                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/`               | 路由（Expo Router）。只导出 `page.Route`，不放逻辑                                                                                     |
| `src/screens/`           | 只放 `*Screen` 文件                                                                                                                    |
| `src/features/`          | 领域逻辑（activity / auth / bots / chat / errors / files / machine / notifications / onboarding / schedule / session）                 |
| `src/models/`            | 数据形状                                                                                                                               |
| `src/api/`               | REST + 实时协议（client / realtime / protocol / cursor / credentials / types）                                                         |
| `src/ui/`                | 共享 UI 组件（29 个）                                                                                                                  |
| `src/lib/`               | 基础设施（presentation / i18n / theme / accessibility）                                                                                |
| `modules/memoh-kit/ios/` | Swift：Transcript（政策与数据）、Markdown（解析）、MarkdownText（视觉）、MessageCells、NativeMessageList、Notifications、Support       |

规矩：

- **features 不得 import screens**。要换 bot / 开会话，走 `features/session/store.tsx` 暴露的
  `selectBot` / `openSession`；`router.push` 留在 `screens` / `ui` 层。
- **只从 `@memoh-ios/kit` 导入原生 API**，typed facade / 原生 View wrapper / Swift 实现三者一一对应。
  模块事件订阅必须在 unmount 时移除；UIKit 工作跑在主队列。
- 复杂结构体传给原生 View 用 **JSON 字符串 prop**，不要跨桥传嵌套对象。
- 产品屏幕只暴露用户可操作的连接状态，不携带故障注入或场景回放入口。
- **不要嵌套三元表达式**：一个 `cond ? a : b` 可以，任一分支里再有 `?` 就不行。封闭集合用字典
  映射，有序或重叠条件用 `if` / `switch`（`pnpm ios:check` 里的 `ternary:check` 会拦）。
- 只有在真的需要时才加状态库。

---

## 6. 我们对上游做的改动（全部）

**改上游的现有文件（6 个）：**

| 文件                                           | 改了什么                                                        | 为什么                                                                                                                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`（`CLAUDE.md` 是指向它的软链）      | 加「iOS Client (`apps/mobile`)」一节 + 末尾的「iOS Design」指引 | 上游自己的约定是"改一个目录之前先读最近的 `AGENTS.md`"。iOS 的硬约束必须在上游那份宪法里有一席之地，否则下一个 agent 会照 web/desktop 的规矩改 RN 代码。细节一律不写在这里，只留指到本文的入口                                          |
| `pnpm-workspace.yaml`                          | `packages` 加一行 `apps/mobile/modules/*`                       | `@memoh-ios/kit` 既是 Expo 原生模块也是 JS 包。列进 workspace 它才是**真 workspace 包**：pnpm 会把它链进 `node_modules`，任何只认 `node_modules` 的工具都能解析到，不必在 `tsconfig paths` 和 `metro extraNodeModules` 里各手工对齐一份 |
| `package.json`                                 | 加 11 个 `ios:*` 脚本；补 Worklets 的 Babel package extension   | 脚本与上游不重名；Worklets 0.10.1 的插件会直接加载 `@babel/generator` 却没有声明它，显式钉在 Expo 使用的 Babel 7.28.5，防止干净安装误捡 Babel 8。**上游脚本一个没动**                                                                   |
| `eslint.config.mjs`                            | `ignores` 加 `apps/mobile/**`                                   | iOS 侧有自己的 ESLint 配置（Expo 规则集 + React Native / Node 两套全局量），跟这里的 Vue 规则集不是一回事；用它扫 RN 源码只会刷假问题                                                                                                   |
| `.gitignore`                                   | 追加 iOS 段 + `/.verify/`                                       | prebuild、归档与发布产物不入库；签名材料绝不入库                                                                                                                                                                                        |
| `pnpm-lock.yaml`                               | 重新解析                                                        | 加入 iOS 依赖后 pnpm 重解了一次依赖图；另记录 Worklets 的 `@babel/generator@7.28.5` package extension。除了新增的移动端条目，上游那 49 处被**去重**（例如重复的 `app-builder-lib@26.8.1` 归并到已有的 `26.16.1`）                       |

**新增的目录（不改上游任何文件）：**

| 路径           | 是什么                                                                             |
| -------------- | ---------------------------------------------------------------------------------- |
| `apps/mobile/` | iOS 客户端（254 个文件，`modules/memoh-kit` 11 个 Swift 源文件）                  |
| `cmd/ios-push-gateway/` | iOS 设备注册、持久事件游标与 APNs 投递 sidecar（6 个 Go 文件）         |
| `tools/`       | iOS 侧编译检查、资产与 TestFlight 发布脚本（7 个）                                |
| `infra/`       | 联调隧道、dev 栈与 push gateway 镜像/入口脚本（8 个）                             |

**不提交的内容：** 单元测试、E2E/验收脚本、fixtures、截图证据、测试专用路由与原生探针。
这些内容已在功能收口前完成验证；当前分支只保留产品、构建发布链与本文。

---

## 7. 仓库集成说明

（口径：`apps/mobile` 除下面这些外**逐字节相同**；`infra/` 逐字节相同。）

1. **Prettier 配置搬进 `apps/mobile/`**（原来是仓库根），并在 `apps/mobile/package.json` 里补了
   `format` / `format:check` / `check` 三个脚本。理由：这份配置只属于 iOS 客户端，
   放根上会把上游的 web / desktop / 服务端一起卷进"我们的排版范围"。
   （根上的 `ios:check` 在它前面又串了两条 Swift 类型检查——memoh-ios 的 `check` 本来就有这两条，
   只是它的入口在根上。）
2. **显式声明移动端依赖**：`expo-file-system`（运行时 import）与 `sf-symbols-typescript`
   （type-only）。本仓库用 pnpm 默认的 isolated 布局，不能依赖 hoisted 布局偶然兜底。
   根 `package.json` 还用 pnpm `packageExtensions` 补了 Worklets 0.10.1 漏声明的
   `@babel/generator@7.28.5`：干净安装曾解析到 Babel 8，导致 Reanimated 的
   `interpolateColor.ts` 在 Worklets 插件里 bundle 失败；显式补依赖后，React Compiler 保持开启且
   `expo export` 可正常产出 iOS bundle。
3. **`apps/mobile/package.json` 里加了一份自己的 `lint-staged` 配置**，命令是
   `pnpm exec eslint --concurrency=auto`（**不带 `--fix`**）。两件事都必要：
   - **为什么要有这份配置**：上游根上的 ESLint 是 **10.x**，而 Expo 那套
     （`eslint-config-expo` → `eslint-plugin-react` 7.x）只支持 **9.x**。ESLint 10 会认领
     `apps/mobile/eslint.config.js` 并拿根上的 10.x 去跑它，**当场崩**
     （`Error while loading rule 'react/display-name'`）。pre-commit 的 `lint-staged` 传的是
     显式路径，正好踩中。lint-staged 在 monorepo 里按"离文件最近的配置"分派，所以在
     `apps/mobile/` 放一份自己的配置就把它交给包内的 ESLint 9 —— **上游的 `lint-staged`
     一个字没改**。
   - **为什么不带 `--fix`**：实测它会干坏事 —— 把有意写的 `{/* eslint-disable-next-line */}`
     替换成 `{ }`，合并 import 后留下 Prettier 不接受的空格。iOS 侧的格式由 `prettier` 管，
     ESLint 只负责**发现**问题。
4. **`tools/docs-links.mjs` 只扫描 iOS 侧**（`AGENTS.md` + 本文 + `apps/mobile/`），
   不把上游几百份 Markdown 卷进移动端检查。

---

## 8. 代码注释里的 `docs/…` 指哪里

本仓库 iOS 侧**只有本文一份文档**。`apps/mobile/**` 与 `tools/**` 的注释里仍会出现
`docs/research/memoh-api.md`、`docs/CHAT-ACCEPTANCE.md` 这类路径 —— 它们是 iOS 客户端在
`AidenNovak/memoh-ios` 时期的文档，**不在本仓库**。

- 要读细节：去那个仓库的 `docs/`（同一台机器上是 `~/projects/memoh-ios/docs/`）。
- 本文已经把**继续生效的契约与设计裁决**摘出来了；那批文档的价值是**推导过程与实测记录**，
  不是本文的替代品。
- 新写的代码**不要再往那里加引用**。要么把结论写进本文，要么在注释里把结论说完整。

---

## 9. 当前状态与剩余验收

- **TestFlight 0.1.0 (build 7) 已可用**：产品代码 head `bf60faa0a`，ASC 状态 `VALID`，
  已挂 `Internal Testers`。发行签名、Team、bundle、build number、production APNs 与
  Time Sensitive entitlement 都已核对。build 7 是首个包含 self-host push gateway 的内测包，
  后续真实 APNs 验收必须使用这一版或更新版本。
- Release 默认连接 `https://memoh.yetodawn.com`。TestFlight 只决定谁能安装；
  Memoh member 决定谁能登录与访问哪个 Bot。内测账号只授予 `ios-dev` 的 Bot 级权限，
  不授予服务器 admin；登录凭据只保存在
  `/opt/memoh-dev/secrets/testflight-tester.env`（`0600 root:root`）。
- 功能收口前已完成模拟器、协议、权限矩阵、原生构建与 TestFlight 发布验证。为保持提交克制，
  仓库不保留单元测试、E2E、fixtures、截图证据、测试专用页面或探针。
- **仍需真机 Human QA**：真实 APNs 送达、通知卡片与动作按钮、生产 device token、
  触感、专注模式，以及蜂窝/Wi-Fi 切换。完成前 PR 保持 Draft，`Human QA passed` 不勾选。
- `vultr-sg` dev 栈已运行由 commit `e21aa87d2` 构建的 push gateway：sidecar 健康、
  持久事件 cursor、独立重启恢复、公网 `/devices` 鉴权、双域名 TLS 均已通过，部署过程未重启
  Memoh server / PostgreSQL。当前 production device 注册数仍为 0，说明 build 7 尚未在真机完成
  登录与 token 注册；这项状态不能冒充 APNs 到达验证。
- push gateway 已通过真实 Memoh/PostgreSQL 的 401/400/204 注册与解绑验证；APNs provider
  JWT、Team/Key/topic 与 HTTP/2 已用假 token 验证到 Apple 的 `BadDeviceToken` 回执并自动清理。
  仍缺的只是 TestFlight 真机产生 production token 后的实际送达与动作验收。
