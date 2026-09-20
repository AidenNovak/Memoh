/**
 * 定时任务编辑页（新建与修改共用）。
 *
 * ## 为什么"要它做什么"必须写清楚它是什么
 *
 * `command` 是**一条发给 agent 的消息**，不是 shell 命令。这两个字之差决定了用户会写
 * "cd /data && make build" 还是"看一下构建有没有挂，挂了就总结原因"。所以这个输入框
 * 下面带一行脚注明说，而不是让用户自己猜（上游 Web 也是这么解释的）。
 *
 * ## 保存时的两条纪律
 *
 * 1. `execution` 要**整块回写**（服务端只接受完整状态），所以草稿是从 `GET` 读出来的九个
 *    字段，保存时原样发回——只改用户真的动过的那一项（见 `useSchedule.ts` 的文件头）。
 * 2. `max_calls` 空字符串 = **不限**，不是 0。0 或负数不接受：那更像误操作。
 *
 * ## 键盘、焦点与"点了没反应"（2026-09-17）
 *
 * 用户真实的顺序是"打完一栏点下一栏"。键盘升起后 `KeyboardAvoidingView` 只把
 * ScrollView 的高度让开，**内容不会自己让位**——所以最下面那一栏会有一截留在键盘底下。
 * 实测（`verification/navigation` 最小复现）打 description 之后点 `What to do`：
 *
 * - 那一栏下缘在键盘下面（框 500–588pt，键盘顶 583pt）；
 * - 点击落在键盘边缘 → 焦点**没有换**，页面一点变化都没有；
 * - 接着打的字被追加进**上一层仍是焦点的 Description**，底部却挂着
 *   `Can't save yet — Tell the agent what to do`。用户以为填完了，其实没有，还被告知
 *   "没说要做什么"。
 *
 * 三件事一起做才算修好，缺一条这个形态都会回来：
 *
 * 1. **必填的那一栏挪到前面**（紧跟 Basics）：首屏可见，键盘弹起时它在键盘上面；
 * 2. **谁拿到焦点，谁就整个滚到键盘上面**（`bringFocusedInputIntoView`）——这是通用的一条，
 *    不管哪一栏都不许被键盘盖住；
 * 3. **点哪儿都能聚焦到该聚焦的框**，且"缺哪一栏"时按 Save 把人**送到那一栏**去：
 *    块级可点 + Return 键串联（换框不必依赖手指落在哪一帧的坐标上）+ 校验失败时聚焦。
 *
 * 不用 `automaticallyAdjustKeyboardInsets`：`ui/ApprovalPage.tsx` 记过它在 sheet 上会让
 * 整块内容点按失效。这里用可测的显式滚动，不赌一个会静默改变命中判定的属性。
 */
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { useT } from '../lib/i18n/useT.ts';
import { GROUP_INSET, MIN_TOUCH_TARGET, radius, spacing, typography } from '../lib/theme/tokens.ts';
import { usePalette, useTheme } from '../lib/theme/context.tsx';
import { useSession } from '../features/session/store.tsx';
import { Group, Row } from '../ui/GroupedList.tsx';
import { nextRunLabel, parseMaxCalls, safeTimezone } from '../features/schedule/describe.ts';
import { timezoneLine } from '../features/bots/timezones.ts';
import { nextRunAt } from '../features/schedule/cron.ts';
import { scrollOverlap, visibleBottom } from '../features/schedule/keyboard.ts';
import { present } from '../lib/presentation/index.ts';
import { CronPickerSheet } from '../ui/CronPickerPage.tsx';
import { RunTargetPickerSheet } from '../ui/RunTargetPickerPage.tsx';
import { BackButton } from '../ui/BackButton.tsx';
import { checkRunTarget, selectedSessionLabel } from '../features/schedule/runTarget.ts';
import { useScheduleEditor } from '../features/schedule/useSchedule.ts';
import { reasonKeyOf } from '../features/errors/present.ts';
import { ErrorNotice } from '../ui/ErrorNotice.tsx';
import { canManageBot } from '../features/bots/permissions.ts';

/** 常见频率的预设。写进去的是规范化 5 段——用户看到的是"每天 09:00"这种话。 */
export function ScheduleEditScreen({ scheduleId }: { scheduleId: string | null }) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { typography: type } = useTheme();
  const t = useT();
  const router = useRouter();
  const { state, currentBot, refreshBots } = useSession();
  const allowed = canManageBot(currentBot);

  const timezone = safeTimezone(currentBot?.timezone);
  /** "按哪个时区算"那一行：**编辑页和列表都要有**——写 09:00 的人就在这里。 */
  const line = timezoneLine(currentBot?.timezone);
  const { draft, patch, loading, saving, error, running, save } = useScheduleEditor(
    state.client,
    allowed ? (currentBot?.id ?? null) : null,
    scheduleId,
  );

  const [maxCallsText, setMaxCallsText] = useState<string>('');
  const [maxCallsReady, setMaxCallsReady] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  /**
   * 表单里每个输入框的句柄 + 键盘/滚动位置。

   * `inputs` 用一棵 record 而不是五个 `useRef`：校验失败时"该把用户送到哪一栏"
   * 是一个封闭集合（`MissingField`），用键取句柄就不会在加字段时漏掉一处。
   */
  const inputs = useRef<Record<TextField, TextInput | null>>({
    name: null,
    description: null,
    command: null,
    pattern: null,
    maxCalls: null,
  });
  const scrollRef = useRef<ScrollView>(null);
  /** ScrollView 当前滚到哪（`scrollTo` 要的是绝对偏移，不是增量）。 */
  const contentOffset = useRef(0);
  /** 键盘顶边在窗口坐标里的 y；`null` = 键盘不在（还没起来 / 刚收起）。 */
  const keyboardTop = useRef<number | null>(null);
  const focusedInput = useRef<TextInput | null>(null);

  /**
   把某一栏滚到**看得见的地方**（键盘上面）。

   为什么必须有这一条：键盘升起时 `KeyboardAvoidingView` 只让开了高度，**内容不会自己
   让位**，所以最下面那一栏会有一截留在键盘底下；点它时手指落在键盘边缘 → 焦点没换 →
   接着打的字进了上一层仍是焦点的框（见文件头）。修法不是"把某一栏挪走"，而是
   "**谁拿到焦点，谁就整个在键盘上面**"——这一条对每一栏都成立。

   看得见的下边界取两个里的更靠上那个：键盘顶边（键盘升起时的权威值）与 ScrollView
   自己的下边缘（没有键盘时就是屏幕底）。`KeyboardAvoidingView` 的 padding 也在收窄
   ScrollView，所以第二个量在键盘动画到位后同样正确——两个都取一遍，动画中途也不会算错。
   */
  const bringIntoView = useCallback(
    (node: TextInput | null) => {
      if (node === null) return;
      // 两步算术在 `features/schedule/keyboard.ts`（可单测，见那个文件头）。
      const limit = visibleBottom({
        keyboardTop: keyboardTop.current,
        windowHeight,
        bottomInset: insets.bottom,
      });
      node.measureInWindow((_x, y, _width, height) => {
        const overlap = scrollOverlap({
          inputTop: y,
          inputHeight: height,
          limit,
          // 留一行间距：贴着键盘顶边的那一栏看起来仍然像"被压着"。
          gap: spacing.md,
        });
        if (overlap <= 0) return;
        scrollRef.current?.scrollTo({ y: contentOffset.current + overlap, animated: true });
      });
    },
    [insets.bottom, windowHeight],
  );

  useEffect(() => {
    const frame = Keyboard.addListener('keyboardWillChangeFrame', (event) => {
      keyboardTop.current = event.endCoordinates.screenY;
      bringIntoView(focusedInput.current);
    });
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      bringIntoView(focusedInput.current);
    });
    const hidden = Keyboard.addListener('keyboardWillHide', () => {
      keyboardTop.current = null;
    });
    return () => {
      frame.remove();
      shown.remove();
      hidden.remove();
    };
  }, [bringIntoView]);

  /** 焦点进到某一栏：记住是谁，并立刻让它整个露在键盘上面。 */
  const onFieldFocus = useCallback(
    (node: TextInput | null) => {
      focusedInput.current = node;
      bringIntoView(node);
    },
    [bringIntoView],
  );

  /** 把用户**送到某一栏**（聚焦 + 滚到看得见），"缺哪一栏"与"点块里任意位置"都走它。 */
  const focusField = useCallback(
    (field: TextField) => {
      const node = inputs.current[field];
      if (node === null) return;
      focusedInput.current = node;
      node.focus();
      // 已经在这一栏时 `focus()` 不会再触发 `onFocus`，所以这一次要自己来。
      bringIntoView(node);
    },
    [bringIntoView],
  );

  // 草稿从服务端回来（或切到新建）时，把"最多执行次数"同步进文本框。
  // `null` 显示成空——那就是"不限"。
  const maxCallsValue = draft.maxCalls;
  React.useEffect(() => {
    if (loading) return;
    setMaxCallsText(maxCallsValue === null ? '' : String(maxCallsValue));
    setMaxCallsReady(true);
  }, [loading, maxCallsValue]);

  const nextPreview = useMemo(() => {
    const at = nextRunAt(draft.pattern, timezone, new Date());
    const label = nextRunLabel(at, new Date(), timezone);
    if (label.kind === 'unknown') return t('schedule.next.unknown');
    // day 与 time 分开传：`today at 09:00` 里的 `at` 只有整句知道该放哪（中文不用它）。
    return t('schedule.next.at', { day: dayLabel(label, t), time: label.time });
  }, [draft.pattern, t, timezone]);

  const onSave = async () => {
    setValidationError(null);
    // 每一条校验失败都**把人送到缺的那一栏**：底部那句话说明错了什么，
    // 焦点与滚动说明"要改的就是这里"。只留一句话的话，用户得自己在长表单里找。
    if (draft.name.trim() === '') {
      setValidationError(t('schedule.error.name'));
      focusField('name');
      return;
    }
    // 说明也是必填：服务端对四个字段（名称/说明/表达式/命令）一起校验，缺一个就整条拒绝
    // （而且它以 500 返回，不是 400）。这种错要在本地就拦住，别让用户吃一个"服务器错误"。
    if (draft.description.trim() === '') {
      setValidationError(t('schedule.error.description'));
      focusField('description');
      return;
    }
    if (draft.command.trim() === '') {
      setValidationError(t('schedule.error.command'));
      focusField('command');
      return;
    }
    const parsed = parseMaxCalls(maxCallsText);
    if (!parsed.ok) {
      setValidationError(t('schedule.error.maxCalls'));
      focusField('maxCalls');
      return;
    }
    // 运行位置与 cron 是同一类约束：**不合法就别发**。这一条与选择器读同一份判断
    // （`checkRunTarget`），所以两处不会漂移。
    const runTargetCheck = checkRunTarget({
      runTarget: draft.execution.runTarget,
      targetSessionId: draft.execution.targetSessionId,
    });
    if (!runTargetCheck.ok) {
      setValidationError(t(runTargetCheck.problemKey ?? 'schedule.error.runTarget'));
      return;
    }
    if (parsed.value !== draft.maxCalls) patch({ maxCalls: parsed.value });
    const saved = await save();
    if (saved !== null) leaveAfterWrite();
  };

  /**
   写完之后离开这一页。

   为什么不能直接 `router.back()`：这一页**可以被深链直达**（也能在状态恢复后成为栈底），
   那时栈里没有上一页，`back()` 会抛出 `The action 'GO_BACK' was not handled by any navigator`
   ——保存明明成功了，用户却看到一个红色报错浮层（本轮的验收脚本就这么抓到它的）。
   所以：有上一页就回去，没有就**回定时列表**（用户本来要去的地方）。
   */
  const leaveAfterWrite = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/?view=schedule');
  }, [router]);

  const onDelete = () => {
    if (scheduleId === null || state.client === null || currentBot === null) return;
    // 正在跑的那次删除后**不会**被取消（服务端用 `context.WithoutCancel`，见
    // docs/research/schedule-server-behaviour.md），而它的日志会随任务 CASCADE 删掉，
    // 所以这一句必须说——否则用户会以为删除等于取消。
    const body = running
      ? `${t('schedule.delete.body')}\n\n${t('schedule.delete.running')}`
      : t('schedule.delete.body');
    Alert.alert(t('schedule.delete.title'), body, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('schedule.delete.confirm'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await state.client?.deleteSchedule(currentBot.id, scheduleId);
              leaveAfterWrite();
            } catch (err) {
              setValidationError(err instanceof Error ? err.message : String(err));
            }
          })();
        },
      },
    ]);
  };

  const header = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: GROUP_INSET,
        marginBottom: spacing.md,
      }}
    >
      <BackButton testID="schedule-edit-back" fallback="/?view=schedule" />
      <Text style={[typography.title2, { color: palette.label, flex: 1 }]}>
        {scheduleId === null ? t('schedule.edit.new') : t('schedule.edit.existing')}
      </Text>
    </View>
  );

  if (currentBot === null) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: palette.groupedBackground,
          paddingTop: insets.top + spacing.sm,
        }}
      >
        {header}
        {state.botsError === null ? (
          <ActivityIndicator color={palette.secondaryLabel} />
        ) : (
          <View style={{ paddingHorizontal: GROUP_INSET }}>
            <ErrorNotice
              testID="schedule-bot-error"
              title={t('bots.loadFailed')}
              reason={t(reasonKeyOf(state.botsError))}
              action={{ label: t('common.retry'), onPress: () => void refreshBots() }}
            />
          </View>
        )}
      </View>
    );
  }

  if (!allowed) {
    return (
      <View
        testID="schedule-permission"
        style={{
          flex: 1,
          backgroundColor: palette.groupedBackground,
          paddingTop: insets.top + spacing.sm,
        }}
      >
        {header}
        <View style={{ paddingHorizontal: GROUP_INSET, paddingTop: spacing.lg }}>
          <Text style={[type.headline, { color: palette.label, marginBottom: spacing.xs }]}>
            {t('schedule.permission.title')}
          </Text>
          <Text style={[type.body, { color: palette.secondaryLabel }]}>
            {t('schedule.permission.body')}
          </Text>
        </View>
      </View>
    );
  }

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: palette.groupedBackground,
          paddingTop: insets.top + spacing.sm,
        }}
      >
        {header}
        <ActivityIndicator color={palette.secondaryLabel} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, backgroundColor: palette.groupedBackground }}
        // 同 BotCreateScreen：push 屏自己画标题，就得自己让开安全区。
        contentContainerStyle={{
          paddingTop: insets.top + spacing.sm,
          paddingBottom: insets.bottom + spacing.xxl,
        }}
        keyboardShouldPersistTaps="handled"
        // 滚动位置要自己记：`scrollTo` 收的是绝对偏移，而"把这一栏顶到键盘上面"
        // 需要"当前偏移 + 还差多少"（见 `bringFocusedInputIntoView`）。
        onScroll={(event) => {
          contentOffset.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
      >
        {/* push 进来的页，原生导航栏的返回箭头不存在（`headerShown: false`），
            所以标题行左侧要有一个可见的 `‹`（否则只有知道边缘侧滑手势的人能退出去）。 */}
        {header}

        <Group header={t('schedule.group.basics')}>
          <Field
            testID="schedule-field-name"
            title={t('schedule.field.name')}
            value={draft.name}
            onChangeText={(name) => patch({ name })}
            inputRef={(node) => {
              inputs.current.name = node;
            }}
            // Return 键走到下一栏：换框不该依赖"手指落在哪一帧的坐标上"。
            returnKeyType="next"
            onSubmitEditing={() => focusField('description')}
            onFocus={onFieldFocus}
          />
          <Field
            testID="schedule-field-description"
            title={t('schedule.field.description')}
            value={draft.description}
            onChangeText={(description) => patch({ description })}
            last
            inputRef={(node) => {
              inputs.current.description = node;
            }}
            returnKeyType="next"
            onSubmitEditing={() => focusField('command')}
            onFocus={onFieldFocus}
          />
        </Group>

        {/*
        "要它做什么"是**唯一必填且唯一多行**的那一栏，所以它排在基本信息之后、
        频率之前：首屏可见（进焦点时也必然在键盘上面），而且先把"要 agent 做什么"
        说清楚，再决定多久跑一次。

        整块可点（`Pressable` 包住输入框）：这一栏高 88pt，用户的手指（和验收脚本）
        落在框边一两 pt 上是常事；点击落在块里就聚焦到这一框，"点空"不会静默变成
        "字进上一栏"。里面那个 TextInput 仍然自己接光标定位与选中。
        */}
        <Group header={t('schedule.group.command')} footer={t('schedule.command.footer')}>
          <Pressable
            testID="schedule-command-block"
            /*
              ⚠️ `accessible={false}` 是**必须**的，不是为了好看：`Pressable` 默认在 iOS 上
              是一个无障碍元素，会把里面的 `TextInput` **整个从树上折掉**——实测（本轮）
              折掉之后 `schedule-field-command` 这个 id 直接从视图树里消失，按 id 的验收
              与读屏用户都再也够不到那一栏。这里要的只是"点在块里 = 聚焦到这一框"，
              所以块本身不进树，里面的输入框照旧是树上的元素。
            */
            accessible={false}
            onPress={() => focusField('command')}
            style={{ paddingHorizontal: GROUP_INSET, paddingVertical: spacing.md }}
          >
            <TextInput
              ref={(node) => {
                inputs.current.command = node;
              }}
              testID="schedule-field-command"
              value={draft.command}
              onChangeText={(command) => patch({ command })}
              onFocus={() => onFieldFocus(inputs.current.command)}
              multiline
              placeholder={t('schedule.command.placeholder')}
              placeholderTextColor={palette.tertiaryLabel}
              style={[
                type.body,
                {
                  color: palette.label,
                  backgroundColor: palette.field,
                  borderRadius: radius.sm,
                  padding: spacing.md,
                  minHeight: 88,
                  textAlignVertical: 'top',
                },
              ]}
            />
          </Pressable>
        </Group>

        {/*
        频率 = **可视化选择器**（设计基线 §7.6 的裁决：手机端要给 cron 选择器，不是"只读 + 启停"；
        逻辑层 7 模式 + 无损往返早就在 `features/schedule/cron.ts`，缺的只是这一层界面）。

        它替掉了原来那四行预设：预设能表达的只是选择器的子集，而选择器还会**把当前设置显示出来**
        （预设只负责"点一下写进去"，看不出现在是什么）。每个预设依然在 ≤3 次点击内到达。

        手写那一行**保留**：它现在的作用和选择器里的"手写"模式一样——别人给的表达式、或者
        选择器还没覆盖的写法（带步长与范围的那些），都需要一个能直接改的地方。
        两处都是同一份草稿，改哪边都算。
      */}
        <Group
          header={t('schedule.group.frequency')}
          footer={`${nextPreview}\n${t(line.key, line.values)}`}
        >
          <Row
            testID="schedule-open-cron"
            title={t('cron.title')}
            value={draft.pattern}
            disclosure
            onPress={() => {
              void (async () => {
                const outcome = await present(CronPickerSheet, { pattern: draft.pattern });
                if (outcome.status !== 'completed') return;
                patch({ pattern: outcome.value.pattern });
              })();
            }}
          />
          <Field
            testID="schedule-field-pattern"
            title={t('schedule.field.pattern')}
            value={draft.pattern}
            onChangeText={(pattern) => patch({ pattern })}
            autoCapitalize="none"
            last
            inputRef={(node) => {
              inputs.current.pattern = node;
            }}
            onFocus={onFieldFocus}
          />
        </Group>

        <Group header={t('schedule.group.state')}>
          <Row
            testID="schedule-field-enabled"
            title={t('schedule.field.enabled')}
            last={false}
            accessory={
              <Switch
                testID="schedule-switch-enabled"
                // 开关是独立的读屏元素，标题在旁边的 <Text> 里：不补 label 只会念
                // "开关, 已打开"，说不出在开关哪一项。
                accessibilityLabel={t('schedule.field.enabled')}
                value={draft.enabled}
                onValueChange={(enabled) => patch({ enabled })}
              />
            }
          />
          <Field
            testID="schedule-field-max-calls"
            title={t('schedule.field.maxCalls')}
            value={maxCallsReady ? maxCallsText : ''}
            onChangeText={setMaxCallsText}
            placeholder={t('schedule.maxCalls.unlimited')}
            keyboardType="number-pad"
            last
            inputRef={(node) => {
              inputs.current.maxCalls = node;
            }}
            onFocus={onFieldFocus}
          />
        </Group>

        {/* 运行位置：这一轮只读。切换目标（复用某个已有会话）需要会话选择器，
          没有它的话选 existing_session 会写出一个服务端必然拒绝的请求（缺 target_session_id），
          所以宁可不给，也不给一个点了会失败的控件。 */}
        <Group header={t('schedule.group.execution')} footer={t('schedule.execution.footer')}>
          {/*
          运行位置：**先选位置，再（只在复用时）选会话**。
          上一轮它是只读的，理由写在这里——"改成复用同一会话需要会话选择器，没有它就会写出
          缺 target_session_id 的必然被拒请求"。选择器补上了（`RunTargetPickerSheet`），
          约束统一由 `checkRunTarget` 把着，所以这一行现在可以点。
        */}
          <Row
            testID="schedule-field-run-target"
            title={t('schedule.field.runTarget')}
            value={
              draft.execution.runTarget === 'existing_session'
                ? selectedSessionLabel(draft.execution.targetSessionId, state.sessions)
                : t('schedule.runTarget.newSession')
            }
            disclosure
            last
            onPress={() => {
              void (async () => {
                const outcome = await present(RunTargetPickerSheet, {
                  runTarget: draft.execution.runTarget,
                  targetSessionId: draft.execution.targetSessionId,
                });
                if (outcome.status !== 'completed') return;
                patch({
                  execution: {
                    ...draft.execution,
                    runTarget: outcome.value.runTarget,
                    targetSessionId: outcome.value.targetSessionId,
                  },
                });
              })();
            }}
          />
        </Group>

        {/*
          两类失败共用这一块，但**说法不同**：

          - `validationError`：我们在发请求之前就看出来的问题（名字空了、cron 不合法）。
            它不是"故障"，是"还差一步"，所以标题就说"还不能保存"、那一句**直接说怎么改**（HIG Writing：
            给正例、别说教）。**不给按钮**：要补的是上面那个字段。
            **别拿 `schedule.error.title`**：那是列表页拉取失败的标题（"拉取定时任务失败"），
            校验失败不是拉取失败——两件事共用一句话，用户会去查网络。
          - `error`：请求真的失败了。原因是服务端给的（有类型化错误码才带原文），
            动作就是屏幕上那个 Save——再挂一个"重试"是把同一个动作说两遍。
        */}
        {validationError === null && error === null ? null : (
          <View style={{ paddingHorizontal: GROUP_INSET, marginBottom: spacing.md }}>
            <ErrorNotice
              testID="schedule-edit-error"
              title={
                validationError === null
                  ? t('schedule.save.failed')
                  : t('schedule.validation.title')
              }
              reason={validationError ?? (error === null ? '' : t(reasonKeyOf(error)))}
            />
          </View>
        )}

        <Pressable
          testID="schedule-save"
          accessibilityRole="button"
          disabled={saving}
          onPress={() => void onSave()}
          style={({ pressed }) => ({
            marginHorizontal: GROUP_INSET,
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? palette.field : palette.card,
            borderRadius: radius.md,
            opacity: saving ? 0.6 : 1,
          })}
        >
          <Text style={[type.body, { color: palette.accent }]}>
            {saving ? t('schedule.saving') : t('schedule.save')}
          </Text>
        </Pressable>

        {scheduleId === null ? null : (
          <Pressable
            testID="schedule-delete"
            accessibilityRole="button"
            onPress={onDelete}
            style={{ marginTop: spacing.lg, minHeight: MIN_TOUCH_TARGET, justifyContent: 'center' }}
          >
            <Text
              style={[
                type.body,
                { color: palette.destructive, textAlign: 'center', paddingHorizontal: GROUP_INSET },
              ]}
            >
              {t('schedule.delete.action')}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** 表单里的文本框（校验失败时"该把用户送到哪一栏"用的就是这个封闭集合）。 */
type TextField = 'name' | 'description' | 'command' | 'pattern' | 'maxCalls';

interface FieldProps {
  testID: string;
  title: string;
  value: string;
  onChangeText: (next: string) => void;
  last?: boolean;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad';
  autoCapitalize?: 'none' | 'sentences';
  /** 句柄交给屏幕：校验失败时要能聚焦到具体那一栏。 */
  inputRef?: (node: TextInput | null) => void;
  /** Return 键走到下一栏（`next`）。不给就是系统默认。 */
  returnKeyType?: 'next' | 'default';
  onSubmitEditing?: () => void;
  onFocus?: (node: TextInput | null) => void;
}

/** 行内输入行：左边标题，右边输入。iOS 设置里新增/编辑表单就是这个形状。 */
function Field({
  testID,
  title,
  value,
  onChangeText,
  last = false,
  placeholder,
  keyboardType = 'default',
  autoCapitalize = 'sentences',
  inputRef,
  returnKeyType = 'default',
  onSubmitEditing,
  onFocus,
}: FieldProps) {
  const palette = usePalette();
  const { typography: type } = useTheme();
  /** 这一行自己的句柄：既给屏幕（校验失败要聚焦），也给 `onFocus` 用。 */
  const own = useRef<TextInput | null>(null);
  return (
    <Row
      testID={testID}
      title={title}
      last={last}
      accessory={
        <TextInput
          ref={(node) => {
            own.current = node;
            inputRef?.(node);
          }}
          testID={`${testID}-input`}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={palette.tertiaryLabel}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          onFocus={() => onFocus?.(own.current)}
          style={[
            type.body,
            { color: palette.label, minWidth: 140, textAlign: 'right', paddingVertical: 2 },
          ]}
        />
      }
    />
  );
}

/** 日期词：封闭集合用字典映射（AGENTS.md 禁止链式三元）。 */
const DAY_KEY: Record<'today' | 'tomorrow' | 'dayAfter', string> = {
  today: 'schedule.day.today',
  tomorrow: 'schedule.day.tomorrow',
  dayAfter: 'schedule.day.dayAfter',
};

function dayLabel(
  label: {
    kind: 'at';
    day: 'today' | 'tomorrow' | 'dayAfter' | 'date';
    time: string;
    date: string;
  },
  t: (key: string) => string,
): string {
  if (label.day === 'date') return label.date;
  return t(DAY_KEY[label.day]);
}
