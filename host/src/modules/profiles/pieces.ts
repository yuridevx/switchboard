// Кусочек — папка в родных форматах Claude; профиль сессии — их упорядоченный список. Здесь собирается то, что получит сессия: файлы читаются на каждом старте, копий нет.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** Манифест плагина: его name — имя кусочка в Claude, description — подпись, metadata.use — состав набора. */
const MANIFEST = join(".claude-plugin", "plugin.json");
const RULES = join(".claude", "rules");
/** Пределы индекса памяти у самого Claude. */
const INDEX_LINES = 200;
const INDEX_BYTES = 25_000;

/** Настройки и переменные, которые держит аккаунт и система: кусочек не платит и не выбирает, куда идти. */
const OWN_SETTINGS = new Set(["apiKeyHelper", "autoMemoryDirectory"]);
const OWN_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CONFIG_DIR$)/;

export type Piece = {
  id: string;
  dir: string;
  /** имя плагина: name манифеста или имя папки */
  name: string;
  about?: string;
  use?: string[];
  env: Record<string, string>;
  settings: Record<string, unknown>;
  /** есть memory/ */
  memory: boolean;
  /** есть CLAUDE.md или правила */
  instructions: boolean;
};

/** Значение настройки: кто выиграл и кто проиграл. */
export type Won = { value: unknown; from: string; lost: Array<{ value: unknown; from: string }> };

/** Узел развёртки: набор и его состав как выбраны; повтор — без состава, он виден у первого вхождения. */
export type TreeNode = { id: string; set: boolean; children?: TreeNode[] };

export type Assembly = {
  /** плоский список: наборы развёрнуты, порядок — порядок силы */
  pieces: Piece[];
  tree: TreeNode[];
  env: Record<string, Won>;
  settings: Record<string, Won>;
  /** домашняя память — нижняя; папка Claude у сессии одна */
  home?: Piece;
  near: Piece[];
};

/** Список не собрать: слово договора и причина. */
export class BadPieces extends Error {
  readonly word: "bad_profile" | "no_profile";
  constructor(word: "bad_profile" | "no_profile", why: string) {
    super(why);
    this.word = word;
  }
}
const bad = (why: string) => new BadPieces("bad_profile", why);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function json(id: string, file: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw bad(`${id}: ${basename(file)} не прочитан — ${(e as Error).message}`);
  }
  if (!isObject(value)) throw bad(`${id}: ${basename(file)} — не объект`);
  return value;
}

/** Манифест без name: Claude молча не загрузит плагин, поэтому отказ здесь. */
function manifest(id: string, dir: string): Pick<Piece, "name" | "about" | "use"> {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) return { name: basename(dir) };
  const m = json(id, file);
  if (typeof m.name !== "string" || !m.name) throw bad(`${id}: в манифесте плагина нет name`);
  const use = isObject(m.metadata) ? m.metadata.use : undefined;
  if (use !== undefined && !(Array.isArray(use) && use.every((u) => typeof u === "string"))) throw bad(`${id}: metadata.use — список кусочков`);
  return { name: m.name, ...(typeof m.description === "string" ? { about: m.description } : {}), ...(use ? { use: use as string[] } : {}) };
}

function ownSettings(id: string, dir: string): Pick<Piece, "env" | "settings"> {
  const file = join(dir, "settings.json");
  if (!existsSync(file)) return { env: {}, settings: {} };
  const { env = {}, ...settings } = json(id, file);
  if (!isObject(env) || !Object.values(env).every((v) => typeof v === "string")) throw bad(`${id}: env в settings.json — объект строк`);
  const foreignEnv = Object.keys(env).find((k) => OWN_ENV.test(k));
  if (foreignEnv) throw bad(`${id}: ${foreignEnv} — провайдер и вход живут в аккаунте`);
  const foreign = Object.keys(settings).find((k) => OWN_SETTINGS.has(k));
  if (foreign) throw bad(`${id}: ${foreign} — это держит система`);
  return { env: env as Record<string, string>, settings };
}

export function readPiece(id: string, dir: string): Piece {
  return {
    id,
    dir,
    ...manifest(id, dir),
    ...ownSettings(id, dir),
    memory: existsSync(join(dir, "memory")),
    instructions: existsSync(join(dir, "CLAUDE.md")) || existsSync(join(dir, RULES)),
  };
}

/** Набор разворачивается на месте, сам он — после своего состава; повтор — первое вхождение; кольцо — отказ. */
function flatten(list: string[], folderOf: (id: string) => string | null): { pieces: Piece[]; tree: TreeNode[] } {
  const out = new Map<string, Piece>();
  const walk = (id: string, path: string[]): TreeNode => {
    if (path.includes(id)) throw bad(`кольцо наборов: ${[...path, id].join(" → ")}`);
    const known = out.get(id);
    if (known) return { id, set: !!known.use };
    const dir = folderOf(id);
    if (!dir) throw new BadPieces("no_profile", `${id}: такой папки нет в клонах`);
    const piece = readPiece(id, dir);
    const children = (piece.use ?? []).map((u) => walk(u, [...path, id]));
    out.set(id, piece);
    return { id, set: !!piece.use, ...(piece.use ? { children } : {}) };
  };
  const tree = list.map((id) => walk(id, []));
  return { pieces: [...out.values()], tree };
}

function won(pieces: Piece[], of: (p: Piece) => Record<string, unknown>): Record<string, Won> {
  const out: Record<string, Won> = {};
  for (const p of pieces) {
    for (const [k, value] of Object.entries(of(p))) {
      const was = out[k];
      out[k] = { value, from: p.id, lost: was ? [...was.lost, { value: was.value, from: was.from }] : [] };
    }
  }
  return out;
}

/** То, что получит сессия с этим списком. Один код на запуск и просмотр. Отказ — BadPieces. */
export function assemble(list: string[], folderOf: (id: string) => string | null): Assembly {
  const { pieces, tree } = flatten(list, folderOf);
  const names = new Map<string, string>();
  for (const p of pieces) {
    const first = names.get(p.name);
    if (first) throw bad(`имя плагина ${p.name}: ${first} и ${p.id} — второй скил пропал бы молча`);
    names.set(p.name, p.id);
  }
  const memories = pieces.filter((p) => p.memory);
  return { pieces, tree, env: won(pieces, (p) => p.env), settings: won(pieces, (p) => p.settings), home: memories.at(-1), near: memories.slice(0, -1) };
}

export const valuesOf = (m: Record<string, Won>): Record<string, unknown> => Object.fromEntries(Object.entries(m).map(([k, w]) => [k, w.value]));

/** Индекс памяти в пределах Claude. */
function memoryIndex(dir: string): string | null {
  const file = join(dir, "memory", "MEMORY.md");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").split(/\r?\n/).slice(0, INDEX_LINES).join("\n");
  return Buffer.from(text).subarray(0, INDEX_BYTES).toString("utf8");
}

/** Добавка к промпту: папка у Claude одна, остальные памяти — путём и индексом. */
export function nearMemory(near: Piece[]): string | undefined {
  const parts = near.map((p) => {
    const index = memoryIndex(p.dir);
    return `Память кусочка ${p.id} лежит в ${join(p.dir, "memory")}. Читай и пиши её файлы по этому пути.${index ? `\nЕё индекс:\n${index}` : ""}`;
  });
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Содержимое кусочка в ответе machine.profiles: только имена, тексты читает просмотр. */
export type PieceName = { kind: "skill" | "agent" | "rule" | "memory"; name: string; path: string };

const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

function rulesIn(root: string, rel: string): string[] {
  return listing(join(root, rel)).flatMap((e) => {
    const r = join(rel, e);
    return statSync(join(root, r)).isDirectory() ? rulesIn(root, r) : e.endsWith(".md") ? [r] : [];
  });
}

const slash = (p: string) => p.replaceAll("\\", "/");

export function namesIn(dir: string): PieceName[] {
  const md = (e: string) => e.replace(/\.md$/, "");
  return [
    ...listing(join(dir, "skills")).filter((e) => existsSync(join(dir, "skills", e, "SKILL.md"))).map((e) => ({ kind: "skill" as const, name: e, path: `skills/${e}/SKILL.md` })),
    ...listing(join(dir, "agents")).filter((e) => e.endsWith(".md")).map((e) => ({ kind: "agent" as const, name: md(e), path: `agents/${e}` })),
    ...rulesIn(dir, RULES).map((r) => ({ kind: "rule" as const, name: md(basename(r)), path: slash(r) })),
    ...listing(join(dir, "memory")).filter((e) => e.endsWith(".md") && e !== "MEMORY.md").map((e) => ({ kind: "memory" as const, name: md(e), path: `memory/${e}` })),
  ];
}

export const kindOf = (dir: string, use: string[] | undefined): "set" | "style" | "piece" => (use ? "set" : existsSync(join(dir, "output-styles")) ? "style" : "piece");
