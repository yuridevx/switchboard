// Вклады модулей в query() сессии: собрать у владельцев и сложить в опции. У сервера MCP, ключа env, ключа settings и опции один владелец.
import type { HookCallbackMatcher, Options } from "@anthropic-ai/claude-agent-sdk";
import type { QueryPart, Session } from "../contract.ts";
import { isRefusal } from "./refusal.ts";
import type { Mod, Scope, Trap } from "./trap.ts";
import { START_MS } from "./trap.ts";

/** Опции query(), которые держит ядро: модулю их не взять. */
const CORE_OPTIONS = new Set([
  "prompt", "cwd", "resume", "sessionId", "forkSession", "continue", "allowDangerouslySkipPermissions",
  "spawnClaudeCodeProcess", "canUseTool", "onElicitation", "systemPrompt", "abortController", "pathToClaudeCodeExecutable",
  "executable", "persistSession", "sessionStore",
]);
/** Ключи вклада, которые не опции query(). */
const SHAPED = new Set(["mcpServers", "env", "append", "settings", "hooks"]);

export type Parts = Map<Mod, QueryPart>;

/** Вклады модулей. Два владельца имени — исключение: Host не стартует или сессия не открывается. */
export async function collectParts(trap: Trap, scope: Scope, view: (m: Mod) => Session): Promise<Parts> {
  const parts: Parts = new Map();
  const owners = new Map<string, string>();
  const claim = (label: string, who: string) => {
    const owner = owners.get(label);
    if (owner && owner !== who) throw new Error(`${label}: два владельца — ${owner} и ${who}`);
    owners.set(label, who);
  };
  for (const m of trap.mods) {
    if (!m.module.session || trap.isDown(m, scope)) continue;
    let p: QueryPart | undefined;
    try {
      p = (await trap.call(m, "session", scope, (x) => trap.within(x.session!(view(m)), `session() не вернулся за ${START_MS / 1000} с`), () => undefined)) as QueryPart | undefined;
    } catch (e) {
      // отказывает только opening: запуск сохранённой сессии остановить нельзя, иначе одна сессия держала бы старт Host на всей машине
      if (!isRefusal(e)) throw e;
      trap.disable(m, scope, "session", new Error(`отказ ${e.word} в session(): ${e.why ?? ""}`));
      continue;
    }
    if (!p) continue;
    const taken = Object.keys(p).find((key) => CORE_OPTIONS.has(key));
    if (taken) {
      trap.disable(m, scope, "session", new Error(`опция ${taken} — её держит ядро`));
      continue;
    }
    for (const n of Object.keys(p.mcpServers ?? {})) claim(`MCP-сервер ${n}`, m.name);
    for (const n of Object.keys(p.env ?? {})) claim(`env ${n}`, m.name);
    for (const n of Object.keys(p.settings ?? {})) claim(`settings ${n}`, m.name);
    for (const n of Object.keys(p)) if (!SHAPED.has(n) && p[n] !== undefined) claim(`опция ${n}`, m.name);
    parts.set(m, p);
  }
  return parts;
}

/** Сложить вклады: то, что идёт в query() от модулей. Хук модуля SDK видит через ловушку ядра. */
export function mergeParts(trap: Trap, scope: Scope, parts: Parts): Partial<Options> & { env: Record<string, string> } {
  const mcpServers: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const settings: Record<string, unknown> = {};
  const appends: string[] = [];
  const hooks: Record<string, HookCallbackMatcher[]> = {};
  const rest: Record<string, unknown> = {};
  for (const [m, p] of parts) {
    Object.assign(mcpServers, p.mcpServers ?? {});
    Object.assign(env, p.env ?? {});
    Object.assign(settings, p.settings ?? {});
    if (p.append) appends.push(p.append);
    for (const [event, list] of Object.entries(p.hooks ?? {})) {
      for (const matcher of list ?? []) {
        (hooks[event] ??= []).push({
          ...(matcher.matcher !== undefined ? { matcher: matcher.matcher } : {}),
          ...(matcher.timeout !== undefined ? { timeout: matcher.timeout } : {}),
          hooks: matcher.hooks.map((body) => (input, toolUseID, o) => Promise.resolve(trap.call(m, `hooks.${event}`, scope, () => body(input, toolUseID, o), () => ({})))),
        });
      }
    }
    for (const [key, v] of Object.entries(p)) if (!SHAPED.has(key) && v !== undefined) rest[key] = v;
  }
  return {
    ...rest,
    env,
    systemPrompt: { type: "preset", preset: "claude_code", ...(appends.length ? { append: appends.join("\n\n") } : {}) },
    mcpServers: mcpServers as Options["mcpServers"],
    hooks,
    ...(Object.keys(settings).length ? { settings: settings as Options["settings"] } : {}),
  };
}
