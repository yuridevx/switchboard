// Профиль сессии — список кусочков из git-репозиториев; каждая часть кусочка идёт в Claude штатным путём. Файлы читаются на каждом старте, копий нет.
// Состояние репозитория живёт в памяти Host: следующее сведение узнает его заново. Список репозиториев — настройка флота; машина её не хранит.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Host, Module, QueryPart, Session } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { FLEET_PREFIX, PROFILE_REPOS, settings, type Settings } from "@switchboard/records";
import { splitId } from "./folder.ts";
import { assemble, BadPieces, kindOf, namesIn, nearMemory, readPiece, valuesOf, type Assembly } from "./pieces.ts";
import { realGit, syncRepo, type Git, type RepoState } from "./sync.ts";
import { FILE_MAX, insideFile, viewOf } from "./view.ts";

export type { Git, RepoState };

const SYNC_MS = 60_000;

type Seat = { pieces: string[] };
/** gone — репозитория больше нет в списке: сведение отправит последнее и уберёт клон. */
type Repo = { state: RepoState; running?: Promise<void>; again?: boolean; gone?: boolean };

export function make(o: { git?: Git } = {}): Module {
  const git = o.git ?? realGit;
  let host: Host;
  let records: Settings;
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
  const seatOf = (s: Session) => s.store<Seat>();

  async function token(repo: string): Promise<string> {
    const r = await host.request("github.token", { repo });
    if (!r.ok) throw new Error(r.error);
    return (r.result as { token: string }).token;
  }

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
      const state = await syncRepo(git, repo, clone, host.machine, () => token(repo), (why) => host.log({ ev: "sync", why }));
      r.state = { ...state, dir: clone, ...(state.state === "ok" ? { at: Date.now() } : r.state.at ? { at: r.state.at } : {}) };
      if (state.state !== "ok") {
        host.log({ kind: "stop", ev: "sync", word: state.state, why: `${repo}: ${state.op} — ${state.error ?? state.files?.join(", ")}` });
      } else if (r.gone) {
        rmSync(clone, { recursive: true, force: true });
        repos.delete(repo);
        host.log({ ev: "sync", why: `${repo}: убран из списка — клон удалён` });
      } else if (was !== "ok") {
        host.log({ ev: "sync", why: `${repo}: сведён` });
      }
    })()
      .catch((e) => {
        r.state = { state: "error", op: "rm", error: (e as Error).message, dir: cloneOf(repo) };
        host.log({ kind: "stop", ev: "sync", word: "error", why: `${repo}: ${(e as Error).message}` });
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
    const word = await records.read();
    const list = records.get<string[]>(PROFILE_REPOS);
    const skip = word ?? (Array.isArray(list) ? null : "no_repos");
    if (skip !== skipped && skip) host.log({ kind: "stop", ev: "sync", word: skip, why: word ? `настройки флота не ответили: ${word} — сведение пропущено` : `ключа ${PROFILE_REPOS} нет — сведение пропущено` });
    skipped = skip;
    if (skip || !list) return;
    for (const repo of new Set([...list, ...repos.keys(), ...clonesOnDisk()])) {
      const r = repos.get(repo) ?? { state: { state: "wait" as const, dir: cloneOf(repo) } };
      r.gone = !list.includes(repo);
      repos.set(repo, r);
    }
    await Promise.all([...repos.keys()].map(kick));
  }

  function part(a: Assembly): QueryPart {
    const written = async (input: unknown) => {
      const file = (input as { tool_input?: { file_path?: unknown } }).tool_input?.file_path;
      if (typeof file === "string") {
        const path = resolve(file);
        for (const repo of new Set(a.pieces.map((p) => splitId(p.id)!.repo))) if (path.startsWith(cloneOf(repo) + sep)) void kick(repo);
      }
      return {};
    };
    const dirs = a.pieces.filter((p) => p.instructions).map((p) => p.dir);
    const append = nearMemory(a.near);
    return {
      plugins: a.pieces.map((p) => ({ type: "local", path: p.dir })),
      ...(dirs.length ? { additionalDirectories: dirs, env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } } : {}),
      ...(a.home ? { settings: { autoMemoryDirectory: join(a.home.dir, "memory") } } : {}),
      ...(append ? { append } : {}),
      defaults: { tier: "profile", env: valuesOf(a.env) as Record<string, string>, settings: valuesOf(a.settings) },
      hooks: { PostToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [written] }] },
    };
  }

  /** Список из запроса: только список строк. */
  function listOf(value: unknown, where: string): string[] {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw refuse("bad_frame", `${where}: profile — список кусочков`);
    return value as string[];
  }

  /** Кусочек в списке машины: сломанный манифест не прячет его, отказ скажет открытие. */
  function readable(id: string, dir: string): { about?: string; use?: string[] } {
    try {
      return readPiece(id, dir);
    } catch (e) {
      if (e instanceof BadPieces) return {};
      throw e;
    }
  }

  /** Запрос просит собрать список сейчас: не собрался — отказ словом. */
  function check(list: string[]): Assembly {
    try {
      return assemble(list, folderOf);
    } catch (e) {
      throw e instanceof BadPieces ? refuse(e.word, e.message) : e;
    }
  }

  return {
    openingReads: ["profile"],
    opening(s, req) {
      if (req.profile === undefined) return;
      const list = listOf(req.profile, "session.open");
      if (!list.length) return;
      check(list);
      seatOf(s).set({ pieces: list });
    },
    session(s) {
      const list = seatOf(s).get()?.pieces;
      if (!list?.length) return undefined;
      try {
        const a = assemble(list, folderOf);
        broken.delete(s.info.callsign);
        return part(a);
      } catch (e) {
        if (!(e instanceof BadPieces)) throw e;
        // причина появилась в git после открытия: отказ в сборке выключил бы модуль в сессии, и заменить список стало бы нельзя
        broken.add(s.info.callsign);
        host.log({ kind: "stop", ev: "profile", word: e.word, callsign: s.info.callsign, why: `${e.message} — сессия без кусочков` });
        return undefined;
      }
    },
    fields: {
      profile(s) {
        const list = seatOf(s).get()?.pieces;
        if (!list?.length) return undefined;
        const down = broken.has(s.info.callsign);
        return list.map((id) => ({ id, state: down || !folderOf(id) ? "error" : "ok" }));
      },
    },
    requests: {
      "session.profile"(req) {
        const s = host.session(req.callsign as string)!;
        const list = listOf(req.profile, "session.profile");
        check(list);
        if (JSON.stringify(seatOf(s).get()?.pieces ?? []) === JSON.stringify(list)) return { restart: false };
        seatOf(s).set({ pieces: list });
        broken.delete(s.info.callsign);
        if (s.state === "stopped" || s.state === "failed") return { restart: false };
        void s.restart();
        return { restart: true };
      },
      "profile.view": (req) => viewOf(check(listOf(req.profile, "profile.view"))),
      "profile.file"(req) {
        const { id, path } = req;
        if (typeof id !== "string" || typeof path !== "string") throw refuse("bad_frame", "profile.file: нужны id и path");
        const dir = folderOf(id);
        if (!dir) throw refuse("no_profile", `${id}: такой папки нет в клонах`);
        const file = insideFile(dir, path);
        if (!file) throw refuse("bad_frame", `${id}: файла ${path} в кусочке нет`);
        if (statSync(file).size > FILE_MAX) throw refuse("too_large", `${path}: больше ${FILE_MAX / 1024} КБ`);
        return { text: readFileSync(file, "utf8") };
      },
      async "machine.profiles"(req) {
        if (req.sync === true) await tick();
        const profiles: Record<string, unknown> = {};
        for (const repo of repos.keys()) {
          const clone = cloneOf(repo);
          if (!existsSync(clone)) continue;
          for (const e of readdirSync(clone, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name.startsWith(".")) continue;
            const id = `${repo}/${e.name}`;
            const dir = join(clone, e.name);
            const { about, use } = readable(id, dir);
            profiles[id] = { ...(about ? { about } : {}), ...(use ? { use } : {}), kind: kindOf(dir, use), names: namesIn(dir) };
          }
        }
        return { profiles, repos: Object.fromEntries([...repos].filter(([, r]) => !r.gone).map(([repo, r]) => [repo, r.state])) };
      },
    },
    start(h) {
      host = h;
      records = settings({ read: (name, body) => h.read(name, body) as never, ask: (name, body) => h.request(name, body) as never, prefix: FLEET_PREFIX, scope: "global" });
      timer = setInterval(() => void tick(), SYNC_MS);
    },
    on: {
      // на старте связи ещё нет: первое чтение списка — после подключения
      ready: () => void tick(),
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      await Promise.all([...repos.values()].map((r) => r.running));
    },
  };
}
