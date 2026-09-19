/**
 * 场景查看页（仅开发）。
 *
 * 从 Debug 页进来，列出所有场景。点进去用**真实屏幕组件**渲染回放结果——
 * 这是设计迭代的快照台：改完看这里，而不是每次都去连真服务端跑一轮。
 *
 * 它不依赖登录、不依赖服务端、不依赖网络。验收基线要在空手上能复现，这一页是
 * 那个承诺的落点。
 *
 * ⚠️ **它不是产品，也不能当产品评**（2026-09-17 立的规矩）：
 *   - 这一页**没有 composer**，也不画表头副标题——"运行中"在这里无从表达；
 *   - 内容是**固定帧回放**（`features/verify/scenes.ts`），
 *     `chat-long` 那种罐头内容会被误读成"回复重复五遍"；
 *   - 时序什么都不代表：帧由 `setInterval` 喂 reducer，不是真实网络。
 *   所以两页都挂了一条显眼的回放标识；产品行为只有一个判据：真服务端那一轮
 *   （`docs/CHAT-ACCEPTANCE.md` §2）。
 *
 * 真机正常路径进不来：入口在 Settings 里是 `__DEV__` 分支，验收那条路要
 * `verify/seed.ts` 的种子文件（同样只在 `__DEV__` 下读）。残留的口子只有手输深链
 * `/debug/scene/<id>`——那不是正常路径。
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hasContent, turnsForDisplay } from '../features/chat/reducer.ts';
import { useScenePlayback } from '../features/verify/playback.ts';
import { findScene, SCENES } from '../features/verify/scenes.ts';
import { NativeMessageList } from '@memoh-ios/kit';
import { ApprovalView } from '../ui/ApprovalPage.tsx';
import { SessionInfoView } from '../ui/SessionInfoPage.tsx';
import { UserInputView } from '../ui/UserInputPage.tsx';
import { usePalette, useTheme } from '../lib/theme/context.tsx';

/** 场景索引：列出全部场景，点进去看。 */
export function SceneIndexScreen() {
  const palette = usePalette();
  const { spacing, typography, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.groupedBackground }}
      contentContainerStyle={{ padding: spacing.lg, paddingTop: insets.top + spacing.lg }}
    >
      <Pressable
        accessibilityRole="button"
        onPress={() => router.back()}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={[typography.body, { color: '#007AFF' }]}>‹ Back</Text>
      </Pressable>
      <Text style={[typography.title2, { color: palette.label, marginBottom: spacing.xs }]}>
        Scenes
      </Text>
      {/* 同上：这一页是**验收回放台**，不是产品。标识要出现在截图上（2026-09-17）。 */}
      <View
        style={{
          backgroundColor: palette.field,
          borderLeftWidth: 3,
          borderLeftColor: palette.warning,
          borderRadius: radius.sm,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
          marginBottom: spacing.xs,
        }}
      >
        <Text style={[typography.caption, { color: palette.warning }]}>
          回放画面 · 不是产品界面
        </Text>
        <Text style={[typography.caption2, { color: palette.secondaryLabel, marginTop: 2 }]}>
          这里只回放固定帧序列（没有输入区）；运行时行为与真服务端那一轮才代表产品。
        </Text>
      </View>
      <Text
        style={[typography.footnote, { color: palette.secondaryLabel, marginBottom: spacing.lg }]}
      >
        用真实组件渲染固定帧序列。不依赖登录、服务端或网络。
      </Text>

      <View style={{ backgroundColor: palette.card, borderRadius: radius.md, overflow: 'hidden' }}>
        {SCENES.map((scene, index) => (
          <Pressable
            key={scene.id}
            accessibilityRole="button"
            onPress={() => router.push(`/debug/scene/${scene.id}`)}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: pressed ? palette.field : palette.card,
                borderBottomWidth: index === SCENES.length - 1 ? 0 : StyleSheet.hairlineWidth,
                borderBottomColor: palette.separator,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
              },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[typography.callout, { color: palette.label }]}>{scene.title}</Text>
              <Text
                style={[typography.footnote, { color: palette.secondaryLabel, marginTop: 2 }]}
                numberOfLines={2}
              >
                {scene.intent}
              </Text>
            </View>
            <Text style={[typography.body, { color: palette.tertiaryLabel }]}>›</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

/**
 * 单个场景。
 *
 * ⚠️ 这里刻意**复用 ChatScreen 的渲染分支**（NativeMessageList + 审批/提问面板），
 * 而不是另写一套。另写一套的话，改坏了生产组件这里看不出来——场景就失去了意义。
 */
export function SceneScreen() {
  const params = useLocalSearchParams<{ sceneId: string }>();
  const palette = usePalette();
  const { spacing, typography, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const scene = useMemo(
    () => (params.sceneId ? findScene(params.sceneId) : null),
    [params.sceneId],
  );
  const { chat, progress, done } = useScenePlayback(scene);

  const turns = useMemo(() => turnsForDisplay(chat).filter(hasContent), [chat]);
  const turnsJson = useMemo(() => JSON.stringify(turns), [turns]);

  if (scene === null) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: palette.groupedBackground,
        }}
      >
        <Text style={[typography.body, { color: palette.secondaryLabel }]}>未知场景</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={[typography.body, { color: '#007AFF' }]}>‹ Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.groupedBackground }}>
      <View
        style={{
          paddingTop: insets.top,
          paddingBottom: spacing.sm,
          paddingHorizontal: spacing.lg,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: palette.separator,
          backgroundColor: palette.card,
        }}
      >
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={[typography.body, { color: '#007AFF' }]}>‹ Scenes</Text>
        </Pressable>
        <Text style={[typography.headline, { color: palette.label }]} numberOfLines={1}>
          {scene.title}
        </Text>
        {/*
          回放标识：**这一页不是产品**。它没有输入区（composer）、也不代表真服务端的时序。

          2026-09-17：aiden 拿这一页当产品界面评过（"同一句回复重复五遍"来自 chat-long 的
          罐头内容；"工具在转圈但按钮是发送"里有一个表达也是这一页/固定服务端的组合）。
          这一页以前刻意**不放**说明文字，理由是"截图上多一行就像原型"——那条理由的代价
          正是这次误判，所以反过来：标识要显眼到出现在每一张场景截图里。
        */}
        <View
          style={{
            backgroundColor: palette.field,
            borderLeftWidth: 3,
            borderLeftColor: palette.warning,
            borderRadius: radius.sm,
            paddingHorizontal: spacing.sm,
            paddingVertical: spacing.xs,
            marginTop: spacing.xs,
          }}
        >
          <Text style={[typography.caption, { color: palette.warning }]}>
            回放画面 · 不是产品界面
          </Text>
          <Text style={[typography.caption2, { color: palette.secondaryLabel, marginTop: 2 }]}>
            固定帧序列由 reducer 回放：没有输入区，也不代表真服务端的时序。产品行为看真服务端。
          </Text>
        </View>
        {/* 调试信息**仍然极简**：只有 id 与回放进度。
            场景的"期望效果"在场景索引页里看（那里是浏览的地方），不占截图。
            上面那条"回放画面 · 不是产品界面"是例外——它是**必须出现在截图里**的一句话
            （2026-09-17 的误判就是靠它避免的）。

            id 必须留在屏幕上：验收脚本靠它确认"确实是这个场景"，比匹配中文标题可靠
            （标题里的全角标点 OCR 认出来未必一致）。 */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Text
            style={[typography.caption2, { color: palette.tertiaryLabel }]}
          >{`#${scene.id}`}</Text>
          <Text style={[typography.caption2, { color: done ? palette.success : palette.warning }]}>
            {done
              ? `replayed ${progress.total}/${progress.total}`
              : `frame ${progress.current}/${progress.total}`}
          </Text>
        </View>
      </View>

      {chat.runStatus === 'errored' ? (
        <View
          style={{
            backgroundColor: palette.field,
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
          }}
        >
          <Text style={[typography.subhead, { color: palette.destructive }]}>Run failed</Text>
          {chat.runError !== null ? (
            <Text style={[typography.footnote, { color: palette.secondaryLabel, marginTop: 2 }]}>
              {chat.runError}
            </Text>
          ) : null}
        </View>
      ) : null}

      <NativeMessageList
        key={scene.id}
        turnsJson={turnsJson}
        style={{ flex: 1 }}
        emptyTitle="No messages"
        emptyBody=""
      />

      {/* 审批面板在场景里也只是渲染，不做动作——场景只负责展示状态。
          注意：这里画的是**纯展示**那一半（`ApprovalView`）。真实的出席形态是原生
          formSheet（detent / 抓手 / 侧滑策略），只有 `present()` 打开时才看得见；
          场景台看的是"内容与状态对不对"，不是 sheet 的外壳。 */}
      {chat.approval === null ? null : (
        <View
          style={{
            backgroundColor: palette.card,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
          }}
        >
          <ApprovalView approval={chat.approval} onChoose={() => {}} />
        </View>
      )}
      {/* 与 ChatScreen 同一套分支：场景台要能看见提问表的真实样子。
          这里的提交/取消是空实现——场景不连服务端。 */}
      {chat.userInput === null ? null : (
        <View
          style={{
            backgroundColor: palette.card,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
          }}
        >
          <UserInputView
            key={chat.userInput.userInputId}
            userInput={chat.userInput}
            onSubmit={() => {}}
            onCancel={() => {}}
          />
        </View>
      )}
      {/* 会话信息面板同样只是渲染：数据由场景给（见 scenes.ts 的 sheet 字段）。
          和审批一样，这里画的是纯展示那一半；原生形态（fitToContents 的 sheet）只有在
          `present()` 打开时才看得见。 */}
      {scene.sheet?.kind === 'sessionInfo' ? (
        <View
          style={{
            backgroundColor: palette.card,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
          }}
        >
          <SessionInfoView
            status={scene.sheet?.status ?? null}
            loading={false}
            error={null}
            onClose={() => {}}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 64,
  },
});
