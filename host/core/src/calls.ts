// Методы SDK 0.3.311, которые модуль может объявить в calls манифеста.

/** Методы query(): по типам SDK 0.3.311 и исключение устава — вход аккаунта и Remote Control (есть в коде SDK). */
export const QUERY_METHODS = new Set([
  "interrupt",
  "setPermissionMode",
  "setMcpPermissionModeOverride",
  "setModel",
  "setMaxThinkingTokens",
  "applyFlagSettings",
  "updateSettings",
  "initializationResult",
  "supportedCommands",
  "supportedModels",
  "supportedAgents",
  "mcpServerStatus",
  "getContextUsage",
  "readFile",
  "reloadPlugins",
  "reloadSkills",
  "reloadOutputStyles",
  "accountInfo",
  "rewindFiles",
  "seedReadState",
  "reconnectMcpServer",
  "toggleMcpServer",
  "readMcpResource",
  "stopTask",
  "backgroundTasks",
  "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
  // в типах SDK их нет, есть во время исполнения закреплённой версии; ими работал claude-fleet — Switchboard заменяет все его функции
  // (слово пользователя 31 окт.): вопрос сбоку, вывод задачи, снятие из очереди, вход MCP, /status, хуки. Другая версия SDK без метода — отказ словом.
  "askSideQuestion",
  "getTaskOutput",
  "cancelAsyncMessage",
  "mcpAuthenticate",
  "getStatus",
  "getHooksListing",
  // исключение устава: в типах SDK их нет
  "enableRemoteControl",
  "claudeAuthenticate",
  "claudeOAuthCallback",
  "claudeOAuthWaitForCompletion",
]);

/** Методы query(), которые держит ядро: close завершает процесс, ввод — очередь ядра, серверы MCP меняет ядро. */
export const CORE_ONLY = new Set(["close", "streamInput", "setMcpServers", "reinitialize"]);

/**
 * Функции SDK сессии: ядро подставляет первым аргументом session_id, а в аргумент опций — dir папки сессии.
 * Число — индекс аргумента опций в вызове функции SDK.
 */
export const SESSION_FUNCTIONS: Record<string, number> = {
  getSessionMessages: 1,
  getSessionInfo: 1,
  renameSession: 2,
  tagSession: 2,
  forkSession: 1,
  deleteSession: 1,
  getSubagentMessages: 2,
  listSubagents: 1,
};

export const isCallable = (name: string) => QUERY_METHODS.has(name) || name in SESSION_FUNCTIONS;
