// Вклады модулей в query() одной сессии: у ключа один владелец, строки промпта и хуки складываются.
import type { QueryPart } from "../contract.ts";

/** Опции, которые держит ядро: процесс, разговор, решения. Модулю их не дать. */
export const CORE_OPTIONS = new Set(["prompt", "cwd", "resume", "sessionId", "forkSession", "continue", "allowDangerouslySkipPermissions", "spawnClaudeCodeProcess", "canUseTool", "onElicitation", "systemPrompt", "abortController", "pathToClaudeCodeExecutable", "executable", "persistSession", "sessionStore"]);

export type Merged = {
  env: Record<string, string>;
  settings: Record<string, unknown>;
  mcpServers: NonNullable<QueryPart["mcpServers"]>;
  hooks: NonNullable<QueryPart["hooks"]>;
  append: string[];
  options: Record<string, unknown>;
  /** ключи двух владельцев, словами */
  conflicts: string[];
};

export function mergeParts(parts: Array<{ owner: string; part: QueryPart }>): Merged {
  const out: Merged = { env: {}, settings: {}, mcpServers: {}, hooks: {}, append: [], options: {}, conflicts: [] };
  const owners = new Map<string, string>();
  const claim = (label: string, owner: string) => {
    const first = owners.get(label);
    if (first && first !== owner) out.conflicts.push(`${label}: два владельца — ${first} и ${owner}`);
    owners.set(label, first ?? owner);
  };
  for (const { owner, part } of parts) {
    const { env = {}, settings = {}, mcpServers = {}, hooks = {}, append, ...options } = part;
    for (const k of Object.keys(env)) claim(`env ${k}`, owner);
    for (const k of Object.keys(settings)) claim(`settings ${k}`, owner);
    for (const k of Object.keys(mcpServers)) claim(`MCP-сервер ${k}`, owner);
    for (const k of Object.keys(options)) claim(`опция ${k}`, owner);
    Object.assign(out.env, env);
    Object.assign(out.settings, settings);
    Object.assign(out.mcpServers, mcpServers);
    Object.assign(out.options, options);
    if (append) out.append.push(append);
    for (const [event, matchers] of Object.entries(hooks) as Array<[keyof Merged["hooks"], Merged["hooks"][keyof Merged["hooks"]]]>) (out.hooks[event] ??= []).push(...(matchers ?? []));
  }
  return out;
}
