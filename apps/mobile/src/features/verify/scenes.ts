/**
 * 验收场景的固定数据（仅开发构建）。
 *
 * ## 为什么用"帧回放"而不是手搓状态
 *
 * 每个场景是一串**协议帧**（snapshot / delta），由真实 reducer 回放成状态。
 *
 * 手搓一个 `ChatState` 更快，但那样场景截的图证明不了任何事——它只能证明"我能把
 * 这个对象画出来"，而不能证明"服务端发这些帧时界面是对的"。用帧回放以后，每个
 * 场景顺带就是 reducer 的一条集成测试：形状错了、字段名变了、顺序不对，场景自己
 * 就会显示出来。
 *
 * ## 形状的来源
 *
 * 帧的形状全部取自 `docs/research/verified-behaviour.md` 里实测到的真实数据，
 * 不是照着 swagger 猜的。特别是这几条：
 *   - `message_appends` 按 id 追加（流式）
 *   - 用户轮与助手轮在 REST 里是两条独立记录
 *   - 审批的 `options` 可能**整个缺失**（这时 UI 必须给兜底动作）
 *   - 工具调用走 `type: 'tool'` 的整块 upsert，带 `running` 与 `execution_location`
 */

import type { RuntimeDelta, RuntimeSnapshotPayload } from '../../api/protocol.ts';
import type { SessionStatus } from '../../models/chat.ts';

export interface Scene {
  id: string;
  /** 人类可读的场景说明，出现在 Debug 页与截图文件名里。 */
  title: string;
  /** 这个场景要验证什么。写清楚，否则下一轮没人知道它为什么存在。 */
  intent: string;
  /** 回放用的帧序列。按顺序喂给 reducer。 */
  frames: SceneFrame[];
  /** 回放完之后的界面该长什么样（用于人工核对，不用于自动断言）。 */
  expect: string;
  /**
   额外要展示的浮层（仅开发页用）。目前只支持会话信息面板。
   
   为什么需要它：`simctl` 没有点击能力，而会话信息面板是**点标题**才出现的。
   没有这个入口，那段 UI 就只能在真机上人肉点开，验收脚本截不到——而"截不到"
   在实践里等于"没人看"。
   
   `status` 用**真实部署实测到的形状**（字段值本身就是从部署机上取下来的），
   不是编的样例。
   */
  sheet?: { kind: 'sessionInfo'; status: SessionStatus };
  /**
   这一场的 REST 历史该给什么。

   `'scene'`（默认）= 固定服务端把这一场的帧合成一份"已完成的轮次"当历史交出去，
   用在"这一轮真的已经落盘"的场景上。

   `'none'` = 不合成历史。**正在跑着的那一轮不属于历史**：上游在轮次屏障上才把用户
   消息与助手输出一起落盘（`PersistRound`），run 期间 REST 里根本没有这一轮。给一场
   "跑到一半"的场景合成历史，等于让界面同时拿到"已完成的一轮"和"正在跑的一轮"两份，
   把这一场真正要验的东西盖住。
   */
  restHistory?: 'scene' | 'none';
  /**
   帧间隔（毫秒）：服务端每发一帧等这么久，用来复现"高频更新"。

   默认 120（`server.mjs` 的历史值，够录屏看清流式）。真实 agent 的文本增量远快于
   这个值，所以专门验时序的场景要显式调小。
   */
  intervalMs?: number;
}

export type SceneFrame =
  | { kind: 'snapshot'; payload: RuntimeSnapshotPayload }
  | { kind: 'delta'; epoch: string; seq: number; delta: RuntimeDelta };

const EPOCH = 'scene-epoch';
const SESSION = 'scene-session';

/** 造一串流式文本追加帧。真实流式就是这种逐块追加。 */
function streamText(id: number, chunks: string[], startSeq: number): SceneFrame[] {
  return chunks.map((content, index) => ({
    kind: 'delta' as const,
    epoch: EPOCH,
    seq: startSeq + index,
    delta: { message_appends: [{ id, type: 'text' as const, content }] },
  }));
}

/** 造一串思考块的追加帧。 */
function streamReasoning(id: number, chunks: string[], startSeq: number): SceneFrame[] {
  return chunks.map((content, index) => ({
    kind: 'delta' as const,
    epoch: EPOCH,
    seq: startSeq + index,
    delta: { message_appends: [{ id, type: 'reasoning' as const, content }] },
  }));
}

/**
 一个工具块的**整块** upsert。

 协议里工具没有增量形态：`tool_call_start` / `input_start` / `metadata` / `end` 每次都
 把整条消息重发一遍（`internal/agent/view/uimessage_stream.go`），客户端拿到的就是
 "同一个 id 的块被替换"。所以场景要按整块写，不能按增量写。
 */
function toolUpsert(
  seq: number,
  message: NonNullable<RuntimeDelta['message_upserts']>[number],
): SceneFrame {
  return { kind: 'delta', epoch: EPOCH, seq, delta: { message_upserts: [message] } };
}

/** 一条工具进度追加（`tool_call_progress`）。按 id 累积，不改变块的顺序。 */
function progressAppend(seq: number, id: number, progress: unknown): SceneFrame {
  return { kind: 'delta', epoch: EPOCH, seq, delta: { progress_appends: [{ id, progress }] } };
}

function emptySnapshot(): SceneFrame {
  return {
    kind: 'snapshot',
    payload: {
      bot_id: 'scene-bot',
      session_id: SESSION,
      epoch: EPOCH,
      seq: 0,
      current_run_view: null,
    },
  };
}

/**
 run 正在跑：一条**带 `current_run_view`** 的增量（status `running`）。

 ## 为什么必须是增量，不能是第二个 snapshot

 固定服务端每条订阅流**只发第一个 snapshot**（`server.mjs` 的 `sendScene`），其余帧必须
 是 delta 才会发得出去。所以这里以前那个 `runningSnapshot`（第二个 snapshot 帧）在**真实
 WS 上从来没到过客户端**：`chat.running` 恒为 false，发送键回落到禁用的"发送"↑，而同一屏
 上工具块还按场景数据转着圈——于是出现"**转圈 + 发送箭头**"这种真服务端上不会同时出现的
 画面（2026-09-17，aiden 照着它评产品；真服务端的帧序见 `docs/CHAT-ACCEPTANCE.md` §6.①）。
 场景台看不出这件事：它回放**全部**帧，第二个 snapshot 在那边是生效的——两个"同一份帧"
 的表面互相矛盾，而只有走真实 WS 的那一个才是产品。

 用增量在协议上也是对的：真服务端在 run 期间一路发 `current_run_view`（`admitting` →
 `running`）与 `run` 增量，客户端两条路落到同一个状态（`applyDelta` 拿到 `current_run_view`
 时整块替换并重算 `running`）。

 ⚠️ `messages: []` / `user_turns: []`：这一帧只允许出现在**内容之前**。真实服务端给的永远是
 当刻的完整投影；把它放在内容之后，整块替换会把已经画出来的块清掉。
 */
function runningRunDelta(seq: number): SceneFrame {
  return {
    kind: 'delta',
    epoch: EPOCH,
    seq,
    delta: {
      current_run_view: {
        run_id: 'scene-run',
        turn_id: 'scene-turn',
        status: 'running',
        started_at: '2026-09-13T18:00:00Z',
        updated_at: '2026-09-13T18:00:00Z',
        messages: [],
        user_turns: [],
      },
    },
  };
}

/**
 让 run 停在等待决策上。这是"正在等你批准"的权威信号。

 ## 为什么是 **delta** 而不是 snapshot

 这一帧以前是 snapshot（`waitingSnapshot`）。固定服务端只发**第一个** snapshot
 （`sendScene`：`frames.find(kind === 'snapshot')`），其余帧必须是 delta 才会被发出去。
 于是"等审批 / 等回答"这四个场景的主体内容**从来没到过客户端**——场景台里看着好好的
 （那里会回放全部帧），一旦走真实的 WS 就什么都不剩（2026-09-16 建"拒绝时填理由"那条
 flow 时踩到：屏幕上只有用户那句话，审批面板不出现）。

 用 delta 表达这件事在协议上也是对的：真实服务端在 run 进入 `waiting_decision` 时
 推的就是带 `current_run_view` 的增量。reducer 两条路落到同一个状态（`applyDelta` 有
 `current_run_view` 时同样是整块替换 + 重算 `approval`）。
 */
function waitingRunDelta(seq: number, messages: RuntimeDelta['message_upserts']): SceneFrame {
  return {
    kind: 'delta',
    epoch: EPOCH,
    seq,
    delta: {
      current_run_view: {
        run_id: 'scene-run',
        turn_id: 'scene-turn',
        status: 'waiting_decision',
        started_at: '2026-09-13T18:00:00Z',
        updated_at: '2026-09-13T18:00:10Z',
        messages: messages ?? [],
        user_turns: [],
      },
    },
  };
}

const TURN_USER = 'scene-turn';

/**
 合成流的探针场景（见 `docs/research/ios-performance-practices.md` §2.1）。

 ## 为什么要有它

 判据要的是"合成流 + 帧级几何不变量"：把"手感"变成能自动判的数字。这两个场景提供
 **合成输入**（固定速率、固定长度的追加），渲染与协议处理走**真实**路径
 （真实 reducer + `NativeMessageList`），和真服务端发这些帧时是同一套代码。

 ## 两个场景的分工

 - `probe-stream`：8 轮历史 + 240 次追加（每次 24 字），`intervalMs: 40`。**基准**场景，
   用来量"正常长回复"的几何不变量与掉帧率（约 10 秒）。
 - `probe-stream-heavy`：同样的形状，每次 120 字、间隔 20ms（正文累计约 36k 字）。
   这是**已知会掉帧的对照**——用来证明尺子真的量得出差异，量不出就是尺子坏了。

 `seq` 必须**严格连续**（reducer 把空洞当断线）：这些场景从 snapshot 的 `seq: 0` 起，
 之后每一帧 +1。
 */
function probeFrame(seq: number, delta: RuntimeDelta): SceneFrame {
  return { kind: 'delta' as const, epoch: EPOCH, seq, delta };
}

/** 一轮问答的**用户**那一半（`probe-stream` 与长会话场景共用，内容必须一致才可比）。 */
function probeRoundUser(index: number): NonNullable<RuntimeDelta['user_turn_upserts']>[number] {
  return {
    turn_id: `${TURN_USER}-h${index}`,
    role: 'user' as const,
    text: `第 ${index + 1} 个问题：这条流程里还有哪两处可以合并？`,
    turn_position: index * 2 + 1,
  };
}

/** 一轮问答的**助手**那一半（同上，两份场景共用）。 */
function probeRoundMessage(index: number): NonNullable<RuntimeDelta['message_upserts']>[number] {
  return {
    id: 900 + index,
    type: 'text' as const,
    content:
      `第 ${index + 1} 轮的回答。有两处可以合并：先是重复的校验，` +
      '后是两段写法不同的错误处理，合并之后主流程短一行，错误信息也更集中。',
  };
}

/** 造一段"已经落盘"的历史：N 轮问答，**一帧一轮**（问答各一帧）。 */
function probeHistory(seq: number, turns: number): SceneFrame[] {
  const frames: SceneFrame[] = [];
  let cursor = seq;
  for (let index = 0; index < turns; index += 1) {
    cursor += 1;
    frames.push(probeFrame(cursor, { user_turn_upserts: [probeRoundUser(index)] }));
    cursor += 1;
    frames.push(probeFrame(cursor, { message_upserts: [probeRoundMessage(index)] }));
  }
  return frames;
}

/**
 长会话的历史：`turns` 轮，**一帧 `perFrame` 轮**批量进。

 ## 为什么按批进，而不是照 `probeHistory` 一帧一轮

 一帧一轮时 300 轮要 300 帧 × 300ms ≈ 90 秒，而这一场量的是**追加**的单价：
 追加的代价是 O(整份转录)（`docs/research/ios-native-code-comparison.md` §2.2），
 历史按什么节奏到达**不改变这个单价**——到齐之后列表里就是那么多行。

 行序也不受影响：`turnsForDisplay` 先把 `liveUserTurns`（用户轮）整体排上，再排助手那一轮，
 所以"两类 upsert 同帧批量进"与"一帧一轮交替进"落到的**行序与行内容完全一样**
 （差别只在中间态被跳过了几次）。

 代价说清楚：这一场**不覆盖**"历史自己逐帧到达时界面长什么样"——那是 `probe-stream`
 （8 轮）与**真实 REST 历史**那条路的事。
 */
function probeHistoryBatched(seq: number, turns: number, perFrame: number): SceneFrame[] {
  const frames: SceneFrame[] = [];
  let cursor = seq;
  for (let start = 0; start < turns; start += perFrame) {
    const end = Math.min(start + perFrame, turns);
    const userTurns: NonNullable<RuntimeDelta['user_turn_upserts']> = [];
    const messages: NonNullable<RuntimeDelta['message_upserts']> = [];
    for (let index = start; index < end; index += 1) {
      userTurns.push(probeRoundUser(index));
      messages.push(probeRoundMessage(index));
    }
    cursor += 1;
    frames.push(probeFrame(cursor, { user_turn_upserts: userTurns, message_upserts: messages }));
  }
  return frames;
}

/**
 造一段流式长回复：`chunks` 次按 id 追加，每次 `size` 字。

 `row` 是追加的目标行。**它不能和历史块的 id 撞上**：长会话那一档的历史 id 是
 `900…900+turns-1`，300 轮时正好跨过 999——撞上就不再是"新起一行加字"，而是
 往那一轮的历史回复里塞，量到的单价就不干净了（第一次跑就是这么错的）。
 */
function probeStream(seq: number, chunks: number, size: number, row: number = 999): SceneFrame[] {
  const sentence =
    '把重复的校验合并之后主流程短了一行，错误信息也更集中，读的人不用在两处之间来回对照。';
  const frames: SceneFrame[] = [];
  for (let index = 0; index < chunks; index += 1) {
    const offset = (index * 7) % sentence.length;
    const rotated = sentence.slice(offset) + sentence.slice(0, offset);
    frames.push(
      probeFrame(seq + index + 1, {
        message_appends: [{ id: row, type: 'text' as const, content: rotated.slice(0, size) }],
      }),
    );
  }
  return frames;
}

// ---------------------------------------------------------------- 场景表

export const SCENES: Scene[] = [
  {
    id: 'chat-tools',
    title: '工具调用：执行中 / 完成 / 输出里有错误',
    intent:
      '连续工具合并为一行灰字，执行中靠行尾 spinner 表达，不靠颜色。' +
      '「输出里有错误」刻意不等于「失败」——协议层没有工具失败状态，' +
      '上游也明确说不能从一次工具调用推导任务失败（见 verified-behaviour 第 15 条）。',
    expect:
      '三个工具合成一行「执行了命令、编辑了文件」，前导工具图标、右侧一个 spinner；' +
      '无卡片、无状态词、无红色诊断；VoiceOver 保留 exec、fs_write、exec 全部工具名。',
    frames: [
      emptySnapshot(),
      runningRunDelta(1),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          user_turn_upserts: [
            {
              turn_id: TURN_USER,
              role: 'user',
              text: '把报告的图表重新生成，然后跑一遍测试',
              turn_position: 1,
            },
          ],
        },
      },
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 3,
        delta: {
          message_upserts: [
            {
              id: 10,
              type: 'tool',
              name: 'exec',
              running: true,
              input: { command: 'pytest -q tests/reports' },
              execution_location: { kind: 'container', name: 'workspace' },
            },
          ],
        },
      },
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 4,
        delta: {
          message_upserts: [
            {
              id: 11,
              type: 'tool',
              name: 'fs_write',
              running: false,
              input: { path: '/data/reports/chart-1.png' },
              output: 'wrote 240 KB',
            },
            {
              id: 12,
              type: 'tool',
              name: 'exec',
              running: false,
              input: { command: 'npm run build' },
              // 真实的工具输出形状：诊断藏在 output 内部（`isError` + `content[].text`），
              // 而 `running: false` 一律映射成 done——协议层没有"工具失败"这个状态。
              // 场景要照实反映这一点，否则截图会给人"服务端会给失败状态"的错觉。
              output: {
                isError: true,
                content: [{ type: 'text', text: 'Module not found: @scope/missing' }],
              },
            },
          ],
        },
      },
      // 刻意**停在这里**：一个工具还在跑，所以没有最终回复。
      //
      // 原来这个场景结尾写了一句"三个图表已重新生成；构建失败了"并把 run 置为
      // completed——那是自相矛盾的：真实的 agent 循环里最终回复要等所有工具结束，
      // 而且那句话声称生成了三个图表、实际只有一次写入调用。视觉评审把这两点
      // 都指出来了。场景要么是一次真实的"进行中"切面，要么是一次真实的"已完成"，
      // 不能为了多展示几个状态就把两个时刻拼在一起。
    ],
  },

  {
    id: 'chat-tool-stream',
    title: '工具行的流式时序：文字与工具交错、工具块高频整块替换',
    restHistory: 'none',
    intervalMs: 35,
    intent:
      '一个真实的 agent 循环是「一段文字 → 一个工具 → 又一段文字 → 又一个工具 → 收尾文字」，' +
      '而且工具块是**整块替换**（状态从 running 变成 done、输出一次性变长），文字块是**按 id 追加**。' +
      '两条通道混在一起时屏幕上的顺序必须与它实际发生的顺序一致，' +
      '并且在终态（服务端把整轮重发一遍）到来时**不再跳一次**。' +
      '帧间隔压到 35ms，是为了让"同一块被连着替换很多次、输出还在变长"这件事真的发生——' +
      '它就是原生列表合并突发帧、只重配变化行的场景。',
    expect:
      '从上到下：文字 → 测试工具行 → 文字 → 写文件行 → 文字；' +
      '工具行只在**相邻**时合并（被文字隔开就分行），终态到来后顺序与分组都不变。',
    frames: [
      emptySnapshot(),
      runningRunDelta(1),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          user_turn_upserts: [
            {
              turn_id: TURN_USER,
              role: 'user',
              text: '跑一遍测试，然后把结果写进报告',
              turn_position: 1,
            },
          ],
        },
      },
      // ① 第一段文字：只有 append，没有 upsert（协议就是这样的）。
      ...streamText(1, ['先跑测试。', '我', '从仓库根目录', '开始。'], 3),
      // ② 第一个工具：整块 upsert，先 running……
      toolUpsert(7, {
        id: 2,
        type: 'tool',
        name: 'exec',
        running: true,
        input: { command: 'pnpm test' },
        execution_location: { kind: 'container', name: 'workspace' },
      }),
      // ……跟着一串 progress（输出在长），再整块换成 done + 完整输出。
      // progress 帧本身不渲染（进度只进 `state.progress`），但真实流里它们夹在
      // upsert 之间，时序上必须不影响顺序。
      progressAppend(8, 2, 'collecting tests'),
      progressAppend(9, 2, '12 passed'),
      toolUpsert(10, {
        id: 2,
        type: 'tool',
        name: 'exec',
        running: false,
        input: { command: 'pnpm test' },
        output: '12 passed (0 failed)',
        execution_location: { kind: 'container', name: 'workspace' },
      }),
      // ③ 第二段文字：工具之后又说话了。
      ...streamText(3, ['测试', '全过了。', '接着更新报告。'], 11),
      // ④ 第二个工具：同样先 running 再 done。
      toolUpsert(14, {
        id: 4,
        type: 'tool',
        name: 'fs_write',
        running: true,
        input: { path: '/data/reports/summary.md' },
      }),
      toolUpsert(15, {
        id: 4,
        type: 'tool',
        name: 'fs_write',
        running: false,
        input: { path: '/data/reports/summary.md' },
        output: 'wrote 2 KB',
      }),
      // ⑤ 收尾文字。
      ...streamText(5, ['报告', '已更新。'], 16),
      /**
       ⑥ 终态：服务端在 `agent_end` 时把**整轮**的块重发一遍
       （`runtimeDeltaForAgentEvent` 的 `EventAgentEnd` 分支给的是全量 messages）。
       这一帧以前会让顺序再跳一次——文字从工具行下面跳回上面。
       */
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 18,
        delta: {
          message_upserts: [
            { id: 1, type: 'text', content: '先跑测试。我从仓库根目录开始。', running: false },
            {
              id: 2,
              type: 'tool',
              name: 'exec',
              running: false,
              input: { command: 'pnpm test' },
              output: '12 passed (0 failed)',
              execution_location: { kind: 'container', name: 'workspace' },
            },
            { id: 3, type: 'text', content: '测试全过了。接着更新报告。', running: false },
            {
              id: 4,
              type: 'tool',
              name: 'fs_write',
              running: false,
              input: { path: '/data/reports/summary.md' },
              output: 'wrote 2 KB',
            },
            { id: 5, type: 'text', content: '报告已更新。', running: false },
          ],
        },
      },
      /**
       ⑦ 收尾：`agent_end` 之后这一轮就结束了（真服务端在这里发
       `delta.run = {status: 'completed'}`，见 `docs/CHAT-ACCEPTANCE.md` §6.① 的 3.5s 那一帧）。

       少了它，这一场会以"整轮都重发完了、run 还在跑"收尾——那同样是真服务端上不会出现的
       画面（工具行全部完成 + 表头还在 Thinking + 按钮还是停止键）。
       */
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 19,
        delta: { run: { run_id: 'scene-run', status: 'completed' } },
      },
    ],
  },

  {
    id: 'chat-reasoning',
    title: '思考过程与正文的分层',
    intent: '思考块是次要信息，不能和正文抢注意力；长思考不能把正文挤出屏幕。',
    expect: '思考块有明显的"这是过程、不是结论"的视觉处理，且默认可折叠或折行收敛。',
    frames: [
      emptySnapshot(),
      runningRunDelta(1),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          user_turn_upserts: [
            {
              turn_id: TURN_USER,
              role: 'user',
              text: '为什么昨天那个部署脚本在 CI 上超时？',
              turn_position: 1,
            },
          ],
        },
      },
      ...streamReasoning(
        20,
        [
          '用户问的是',
          'CI 超时',
          '。我需要',
          '先看脚本',
          '里的等待逻辑',
          '，',
          '再看 CI 的',
          '超时配置',
          '。',
          '可能是',
          '轮询间隔',
          '太短',
          '导致',
          '重试',
          '次数',
          '过多',
          '，也',
          '可能是',
          '镜像拉取',
          '慢。',
          '先假设',
          '是前者',
          '，因为',
          '本地很快',
          '。',
        ],
        3,
      ),
      ...streamText(
        21,
        [
          '最可能的原因是',
          '脚本里轮询间隔',
          '只有 1 秒',
          '，CI 上',
          '镜像拉取慢',
          '导致重试',
          '把总时长',
          '推过了',
          '超时上限',
          '。',
        ],
        30,
      ),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 45,
        delta: { run: { run_id: 'scene-run', status: 'completed' } },
      },
    ],
  },

  {
    id: 'approval-with-options',
    title: '审批：agent 定义了选项',
    intent: 'agent 给的选项要**逐字呈现**——用户需要能选到"始终允许"这类作用域。',
    expect: '每个选项一个按钮，语气（允许/拒绝）可辨；工具与入参能看清。',
    frames: [
      emptySnapshot(),
      runningRunDelta(1),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          user_turn_upserts: [
            {
              turn_id: TURN_USER,
              role: 'user',
              text: '帮我把这次改动提交到 feature 分支',
              turn_position: 1,
            },
          ],
        },
      },
      waitingRunDelta(3, [
        {
          id: 30,
          type: 'tool',
          name: 'git_commit',
          running: false,
          input: {
            command: 'git commit -m "feat: 重构报告导出"',
            cwd: '/data/repo',
          },
          approval: {
            approval_id: 'scene-approval-1',
            short_id: 1,
            status: 'pending',
            can_approve: true,
            options: [
              { id: 'allow_once', name: 'Allow once', kind: 'allow_once' },
              { id: 'allow_always', name: 'Always allow git_commit', kind: 'allow_always' },
              { id: 'reject_once', name: 'Deny', kind: 'reject_once' },
            ],
          },
        },
      ]),
    ],
  },

  {
    id: 'approval-no-options',
    title: '审批：agent 没给选项（必须兜底）',
    intent:
      '实测服务端在 agent 未定义选项时**完全不返回 options 字段**。' +
      '这时必须给"批准/拒绝"兜底——否则是一个没有按钮的审批框，run 永远卡住。',
    expect: '有两个可点的动作，且不显示任何来自 agent 的选项名。',
    frames: [
      emptySnapshot(),
      runningRunDelta(1),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          user_turn_upserts: [
            { turn_id: TURN_USER, role: 'user', text: '清掉 /tmp 下的构建缓存', turn_position: 1 },
          ],
        },
      },
      // 注意：approval 里**没有 options**，这是真实形状。
      waitingRunDelta(3, [
        {
          id: 31,
          type: 'tool',
          name: 'exec',
          running: false,
          input: { command: 'rm -rf /tmp/build-cache', cwd: '/data' },
          approval: {
            approval_id: 'scene-approval-2',
            short_id: 2,
            status: 'pending',
            can_approve: true,
          },
        },
      ]),
    ],
  },

  {
    id: 'chat-error',
    title: '运行失败与内联错误',
    intent: '失败必须说清"哪一步、为什么"，并且给出可操作的下一步；不能只写"出错了"。',
    expect: '顶部有失败条并带原因；对话流里的错误块与工具失败可区分。',
    frames: [
      emptySnapshot(),
      runningRunDelta(1),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          user_turn_upserts: [
            {
              turn_id: TURN_USER,
              role: 'user',
              text: '把 config.toml 里的超时改成 30 秒',
              turn_position: 1,
            },
          ],
        },
      },
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 3,
        delta: {
          message_upserts: [
            {
              id: 40,
              type: 'tool',
              name: 'fs_write',
              running: false,
              input: { path: '/data/config.toml' },
              output: 'permission denied',
            },
            {
              id: 41,
              type: 'error',
              content: '权限不足：目标文件在只读挂载上。',
              code: 'fs.readonly',
            },
            { id: 42, type: 'notice', content: '已回退到上一个可用配置。', name: 'rolled_back' },
          ],
        },
      },
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 4,
        delta: {
          run: {
            run_id: 'scene-run',
            status: 'errored',
            error: '写入被拒：/data 是只读挂载',
          },
        },
      },
    ],
  },

  {
    id: 'chat-error-timeout',
    title: '工具执行失败后的超时（可重试那一档）',
    intent:
      '同一条"工具执行失败"路径的另一档：服务端这次给了**类型化 code**，而且它属于传输层那一档' +
      '（agent.response_timeout，上游 apperror 里是 504 + "Please try again."）。' +
      '这一档必须**给**动作——把用户留在"没有原因、也没有下一步"的屏幕上才是错的（R19/R45）。',
    expect:
      '红卡标题是我们的句子（不是 "Error"）；补充说明是服务端原文；错误码默认**收起**（展开后才出现）；' +
      '末尾有 "Try again"（≥44pt）；VoiceOver 一次读完整句（角色 + 发生了什么 + 为什么 + 动作）。',
    frames: [
      emptySnapshot(),
      runningRunDelta(1),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          user_turn_upserts: [
            {
              turn_id: TURN_USER,
              role: 'user',
              text: '把 config.toml 里的超时改成 30 秒',
              turn_position: 1,
            },
          ],
        },
      },
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 3,
        delta: {
          message_upserts: [
            {
              id: 50,
              type: 'tool',
              name: 'fs_write',
              running: false,
              input: { path: '/data/config.toml' },
              output: 'permission denied',
            },
            {
              id: 51,
              type: 'error',
              content: 'The model did not respond in time. Please try again.',
              code: 'agent.response_timeout',
            },
          ],
        },
      },
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 4,
        delta: {
          run: {
            run_id: 'scene-run',
            status: 'errored',
            error: 'The model did not respond in time.',
          },
        },
      },
    ],
  },

  {
    id: 'chat-long',
    title: '长会话与滚动位置',
    intent: '用户往回翻看历史时，新内容到达不能把他拽回底部；同时要有明显的"回到底部"入口。',
    expect: '上翻后停留在原处；底部出现"回到底部"按钮；按钮不遮挡内容。',
    frames: [
      emptySnapshot(),
      ...Array.from({ length: 6 }, (_, index) => [
        {
          kind: 'delta' as const,
          epoch: EPOCH,
          seq: index * 3 + 1,
          delta: {
            user_turn_upserts: [
              {
                turn_id: `scene-turn-${index}`,
                role: 'user' as const,
                text: `第 ${index + 1} 个问题：这段流程还能再简化吗？`,
                turn_position: index * 2 + 1,
              },
            ],
          },
        },
        {
          kind: 'delta' as const,
          epoch: EPOCH,
          seq: index * 3 + 2,
          delta: {
            message_upserts: [
              {
                id: 100 + index,
                type: 'text' as const,
                content:
                  `可以。第 ${index + 1} 步里有两个重复的校验，合并成一个之后` +
                  '主流程会短一行，而且错误信息更集中。',
              },
            ],
          },
        },
        {
          kind: 'delta' as const,
          epoch: EPOCH,
          seq: index * 3 + 3,
          delta: { run: { run_id: 'scene-run', status: 'completed' as const } },
        },
      ]).flat(),
    ],
  },

  {
    id: 'chat-disconnected',
    title: '连接断开与视图过期',
    intent:
      '移动网络下断开是常态。界面必须诚实说明"你现在看到的可能不是最新的"，' + '而不是假装还连着。',
    expect: '顶部明确显示断开状态，且不把已有内容清空——用户仍能读历史。',
    frames: [
      emptySnapshot(),
      runningRunDelta(1),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          user_turn_upserts: [{ turn_id: TURN_USER, role: 'user', text: '继续', turn_position: 1 }],
        },
      },
      ...streamText(50, ['正在', '处理', '…'], 3),
      // 注意：没有终态。界面应当表现为"可能已经断了"。
    ],
  },

  {
    id: 'chat-attachments',
    title: '附件与图片',
    intent: '图片要能预览，非图片要能看清是什么文件；两者在消息流里都不可喧宾夺主。',
    expect: '图片以缩略图呈现且有合理最大尺寸；文件名可读、可点。',
    frames: [
      emptySnapshot(),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 1,
        delta: {
          user_turn_upserts: [
            {
              turn_id: TURN_USER,
              role: 'user',
              text: '这版 UI 截图和日志都在这里了',
              turn_position: 1,
              attachments: [
                {
                  id: 'a1',
                  type: 'image',
                  name: 'screenshot.png',
                  mime: 'image/png',
                  size: 240_000,
                },
                {
                  id: 'a2',
                  type: 'file',
                  name: 'build-2026-09-13.log',
                  mime: 'text/plain',
                  size: 1_240_000,
                },
              ],
            },
          ],
        },
      },
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          message_upserts: [
            {
              id: 60,
              type: 'text',
              content: '看到了。截图里输入框和键盘之间的间隙偏大，日志里是同一个原因。',
            },
          ],
        },
      },
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 3,
        delta: { run: { run_id: 'scene-run', status: 'completed' } },
      },
    ],
  },

  {
    id: 'ask-user-single',
    title: 'agent 提问：单选 + 自定义',
    intent:
      'agent 用 ask_user 提问时 run 停在 waiting_decision——不回应就永远不继续。' +
      '问题的正文、选项、以及"允许自定义"都必须完整可见，提交按钮只在答案完整时可用。',
    expect:
      '底部弹出提问表：问题正文 + 三个选项（单选，一行一个）；因为 allow_custom 为真、' +
      '且只有这一题，底部给一个输入框（写"其他"无需先点 Other）；提交按钮此时**禁用**' +
      '（必答未答），取消按钮可点。',
    frames: [
      emptySnapshot(),
      runningRunDelta(1),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          user_turn_upserts: [
            {
              turn_id: TURN_USER,
              role: 'user',
              text: '把这批图片导出成什么格式？',
              turn_position: 1,
            },
          ],
        },
      },
      waitingRunDelta(3, [
        {
          id: 70,
          type: 'tool',
          name: 'ask_user',
          running: false,
          // 真实形状：提问挂在 tool 块的 `user_input` 上，走审批同一套决策机制。
          // `required` 在这里**故意省略**——老式 ask_user 载荷就是省略的，
          // 上游政策是"缺省即必答"（见 reducer 的 questionFrom 注释）。
          user_input: {
            user_input_id: 'scene-input-1',
            short_id: 1,
            status: 'pending',
            can_respond: true,
            questions: [
              {
                id: 'q1',
                text: '导出格式选哪个？',
                kind: 'single_select',
                allow_custom: true,
                options: [
                  { id: 'o1', label: 'WebP（体积小）', description: '适合直接发布' },
                  { id: 'o2', label: 'PNG（无损）', description: '体积最大' },
                  { id: 'o3', label: 'AVIF', description: '压缩率最高，兼容性差' },
                ],
              },
            ],
          },
        },
      ]),
    ],
  },

  {
    id: 'ask-user-multi',
    title: 'agent 提问：多问题（选项 + 文本）',
    intent:
      '一次问多个问题时，每个问题各自成组（多问题的答案不能塞进一个底部输入框）。' +
      '文本问题必须有输入框，选择问题的输入框只在选了"其他"之后才出现。',
    expect:
      '两题分块：第一题多选 + 三个选项 + "其他…"行；第二题文本带独立输入框。' +
      '没有底部输入框（多问题时它会出现歧义）；提交禁用直到两题都答完。',
    frames: [
      emptySnapshot(),
      runningRunDelta(1),
      {
        kind: 'delta',
        epoch: EPOCH,
        seq: 2,
        delta: {
          user_turn_upserts: [
            {
              turn_id: TURN_USER,
              role: 'user',
              text: '帮我准备发布，先确认两件事',
              turn_position: 1,
            },
          ],
        },
      },
      waitingRunDelta(3, [
        {
          id: 71,
          type: 'tool',
          name: 'ask_user',
          running: false,
          user_input: {
            user_input_id: 'scene-input-2',
            short_id: 2,
            status: 'pending',
            can_respond: true,
            questions: [
              {
                id: 'q1',
                text: '要更新哪些渠道？',
                kind: 'multi_select',
                allow_custom: true,
                // ACP 表单会显式给这两个字段；这里是它的形状。
                custom_exclusive: false,
                required: true,
                options: [
                  { id: 'o1', label: 'App Store' },
                  { id: 'o2', label: 'TestFlight', description: '仅内部' },
                  { id: 'o3', label: '企业分发' },
                ],
              },
              {
                id: 'q2',
                text: '版本号写什么？',
                kind: 'text',
                required: true,
                placeholder: '例如 0.2.0',
              },
            ],
          },
        },
      ]),
    ],
  },
  {
    id: 'chat-info',
    title: '会话信息：这台部署的真实形状（没有窗口）',
    intent:
      '面板要回答"这个会话到哪儿了"。而**这台部署的服务端不给上下文窗口**——' +
      'status 只回 used_tokens。这时绝不能算百分比：分母是编的，而用户会拿它判断' +
      '还有多少余量。所以这里验证"没有分母时不显示比例，只报绝对值"。',
    expect:
      '分组卡片：上下文（已用 token，**没有进度条也没有百分比**）、会话（消息数）、' +
      '缓存（命中率 / 缓存读取 / 输入 token）；页脚说明为什么没有比例。' +
      '数值取自部署机上实测的响应。',
    // 数据是 2026-09-14 从部署服务端取下来的真实响应，逐字段照抄。
    sheet: {
      kind: 'sessionInfo',
      status: {
        message_count: 4,
        context_usage: { used_tokens: 12440 },
        cache_stats: {
          cache_read_tokens: 24064,
          total_input_tokens: 24723,
          cache_hit_rate: 97.33446588197225,
        },
        skills: [],
      },
    },
    frames: [emptySnapshot(), runningRunDelta(1)],
  },

  {
    id: 'chat-info-with-window',
    title: '会话信息：服务端给了窗口时的形状',
    intent:
      '上游较新的版本会同时给出 context_window 与压缩阈值。那一支代码现在也必须' +
      '是对的——否则等服务器升级，进度条会第一次被真正执行，而它从没被看过。' +
      '这个场景把那个形状渲染出来（数据是按字段语义构造的，不是某台机器的实测值）。',
    expect:
      '多出"上下文用量"一行带进度条与百分比，以及"上下文窗口""自动压缩阈值"两行；' +
      '页脚**不再**说明缺窗口；最后还有"用过的技能"那一组（逐个列出技能名）。',
    sheet: {
      kind: 'sessionInfo',
      status: {
        message_count: 42,
        context_usage: {
          used_tokens: 96_000,
          context_window: 200_000,
          budget_plan: { window: 160_000, output_reserve: 8_000 },
          compaction: { enabled: true, auto_tokens: 128_000 },
        },
        cache_stats: {
          cache_read_tokens: 512_000,
          total_input_tokens: 640_000,
          cache_hit_rate: 80,
        },
        // 字符串数组，照 `HandlersSessionInfoResponse.skills` 的形状（见 `bots-run.sh approval`）。
        skills: ['skill-creator', 'pdf'],
      },
    },
    frames: [emptySnapshot(), runningRunDelta(1)],
  },

  {
    id: 'probe-stream',
    title: '探针：流式追加（基准）',
    intent:
      '给帧级几何探针（tools/frame-probe）当输入：8 轮历史 + 160 次按 id 追加，' +
      '300ms 一次（约 50 秒）。用来量"首条可见行位移、距底距离、掉帧率"这组不变量。',
    expect: '文字持续长出来；不点不滑时它自己贴底；往上翻之后新内容不把视图拽回去。',
    // 300ms 而不是服务端的 40ms：手势自动化（Maestro）冷启动要几十秒，流式必须比它长，
    // 否则"往上翻"永远发生在流式结束之后，阅读模式那两条判据一对样本都拿不到。
    intervalMs: 300,
    frames: [
      emptySnapshot(),
      ...probeHistory(0, 8),
      ...probeStream(16, 160, 24),
      probeFrame(177, { run: { run_id: 'scene-run', status: 'completed' as const } }),
    ],
  },

  {
    id: 'probe-stream-heavy',
    title: '探针：流式追加（重载对照）',
    intent:
      '与 probe-stream 同形状，但每次追加 120 字（正文累计约 19k 字）。' +
      '这是**已知会掉帧**的对照：尺子若在这里也量不出差异，说明尺子坏了。',
    expect: '文字快速长出来；掉帧明显多于基准场景——这正是它存在的理由。',
    intervalMs: 300,
    frames: [
      emptySnapshot(),
      ...probeHistory(0, 8),
      ...probeStream(16, 120, 120),
      probeFrame(137, { run: { run_id: 'scene-run', status: 'completed' as const } }),
    ],
  },

  {
    id: 'probe-stream-long',
    title: '探针：长会话 + 持续追加（50 轮历史）',
    intent:
      '给帧级几何探针当输入：**50 轮历史（≈102 行）** + 160 次按 id 追加，300ms 一次。' +
      '追加的参数与 probe-stream（8 轮历史）**逐字相同**，唯一的变量是历史长度——' +
      '所以它量的是"追加的单价随转录长度怎么变"，不是"另一个场景好不好看"。',
    expect: '文字持续长出来；不点不滑时它自己贴底；往上翻之后新内容不把视图拽回去。',
    intervalMs: 300,
    frames: [
      emptySnapshot(),
      ...probeHistoryBatched(0, 50, 25),
      ...probeStream(2, 160, 24, 9000),
      probeFrame(163, { run: { run_id: 'scene-run', status: 'completed' as const } }),
    ],
  },

  {
    id: 'probe-stream-long-300',
    title: '探针：长会话 + 持续追加（300 轮历史）',
    intent:
      '与 probe-stream-long 逐字相同，只把历史从 50 轮换成 **300 轮（≈602 行）**。' +
      '两档一起看，才能读出一句"每多 N 行，每次追加贵多少"。',
    expect: '与 50 轮那一档同样的观感，但每次追加要重算的转录大 6 倍。',
    intervalMs: 300,
    frames: [
      emptySnapshot(),
      ...probeHistoryBatched(0, 300, 25),
      ...probeStream(12, 160, 24, 9000),
      probeFrame(173, { run: { run_id: 'scene-run', status: 'completed' as const } }),
    ],
  },
];

export function findScene(id: string): Scene | null {
  return SCENES.find((scene) => scene.id === id) ?? null;
}
