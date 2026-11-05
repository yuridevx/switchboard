// Что модуль может звать через s.sdk и p.sdk (манифест, calls). Таблица закреплена вместе с версией SDK: при обновлении — живая проверка.

/** Методы query(), которые держит ядро: процесс, ввод и серверы MCP. */
export const CORE_ONLY = new Set(["close", "streamInput", "setMcpServers", "reinitialize", "initializationResult"]);

/** Методы query() для модулей: публичные и исключения устава (вход аккаунта, Remote Control, методы вне публичных типов). */
export const QUERY_METHODS = new Set([
  "interrupt", "setPermissionMode", "setMcpPermissionModeOverride", "setModel", "setMaxThinkingTokens", "applyFlagSettings", "updateSettings",
  "supportedCommands", "supportedModels", "supportedAgents", "mcpServerStatus", "getContextUsage", "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
  "readFile", "reloadPlugins", "reloadSkills", "reloadOutputStyles", "accountInfo", "rewindFiles", "seedReadState", "reconnectMcpServer", "toggleMcpServer",
  "readMcpResource", "stopTask", "backgroundTasks",
  "listPermissionRules", "renameSession", "enableRemoteControl", "claudeAuthenticate", "claudeOAuthCallback", "claudeOAuthWaitForCompletion",
  "askSideQuestion", "getTaskOutput", "cancelAsyncMessage", "mcpAuthenticate", "getStatus", "getHooksListing",
]);

/** Функции SDK о разговоре: имя → сколько аргументов идёт между id сессии и опциями. */
export const SESSION_FUNCTIONS: Record<string, number> = { getSessionInfo: 0, getSessionMessages: 0, listSubagents: 0, forkSession: 0, deleteSession: 0, renameSession: 1, tagSession: 1, getSubagentMessages: 1 };
