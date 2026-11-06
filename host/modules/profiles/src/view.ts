// Просмотр профиля: что получит сессия с этим списком. Считается из той же сборки, что запуск; страница правил слияния не знает. Текстов файлов в ответе нет: их читает profile.file.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Assembly, Piece, TreeNode, Won } from "./pieces.ts";

/** Предел текста одного файла в ответе: у памяти кусочка сотни файлов, но каждый небольшой. */
export const FILE_MAX = 256 * 1024;
const HEAD = 200;

type Meta = Record<string, string>;
export type FileRow = { path: string; size: number; meta?: Meta; head?: string };
export type MemoryView = { from: string; files: number; bytes: number; indexLines: number; indexBytes: number; types: Record<string, number> };
export type ProfileView = {
  pieces: string[];
  tree: TreeNode[];
  settings: Record<string, Won>;
  instructions: Array<{ from: string; path: string; head: string; rule: boolean; paths?: string }>;
  skills: Array<{ from: string; name: string; description: string; path: string; extra: string[] }>;
  agents: Array<{ from: string; name: string; description: string; path: string; model?: string; effort?: string; main: boolean }>;
  memory: { home?: MemoryView; near: MemoryView[] };
  prompt: { agent?: { name: string; from: string; path?: string }; style?: { name: string; from: string; found: boolean; path?: string } };
  mcp: Array<{ from: string; kind: "server" | "hook"; name: string; detail: string; config: unknown }>;
  other: Array<{ from: string; path: string }>;
  files: Record<string, FileRow[]>;
};

/** Что Claude подключает из кусочка. Стиль сюда не входит: он свой, только когда выбран. */
const CLAUDE_PATHS = /^(CLAUDE\.md|\.claude\/rules\/.+\.md|\.claude-plugin\/plugin\.json|skills\/[^/]+\/.+|agents\/[^/]+\.md|memory\/.+|settings\.json|\.mcp\.json|hooks\/hooks\.json)$/;

function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".git") return [];
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, r) : [r];
  });
}

/** Заголовок markdown: простые поля, вложенные тоже; значение без кавычек. И первая строка тела. */
function front(text: string): { meta?: Meta; head?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta: Meta = {};
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const kv = /^\s*([\w-]+):\s*(.*)$/.exec(line);
    if (kv && kv[2] !== "") meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  const head = (m?.[2] ?? text).split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("---"));
  return { ...(m ? { meta } : {}), ...(head ? { head: head.replace(/^#+\s*/, "").slice(0, HEAD) } : {}) };
}

function rowsOf(dir: string): FileRow[] {
  return walk(dir).map((path) => {
    const full = join(dir, path);
    const size = statSync(full).size;
    if (!path.endsWith(".md") || size > FILE_MAX) return { path, size };
    const { meta, head } = front(readFileSync(full, "utf8"));
    // у памяти сотни файлов: только заголовок, тело — по нажатию
    return { path, size, ...(meta ? { meta } : {}), ...(head && !path.startsWith("memory/") ? { head } : {}) };
  });
}

function parsed(dir: string, file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function servers(p: Piece): ProfileView["mcp"] {
  return Object.entries((parsed(p.dir, ".mcp.json").mcpServers ?? {}) as Record<string, { command?: string; url?: string }>).map(([name, config]) => ({ from: p.id, kind: "server", name, detail: config.command ?? config.url ?? "", config }));
}

function hooks(p: Piece): ProfileView["mcp"] {
  const all = (parsed(p.dir, join("hooks", "hooks.json")).hooks ?? {}) as Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
  return Object.entries(all).flatMap(([name, list]) => list.map((m) => ({ from: p.id, kind: "hook" as const, name, detail: `${m.matcher ?? "*"} → ${m.hooks?.[0]?.command ?? ""}`, config: m })));
}

function memoryOf(p: Piece, rows: FileRow[]): MemoryView {
  const mem = rows.filter((f) => f.path.startsWith("memory/"));
  const index = mem.find((f) => f.path === "memory/MEMORY.md");
  const types: Record<string, number> = {};
  for (const f of mem) {
    if (f === index || !f.path.endsWith(".md")) continue;
    const type = f.meta?.type ?? "";
    types[type] = (types[type] ?? 0) + 1;
  }
  const text = index ? readFileSync(join(p.dir, index.path), "utf8").trim() : "";
  return { from: p.id, files: mem.length, bytes: mem.reduce((n, f) => n + f.size, 0), indexLines: text ? text.split(/\r?\n/).length : 0, indexBytes: index?.size ?? 0, types };
}

/** Стиль выбран полным именем «кусочек:стиль»: короткое имя Claude не находит. */
function styleOf(name: string, won: Won, a: Assembly): NonNullable<ProfileView["prompt"]["style"]> {
  const [owner, style] = name.includes(":") ? name.split(":") : [null, name];
  const path = `output-styles/${style}.md`;
  const has = (p: Piece) => existsSync(join(p.dir, path));
  const piece = owner ? a.pieces.find((p) => p.name === owner && has(p)) : a.pieces.find(has);
  return { name, from: piece?.id ?? won.from, found: !!owner && !!piece, ...(piece ? { path } : {}) };
}

export function viewOf(a: Assembly): ProfileView {
  const files = Object.fromEntries(a.pieces.map((p) => [p.id, rowsOf(p.dir)]));
  const out: Pick<ProfileView, "instructions" | "skills" | "agents"> = { instructions: [], skills: [], agents: [] };
  for (const p of a.pieces) {
    for (const f of files[p.id]) {
      if (/^(CLAUDE\.md|\.claude\/rules\/.+\.md)$/.test(f.path)) out.instructions.push({ from: p.id, path: f.path, head: f.head ?? "", rule: f.path !== "CLAUDE.md", ...(f.meta?.paths ? { paths: f.meta.paths } : {}) });
      const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(f.path);
      if (skill) out.skills.push({ from: p.id, name: `${p.name}:${f.meta?.name ?? skill[1]}`, description: f.meta?.description ?? "", path: f.path, extra: files[p.id].map((x) => x.path).filter((x) => x.startsWith(`skills/${skill[1]}/`) && x !== f.path) });
      const agent = /^agents\/([^/]+)\.md$/.exec(f.path);
      if (agent) out.agents.push({ from: p.id, name: `${p.name}:${f.meta?.name ?? agent[1]}`, description: f.meta?.description ?? "", path: f.path, ...(f.meta?.model ? { model: f.meta.model } : {}), ...(f.meta?.effort ? { effort: f.meta.effort } : {}), main: false });
    }
  }
  const agentWon = a.settings.agent;
  const main = agentWon && out.agents.find((x) => x.name === agentWon.value);
  if (main) main.main = true;
  const styleWon = a.settings.outputStyle;
  const style = styleWon ? styleOf(String(styleWon.value), styleWon, a) : undefined;
  const env = Object.fromEntries(Object.entries(a.env).map(([k, w]) => [`env.${k}`, w]));
  return {
    pieces: a.pieces.map((p) => p.id),
    tree: a.tree,
    settings: { ...a.settings, ...env },
    ...out,
    memory: { ...(a.home ? { home: memoryOf(a.home, files[a.home.id]) } : {}), near: a.near.map((p) => memoryOf(p, files[p.id])) },
    prompt: { ...(agentWon ? { agent: { name: String(agentWon.value), from: main?.from ?? agentWon.from, ...(main ? { path: main.path } : {}) } } : {}), ...(style ? { style } : {}) },
    mcp: a.pieces.flatMap((p) => [...servers(p), ...hooks(p)]),
    other: a.pieces.flatMap((p) => files[p.id].filter((f) => !CLAUDE_PATHS.test(f.path) && !(p.id === style?.from && f.path === style.path)).map((f) => ({ from: p.id, path: f.path }))),
    files,
  };
}

/** Файл внутри папки кусочка; выход из неё, в том числе ссылкой, — null. */
export function insideFile(dir: string, path: string): string | null {
  const full = resolve(dir, path);
  if (!full.startsWith(resolve(dir) + sep) || !existsSync(full)) return null;
  const real = realpathSync(full);
  return real.startsWith(realpathSync(dir) + sep) && statSync(real).isFile() ? real : null;
}
