/**
 * 归约器的再导出。
 *
 * store 要用的几个函数在 `features/chat/reducer.ts`；这里单独开一个转发文件是为了
 * 让导入路径稳定——store 只依赖这一个入口，reducer 内部怎么重组都不影响它。
 */
export {
  appendOptimisticUserMessage,
  applyDelta,
  applyHistory,
  applySnapshot,
  clearApproval,
  clearUserInput,
  decisionForFallback,
  dropOptimistic,
  initialChatState,
  isFallbackOption,
  isRunActive,
  isRunAbandoned,
  markStale,
  olderHistoryFailed,
  prependHistory,
  rejectPendingSend,
  resetLive,
  settleAbandonedRun,
  turnsForDisplay,
  type ChatState,
} from '../chat/reducer.ts';
