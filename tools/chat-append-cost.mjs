/**
 * JS 侧的"每次追加要重算多少"——**不需要设备、不需要 Metro**。
 *
 * ## 它补的是哪个缺口
 *
 * `docs/research/ios-performance-practices.md` §2.1/§7 写着：帧探针量的是**主线程投递**，
 * 而 `turnsForDisplay` + `JSON.stringify(整份转录)` 跑在 **JS 线程**上，**没有任何口径**。
 * 于是"每个 token 的代价是 O(整份转录)"这句话，在 JS 这一半一直没有数字。
 *
 * 这一条把那一半变成数字：拿**真实的场景帧**（`src/features/verify/scenes.ts` 的
 * `probe-stream*`）逐帧喂给**真实的 reducer** 与 `turnsForDisplay`，量每次追加的三件事：
 *
 *   - `reducer`：`applyDelta`（拼接正文、重建 order）
 *   - `turns`：`turnsForDisplay`（全量重建展示数组）+ `filter(hasContent)`
 *   - `json`：`JSON.stringify`（过桥的那份字符串，原生侧每次都要整份解码）
 *
 * ## 口径（必须一起报）
 *
 * 这是 **Node（V8）** 上的数字，不是 App 里的：App 跑 Hermes、还要过 React 渲染与桥。
 * 所以它只能回答"这一段的**形状**是什么"（随行数怎么变、谁是大头），不能当 App 的绝对值。
 * 与原生侧那半（`tools/frame-probe` 的 `append_cost`）合起来才是"每个 token 的总代价"。
 *
 * 用法：
 *     node --experimental-strip-types tools/chat-append-cost.mjs
 *     node --experimental-strip-types tools/chat-append-cost.mjs probe-stream-long-300
 */
import { performance } from 'node:perf_hooks';

import {
  applyDelta,
  applySnapshot,
  hasContent,
  initialChatState,
  turnsForDisplay,
} from '../apps/mobile/src/features/chat/reducer.ts';
import { SCENES } from '../apps/mobile/src/features/verify/scenes.ts';

/** 一个场景逐帧回放，量"追加"（`message_appends`）那一半的每次成本。 */
function measureScene(scene) {
  let state = initialChatState;
  const samples = [];
  let rows = 0;
  for (const frame of scene.frames) {
    if (frame.kind === 'snapshot') {
      const started = performance.now();
      state = applySnapshot(state, frame.payload);
      void started;
      continue;
    }
    if (frame.delta.message_appends === undefined) {
      // 历史那一半（upsert）：不在"追加的单价"里，跳过计时。
      state = applyDelta(state, frame.epoch, frame.seq, frame.delta);
      continue;
    }
    const before = state;
    const t0 = performance.now();
    const next = applyDelta(before, frame.epoch, frame.seq, frame.delta);
    const t1 = performance.now();
    const turns = turnsForDisplay(next).filter(hasContent);
    const t2 = performance.now();
    const json = JSON.stringify(turns);
    const t3 = performance.now();
    state = next;
    rows = turns.reduce(
      (count, turn) =>
        count + (turn.user?.blocks.length ?? 0) + (turn.assistant?.blocks.length ?? 0),
      0,
    );
    samples.push({ reducer: t1 - t0, turns: t2 - t1, json: t3 - t2, bytes: json.length, rows });
  }
  return { id: scene.id, samples, rows };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

const wanted = process.argv.slice(2);
const scenes = SCENES.filter(
  (scene) =>
    scene.id.startsWith('probe-stream') && (wanted.length === 0 || wanted.includes(scene.id)),
);
if (scenes.length === 0) {
  console.error(`没有匹配的场景：${wanted.join(',') || '(空)'}`);
  process.exit(1);
}

console.log(
  '场景                     行数  每次追加(ms)：reducer / turns / 序列化   过桥字符串   每次 +字节',
);
for (const scene of scenes) {
  const { id, samples, rows } = measureScene(scene);
  if (samples.length === 0) continue;
  const third = Math.max(1, Math.floor(samples.length / 3));
  const head = samples.slice(0, third);
  const tail = samples.slice(-third);
  const show = (bucket, key) => median(bucket.map((sample) => sample[key])).toFixed(3);
  const bytes = samples.map((sample) => sample.bytes);
  const growth = (samples[samples.length - 1].bytes - samples[0].bytes) / samples.length;
  console.log(
    `${id.padEnd(24)} ${String(rows).padStart(4)}  ` +
      `头 1/3 ${show(head, 'reducer')} / ${show(head, 'turns')} / ${show(head, 'json')}   ` +
      `尾 1/3 ${show(tail, 'reducer')} / ${show(tail, 'turns')} / ${show(tail, 'json')}   ` +
      `${String(median(bytes)).padStart(8)} B   ${growth.toFixed(0)}`,
  );
}
