// Профиль сессии — список кусочков из git-репозиториев; каждая часть кусочка идёт в Claude штатным путём. Файлы читаются на каждом старте, копий нет.
// Состояние репозитория живёт в памяти Host: следующее сведение узнает его заново. Список репозиториев — настройка флота; машина её не хранит.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { githubToken, prefsGet, READ_MS, Refusal, sessionCall, within, type Piece as PieceOut, type RepoClone } from "@sb/protocol";
import type { HostApi, Module, QueryPart, SessionApi } from "../../core/contract.ts";
import { splitId } from "./folder.ts";
import { assemble, BadPieces, indexMeasure, namesIn, nearMemory, readPiece, valuesOf, type Assembly } from "./pieces.ts";
import { realGit, syncRepo, type Git, type RepoState } from "./sync.ts";
import { FILE_MAX, insideFile, viewOf } from "./view.ts";

export type { Git, RepoState };

const SYNC_MS = 60_000;
/** Ключ настроек флота: список репозиториев кусочков вида team/profiles. */
export const PROFILE_REPOS = "profiles.repos";

/** Модели, которым открыта запись в память кусочков (слово пользователя 19 нояб. 2026: «Opus 5.5 и более сильные»). Любая другая и неизвестная модель память читает.
 *  Список один, здесь: справка флота называет правило без имён, свою модель сессия узнаёт из причины отказа. */
const WRITERS = new Set(["claude-opus-5-5", "claude-fable-5", "claude-fable-5-1", "claude-fable-5-2"]);
/** Пометка окна в имени ([1m]) модель не меняет. */
const writes = (model: string | undefined) => !!model && WRITERS.has(model.replace(/\[1m\]$/, ""));
/** Без кусочка с памятью встроенная память Claude Code выключена: память одна — общая, в папку машины сессия не пишет. */
const NO_MEMORY: QueryPart = { settings: { autoMemoryEnabled: false } };
/** Индекс памяти кусочка: путь внутри его папки. */
const INDEX = "memory/MEMORY.md";
/** Сравнение путей: у Windows регистр букв в пути не значит ничего. */
const same = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

/** gone — репозитория больше нет в списке: сведение отправит последнее и уберёт клон. */
type Repo = { state: RepoState; running?: Promise<void>; again?: boolean; gone?: boolean };

export function make(o: { git?: Git } = {}): Module {
  const git = o.git ?? realGit;
  let host: HostApi;
  let timer: ReturnType<typeof setInterval>;
  let stopping = false;
  const repos = new Map<string, Repo>();
  /** сессии, чей список на этом старте не собрался: причина уже в журнале */
  const broken = new Set<string>();
  /** последнее слово пропуска: журнал называет причину один раз, а не каждую минуту */
  let skipped: string | null = null;

  const root = () => join(host.dataDir, "profiles");
  const cloneOf = (repo: string) => join(root(), repo.replace("/", "__"));
  /** Папка кусочка на диске: на подъёме списка репозиториев ещё нет. */
  function folderOf(id: string): string | null {
    const p = splitId(id);
    if (!p) return null;
    const dir = join(cloneOf(p.repo), p.folder);
    return existsSync(dir) ? dir : null;
  }

  const token = async (repo: string) => (await host.call(githubToken, { repo })).token;

  /** Одно сведение репозитория за раз; запись посреди идущего — следующее после него. */
  function kick(repo: string): Promise<void> {
    const r = repos.get(repo);
    if (!r) return Promise.resolve();
    if (r.running) {
      r.again = true;
      return r.running;
    }
    r.running = (async () => {
      const clone = cloneOf(repo);
      if (r.gone && !existsSync(clone)) return void repos.delete(repo);
      const was = r.state.state;
      const state = await syncRepo(git, repo, clone, host.machine, () => token(repo), (why) => host.log.info("sync", { why }));
      const { pulled, ...rest } = state;
      r.state = { ...rest, dir: clone, ...(state.state === "ok" ? { at: Date.now() } : r.state.at ? { at: r.state.at } : {}) };
      // сведение принесло чужие правки кусочков — работающие сессии этого репозитория перечитывают скилы, агентов и серверы плагинов
      if (pulled) for (const s of host.sessions()) {
        if (s.state === "stopped" || s.state === "failed" || !(s.spec.pieces ?? []).some((id) => splitId(id)?.repo === repo)) continue;
        void host.call(sessionCall, { to: s.callsign, method: "reload" }).catch((e: unknown) => host.log.warn("reload", { callsign: s.callsign, why: `кусочки ${repo} обновились, сессия не перечитала: ${(e as Error).message}` }));
      }
      if (state.state !== "ok") {
        host.log.warn("sync", { word: state.state, why: `${repo}: ${state.op} — ${state.error ?? state.files?.join(", ")}` });
      } else if (r.gone) {
        rmSync(clone, { recursive: true, force: true });
        repos.delete(repo);
        host.log.info("sync", { why: `${repo}: убран из списка — клон удалён` });
      } else if (was !== "ok") {
        host.log.info("sync", { why: `${repo}: сведён` });
      }
    })()
      .catch((e) => {
        r.state = { state: "error", op: "rm", error: (e as Error).message, dir: cloneOf(repo) };
        host.log.warn("sync", { word: "error", why: `${repo}: ${(e as Error).message}` });
      })
      .finally(() => {
        r.running = undefined;
        if (r.again && !stopping) {
          r.again = false;
          void kick(repo);
        }
      });
    return r.running;
  }

  const clonesOnDisk = () => (existsSync(root()) ? readdirSync(root()).map((n) => n.replace("__", "/")) : []);

  /** Такт сведения: свежий список флота и все его репозитории. Ключа нет или служба молчит — не значит «репозиториев нет»: клоны не трогаем. */
  async function tick(): Promise<void> {
    let list: unknown;
    let word: string | null = null;
    try {
      list = (await within(host.call(prefsGet, { scope: "fleet", prefix: PROFILE_REPOS }), READ_MS)).values[PROFILE_REPOS];
    } catch (e) {
      word = (e as Refusal).word ?? "offline";
    }
    const skip = word ?? (Array.isArray(list) ? null : "no_repos");
    if (skip !== skipped && skip) host.log.warn("sync", { word: skip, why: word ? `настройки флота не ответили: ${word} — сведение пропущено` : `ключа ${PROFILE_REPOS} нет — сведение пропущено` });
    skipped = skip;
    if (skip) return;
    const wanted = list as string[];
    for (const repo of new Set([...wanted, ...repos.keys(), ...clonesOnDisk()])) {
      const r = repos.get(repo) ?? { state: { state: "wait" as const, dir: cloneOf(repo) } };
      r.gone = !wanted.includes(repo);
      repos.set(repo, r);
    }
    await Promise.all([...repos.keys()].map(kick));
  }

  function part(a: Assembly, s: SessionApi): QueryPart {
    const fileOf = (input: unknown) => (input as { tool_input?: { file_path?: unknown } }).tool_input?.file_path;
    /** Запись памяти по пути файла. Память кусочка — всё в папке memory любого кусочка набора сессии: домашняя и соседние; память кусочка вне набора сюда не входит. */
    const recordOf = (file: unknown): { piece: string; record: string } | null => {
      if (typeof file !== "string") return null;
      const path = resolve(file);
      for (const p of a.pieces) {
        const dir = join(p.dir, "memory") + sep;
        if (p.memory && same(path).startsWith(same(dir))) return { piece: p.id, record: path.slice(dir.length).replaceAll("\\", "/").replace(/\.md$/, "") };
      }
      return null;
    };
    /** След: строка журнала машины на чтение записи, запись и отказ. Уровень «инфо»: в ленту сессии она не идёт — отказ там уже виден ответом инструмента. */
    const trace = (hit: { piece: string; record: string }, op: "read" | "write" | "refused") => host.log.info("memory", { callsign: s.callsign, model: s.spec.model, ...hit, op });
    // замок: запись в память кусочка — только модели из списка пишущих. Модель читается из документа на каждом вызове: смена модели действует со следующей записи
    const lock = async (input: unknown) => {
      const hit = recordOf(fileOf(input));
      if (!hit || writes(s.spec.model)) return {};
      trace(hit, "refused");
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Память только для чтения: модель ${s.spec.model ?? "без имени"} не из пишущих память. Важное для памяти скажи в ответе тому, кто дал задачу.` } };
    };
    // сессия записала файл в клон кусочка — сведение сразу
    const written = async (input: unknown) => {
      const file = fileOf(input);
      if (typeof file === "string") {
        const path = resolve(file);
        for (const repo of new Set(a.pieces.map((p) => splitId(p.id)!.repo))) if (path.startsWith(cloneOf(repo) + sep)) void kick(repo);
        const hit = recordOf(file);
        if (hit) trace(hit, "write");
      }
      return {};
    };
    const read = async (input: unknown) => {
      const hit = recordOf(fileOf(input));
      if (hit) trace(hit, "read");
      return {};
    };
    const dirs = a.pieces.filter((p) => p.instructions).map((p) => p.dir);
    const append = nearMemory(a.near);
    return {
      plugins: a.pieces.map((p) => ({ type: "local", path: p.dir })),
      ...(dirs.length ? { additionalDirectories: dirs, env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } } : {}),
      // опции запуска от модели не зависят: папка памяти — память последнего кусочка с памятью; нет такого — встроенная память выключена
      settings: a.home ? { autoMemoryDirectory: join(a.home.dir, "memory") } : NO_MEMORY.settings,
      ...(append ? { append } : {}),
      defaults: { env: valuesOf(a.env) as Record<string, string>, settings: valuesOf(a.settings) },
      hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [lock] }], PostToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [written] }, { matcher: "Read", hooks: [read] }] },
    };
  }

  /** Запрос просит собрать список сейчас: не собрался — отказ словом. */
  function check(list: string[]): Assembly {
    try {
      return assemble(list, folderOf);
    } catch (e) {
      throw e instanceof BadPieces ? new Refusal(e.word, e.message) : e;
    }
  }

  /** Кусочек в списке машины: сломанный манифест не прячет его, отказ скажет открытие. */
  function pieceOf(id: string, dir: string, repo: string, state: RepoState): PieceOut {
    const names = namesIn(dir);
    const has: Record<string, number> = {};
    for (const n of names) has[n.kind] = (has[n.kind] ?? 0) + 1;
    if (existsSync(join(dir, ".mcp.json"))) has.mcp = 1;
    if (existsSync(join(dir, "settings.json"))) has.settings = 1;
    if (existsSync(join(dir, "hooks", "hooks.json"))) has.hooks = 1;
    const base = { id, repo, has, ...(state.at ? { rev: new Date(state.at).toISOString() } : {}) };
    try {
      const { name, about, use } = readPiece(id, dir);
      if (use) has.set = use.length;
      return { ...base, title: name, ...(about ? { about } : {}), ok: state.state === "ok" || state.state === "wait", ...(state.state === "conflict" || state.state === "error" ? { why: `${state.op ?? ""} ${state.error ?? state.files?.join(", ") ?? ""}`.trim() } : {}) };
    } catch (e) {
      if (!(e instanceof BadPieces)) throw e;
      return { ...base, ok: false, why: e.message };
    }
  }

  const piecesOf = (s: SessionApi) => s.spec.pieces ?? [];

  /** Клоны машины строками: что с каждым сейчас. */
  const clones = (only?: Set<string>): RepoClone[] =>
    [...repos].filter(([repo, r]) => !r.gone && (!only || only.has(repo))).map(([repo, r]) => ({
      repo, state: r.state.state, ...(r.state.op ? { op: r.state.op } : {}), ...(r.state.files?.length ? { files: r.state.files } : {}),
      ...(r.state.error ? { error: r.state.error } : {}), dir: cloneOf(repo), ...(r.state.at ? { at: r.state.at } : {}),
    }));

  return {
    name: "host-profiles",
    spec: {
      pieces(value) {
        const list = value as string[];
        if (list.length) check(list);
      },
    },
    applied(s, keys) {
      if (!keys.includes("pieces")) return;
      broken.delete(s.callsign);
      // новый набор вступает в силу с новым процессом
      if (s.state !== "stopped" && s.state !== "failed") void s.restart();
    },
    /** Сессия, открытая сессией без названных кусочков, берёт кусочки родителя — с ними память, инструкции и скилы. Пустой список назван: дочь без кусочков. */
    fill: { pieces: (_doc, parent) => parent?.pieces },
    compose(s) {
      const list = piecesOf(s);
      if (!list.length) return NO_MEMORY;
      try {
        const a = assemble(list, folderOf);
        broken.delete(s.callsign);
        return part(a, s);
      } catch (e) {
        if (!(e instanceof BadPieces)) throw e;
        // причина появилась в git после открытия: отказ в сборке не дал бы сессии подняться, и заменить список стало бы нельзя
        broken.add(s.callsign);
        host.log.error("profile", { word: e.word, callsign: s.callsign, why: `${e.message} — сессия без кусочков` });
        return NO_MEMORY;
      }
    },
    requests: {
      async "profile.list"() {
        if (!repos.size) await tick();
        const pieces: PieceOut[] = [];
        for (const [repo, r] of repos) {
          const clone = cloneOf(repo);
          if (r.gone || !existsSync(clone)) continue;
          for (const e of readdirSync(clone, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name.startsWith(".")) continue;
            pieces.push(pieceOf(`${repo}/${e.name}`, join(clone, e.name), repo, r.state));
          }
        }
        return { pieces, repos: clones() };
      },
      /** «Свести сейчас»: весь список флота или только репозитории кусочков одной сессии. */
      async "profile.sync"({ session }: { session?: string }) {
        if (!session) {
          await tick();
          if (skipped) throw new Refusal(skipped, skipped === "no_repos" ? `ключа ${PROFILE_REPOS} нет в настройках флота` : "настройки флота не ответили");
          return { repos: clones() };
        }
        const s = host.session(session);
        if (!s) throw new Refusal("not_found", `сессии ${session} нет на ${host.machine}`);
        const only = new Set(piecesOf(s).flatMap((id) => splitId(id)?.repo ?? []));
        if (!repos.size) await tick();
        await Promise.all([...only].map(kick));
        return { repos: clones(only) };
      },
      "profile.view"({ pieces }: { pieces: string[] }) {
        const a = check(pieces);
        const v = viewOf(a);
        const append = nearMemory(a.near);
        return {
          // подробности: что встанет в промпт, дерево наборов, победители и проигравшие настроек, файлы и то, что Claude не подключит
          prompt: { ...v.prompt, ...(append ? { append } : {}) },
          tree: v.tree,
          settings: v.settings,
          files: v.files,
          other: v.other,
          // мера индекса каждой памяти набора: считает машина, страница своих пределов не держит
          memory: [...(v.memory.home ? [v.memory.home] : []), ...v.memory.near].filter((m) => v.files[m.from]?.some((f) => f.path === INDEX)).map((m) => ({ piece: m.from, path: INDEX, ...indexMeasure(m.indexLines, m.indexBytes) })),
          items: [
            ...v.skills.map((x) => ({ kind: "skill", name: x.name, piece: x.from, path: x.path, about: x.description })),
            ...v.agents.map((x) => ({ kind: "agent", name: x.name, piece: x.from, path: x.path, about: x.description })),
            ...v.instructions.map((x) => ({ kind: x.rule ? "rule" : "instructions", name: x.path, piece: x.from, path: x.path, about: x.head })),
            ...v.mcp.map((x) => ({ kind: x.kind === "server" ? "mcp" : "hook", name: x.name, piece: x.from, about: x.detail })),
            ...Object.entries(v.settings).map(([name, w]) => ({ kind: "setting", name, piece: w.from, about: JSON.stringify(w.value) })),
            ...[...(v.memory.home ? [v.memory.home] : []), ...v.memory.near].map((m) => ({ kind: "memory", name: "memory", piece: m.from, path: "memory/MEMORY.md", about: `файлов ${m.files}` })),
          ],
        };
      },
      "profile.file"({ piece, path }: { piece: string; path: string }) {
        const dir = folderOf(piece);
        if (!dir) throw new Refusal("no_profile", `${piece}: такой папки нет в клонах`);
        const file = insideFile(dir, path);
        if (!file) throw new Refusal("not_found", `${piece}: файла ${path} в кусочке нет`);
        if (statSync(file).size > FILE_MAX) throw new Refusal("too_large", `${path}: больше ${FILE_MAX / 1024} КБ`);
        return { text: readFileSync(file, "utf8") };
      },
    },
    start(h) {
      host = h;
      timer = setInterval(() => void tick(), SYNC_MS);
      timer.unref();
      // на старте связи может ещё не быть: первое сведение пробуем сразу, следующее — по такту
      void tick();
    },
    on: {
      changed(what) {
        if (what === PROFILE_REPOS) void tick();
      },
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      await Promise.all([...repos.values()].map((r) => r.running));
    },
  };
}
