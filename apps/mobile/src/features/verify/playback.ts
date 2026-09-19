/**
 * 场景回放器（仅开发，不渲染 UI）。
 *
 * 把 `scenes.ts` 里的帧序列按顺序喂给**真实的 reducer**，得到状态，再交给真实的
 * 屏幕组件渲染。这样截图证明的是"服务端发这些帧时界面长什么样"，而不是
 * "我能画一个手搓的对象"。
 *
 * 帧之间有间隔：一是让流式追加看起来像流式（截图能抓到中间态），二是给 UIKit
 * 侧的消息列表时间做增量更新——一次性灌进去只会看到最后一帧，中间态就被跳过了。
 */
import { useEffect, useRef, useState } from 'react';

import { applyDelta, applySnapshot, initialChatState, type ChatState } from '../chat/reducer.ts';
import type { Scene, SceneFrame } from './scenes.ts';

/** 每帧之间的间隔。太快看不到中间态，太慢截图要等很久。 */
const FRAME_INTERVAL_MS = 220;

/**
 场景自己的间隔优先。

 `scenes.ts` 的 `intervalMs` 从写下那天起就写着"帧间隔（毫秒）"，而这里一直只读
 `FRAME_INTERVAL_MS`——**文档与实现不一致**：想复现"高频更新"的场景（流式探针）根本快
 不起来。现在按 `scene.intervalMs ?? FRAME_INTERVAL_MS` 取，不写 `intervalMs` 的场景
 行为一字不改。
 */
function intervalFor(scene: Scene): number {
  const value = scene.intervalMs;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return FRAME_INTERVAL_MS;
  return value;
}

export interface ScenePlayback {
  chat: ChatState;
  /** 已经回放到第几帧，用于确认"确实放完了"。 */
  progress: { current: number; total: number };
  done: boolean;
}

function applyFrame(state: ChatState, frame: SceneFrame): ChatState {
  if (frame.kind === 'snapshot') return applySnapshot(state, frame.payload);
  return applyDelta(state, frame.epoch, frame.seq, frame.delta);
}

/**
 * 回放一个场景。
 *
 * 返回的 `chat` 可以直接交给渲染层——它经过的路径与真实数据完全一致。
 */
export function useScenePlayback(scene: Scene | null): ScenePlayback {
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [current, setCurrent] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (scene === null) {
      setChat(initialChatState);
      setCurrent(0);
      return;
    }

    // 从头开始：每个场景都是一次干净的回放，不残留上一个的状态。
    let state = initialChatState;
    let index = 0;
    setChat(state);
    setCurrent(0);

    timerRef.current = setInterval(() => {
      if (index >= scene.frames.length) {
        if (timerRef.current !== null) clearInterval(timerRef.current);
        timerRef.current = null;
        return;
      }
      const frame = scene.frames[index];
      index += 1;
      if (frame !== undefined) {
        state = applyFrame(state, frame);
        setChat(state);
      }
      setCurrent(index);
    }, intervalFor(scene));

    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [scene]);

  return {
    chat,
    progress: { current, total: scene?.frames.length ?? 0 },
    done: scene !== null && current >= scene.frames.length,
  };
}

/** 立即放完（不走动画）。给"只关心最终态"的截图用。 */
export function replaySceneNow(scene: Scene): ChatState {
  let state = initialChatState;
  for (const frame of scene.frames) state = applyFrame(state, frame);
  return state;
}
