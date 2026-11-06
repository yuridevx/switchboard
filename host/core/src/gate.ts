// Правила набора на старте Host и склейка вкладов модулей в query(): у имени один владелец.
import { nameOf, ownerOf } from "@switchboard/manifest-gate";
import type { Manifest, Module, QueryPart } from "../contract.ts";

/** Поля записи сессии, которые держит ядро. */
const CORE_FIELDS = new Set(["callsign", "state", "failed", "sdk", "dir", "by"]);
/** Методы query, которыми ядро ведёт процесс: close завершает его, ввод — очередь ядра, серверы MCP — вклады. */
const CORE_CALLS = new Set(["close", "streamInput", "setMcpServers", "reinitialize"]);
/** Функции SDK о разговоре: id сессии и папку подставляет ядро. */
export const SESSION_FNS = new Set(["getSessionInfo", "getSessionMessages", "renameSession", "tagSession", "forkSession", "deleteSession", "listSubagents", "getSubagentMessages"]);
/** Что модуль может звать у query: публичные типы и исключения устава. */
const CALLS = new Set([
  ...["interrupt", "setPermissionMode", "setMcpPermissionModeOverride", "setModel", "setMaxThinkingTokens", "applyFlagSettings", "updateSettings", "initializationResult"],
  ...["supportedCommands", "supportedModels", "supportedAgents", "mcpServerStatus", "getContextUsage", "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET", "readFile"],
  ...["reloadPlugins", "reloadSkills", "reloadOutputStyles", "accountInfo", "rewindFiles", "seedReadState", "reconnectMcpServer", "toggleMcpServer", "readMcpResource", "stopTask", "backgroundTasks"],
  ...["enableRemoteControl", "claudeAuthenticate", "claudeOAuthCallback", "claudeOAuthWaitForCompletion"],
  ...["askSideQuestion", "getTaskOutput", "cancelAsyncMessage", "mcpAuthenticate", "getStatus", "getHooksListing", "listPermissionRules"],
]);
/** Опции query(), которые держит ядро: процесс, разговор, решения. */
const CORE_OPTIONS = new Set([
  ...["prompt", "cwd", "resume", "sessionId", "forkSession", "continue", "allowDangerouslySkipPermissions", "spawnClaudeCodeProcess", "canUseTool", "onElicitation", "systemPrompt"],
  ...["abortController", "pathToClaudeCodeExecutable", "executable", "persistSession", "sessionStore"],
]);

type Entry = { manifest: Manifest };

/** Ошибки набора: Host не стартует. */
export function setProblems(core: Manifest, entries: Entry[], workers: Record<string, string>): string[] {
  const here = new Set([core.name, ...entries.map((e) => e.manifest.name)]);
  const owners = new Map<string, string>();
  const out: string[] = [];
  if (!workers.relay) {
    for (const { manifest: m } of entries) for (const ref of Object.keys(m.uses)) if (!here.has(ownerOf(ref))) out.push(`${m.name}: ${ref} — нет relay в списке сборки`);
  }
  for (const { manifest: m } of entries) {
    for (const name of Object.keys(m.provides)) {
      const first = owners.get(name);
      if (first) out.push(`${name}: два владельца — ${first} и ${m.name}`);
      else owners.set(name, m.name);
    }
  }
  return out;
}

/** Ошибки устройства одного модуля: выключен он, остальные работают. */
export function moduleFlaws({ name, provides, calls = [] }: Manifest, mod: Module): string[] {
  const named = [
    ...Object.keys(mod.requests ?? {}).map((n) => [`requests.${n}`, n]),
    ...Object.keys(mod.frames ?? {}).map((n) => [`frames.${n}`, n]),
    ...Object.keys(mod.fields ?? {}).map((n) => [`fields.${n}`, n]),
    ...Object.keys(mod.decide ?? {}).map((n) => [`decide.${n}`, `decide.${n}`]),
    ...(mod.elicit ? [["elicit", "elicit"]] : []),
  ];
  return [
    ...named.filter(([, n]) => provides[n] === undefined).map(([what]) => `${name}: ${what} — нет в provides`),
    ...Object.keys(mod.fields ?? {}).filter((n) => CORE_FIELDS.has(n)).map((n) => `${name}: поле ${n} — имя ядра`),
    ...calls.filter((c) => CORE_CALLS.has(c)).map((c) => `${name}: calls ${c} — метод держит ядро`),
    ...calls.filter((c) => !CORE_CALLS.has(c) && !CALLS.has(c) && !SESSION_FNS.has(c)).map((c) => `${name}: calls ${c} — такого метода нет в SDK`),
  ];
}

export const usesName = (m: Manifest, name: string): string | undefined => Object.keys(m.uses).find((ref) => nameOf(ref) === name);

/** Опция ядра во вкладе модуля; вклад с ней не берётся. */
export const coreOption = (part: QueryPart): string | undefined => Object.keys(part).find((k) => CORE_OPTIONS.has(k));

export type Merged = { env: Record<string, string>; mcpServers: NonNullable<QueryPart["mcpServers"]>; settings: Record<string, unknown>; options: Record<string, unknown>; append: string[] };

/** Вклады по порядку списка; второй владелец ключа — причина. Хуки ядро оборачивает само. */
export function mergeParts(parts: Array<[string, QueryPart]>): { merged: Merged; conflicts: string[] } {
  const merged: Merged = { env: {}, mcpServers: {}, settings: {}, options: {}, append: [] };
  const conflicts: string[] = [];
  const holders = new Map<string, string>();
  const claim = (word: string, target: Record<string, unknown>, from: Record<string, unknown> | undefined, who: string) => {
    for (const [k, v] of Object.entries(from ?? {})) {
      const first = holders.get(`${word} ${k}`);
      if (first) conflicts.push(`${word} ${k}: два владельца — ${first} и ${who}`);
      holders.set(`${word} ${k}`, who);
      target[k] = v;
    }
  };
  for (const [who, { env, mcpServers, settings, append, hooks: _hooks, ...options }] of parts) {
    claim("env", merged.env, env, who);
    claim("MCP-сервер", merged.mcpServers, mcpServers, who);
    claim("settings", merged.settings, settings, who);
    claim("опция", merged.options, options, who);
    if (append) merged.append.push(append);
  }
  return { merged, conflicts };
}
