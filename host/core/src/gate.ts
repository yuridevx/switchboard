// Правила набора на старте Host и склейка вкладов модулей в query(): у имени один владелец.
import { checkSet, nameOf, ownerOf } from "@switchboard/manifest-gate";
import type { Manifest, QueryPart } from "../contract.ts";
import type { ModuleEntry } from "./release.ts";

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

const names = (core: Manifest, entries: Entry[]) => new Set([core.name, ...entries.map((e) => e.manifest.name)]);

/** Правила набора — гейт монорепо; владелец вне набора (Worker, keeper) ему не виден. */
export function setProblems(core: Manifest, entries: Entry[]): string[] {
  return checkSet([core, ...entries.map((e) => e.manifest)]).map((why) => why.replace(/^имя /, ""));
}

/** Имена, которые идут только через relay: без него в сборке им неоткуда взяться. */
export function relayProblems(core: Manifest, entries: Entry[]): string[] {
  const here = names(core, entries);
  return entries.flatMap(({ manifest: m }) => Object.keys(m.uses).flatMap((ref) => (here.has(ownerOf(ref)) ? [] : [`${m.name}: ${ref} — нет relay в списке сборки`])));
}

/** Ошибки устройства одного модуля: выключен он, остальные работают. */
export function moduleFlaws({ manifest: { name, provides, calls = [] }, module: mod, failed }: ModuleEntry): string[] {
  if (failed) return [failed];
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

/** Гейт выпуска: всё, что не даст модулю или набору работать. */
export const releaseProblems = (core: Manifest, entries: ModuleEntry[]): string[] => [...entries.flatMap(moduleFlaws), ...setProblems(core, entries)];

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
