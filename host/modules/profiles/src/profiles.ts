// Профиль сессии — папка в git-репозитории: CLAUDE.md, profile.yaml, memory/, skills/. Файлы читаются на каждом старте, копий нет.
// Состояние репозитория живёт в памяти Host: следующая синхронизация узнает его заново.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Host, Module, QueryPart, Session } from "@switchboard/host";
import { refuse } from "@switchboard/host";
import { parseYaml, splitId } from "./folder.ts";
import { realGit, syncRepo, type Git, type RepoState } from "./sync.ts";

export type { Git, RepoState };

const SYNC_MS = 60_000;
const ASK_HUMAN = "Без человека не решить — спроси.";

type Seat = { profile: string | null };
type Repo = { state: RepoState; running?: Promise<void>; again?: boolean };

export function make(o: { git?: Git } = {}): Module {
  const git = o.git ?? realGit;
  let host: Host;
  let timer: ReturnType<typeof setInterval>;
  let stopping = false;
  const repos = new Map<string, Repo>();

  const cloneOf = (repo: string) => join(host.dataDir, "profiles", repo.replace("/", "__"));
  /** Папка профиля, если он есть в клоне. */
  function folderOf(id: string): string | null {
    const p = splitId(id);
    if (!p) return null;
    const dir = join(cloneOf(p.repo), p.folder);
    return existsSync(join(dir, "CLAUDE.md")) || existsSync(join(dir, "profile.yaml")) ? dir : null;
  }
  const yamlOf = (dir: string) => (existsSync(join(dir, "profile.yaml")) ? parseYaml(readFileSync(join(dir, "profile.yaml"), "utf8")) : {});
  const notFound = (id: string) => refuse("no_profile", `${id}: в клонах нет папки профиля с CLAUDE.md или profile.yaml`);
  const seatOf = (s: Session) => s.store<Seat>();

  async function token(repo: string): Promise<string> {
    const r = await host.request("github.token", { repo });
    if (!r.ok) throw new Error(r.error);
    return (r.result as { token: string }).token;
  }

  /** Одна синхронизация репозитория за раз; запись посреди идущей — следующая после неё. */
  function kick(repo: string): Promise<void> {
    const r = repos.get(repo)!;
    if (r.running) {
      r.again = true;
      return r.running;
    }
    r.running = (async () => {
      const was = r.state.state;
      r.state = await syncRepo(git, repo, cloneOf(repo), host.machine, () => token(repo), (why) => host.log({ ev: "sync", why }));
      if (r.state.state === "ok") {
        if (was !== "ok") host.log({ ev: "sync", why: `${repo}: память сведена — ok` });
      } else {
        host.log({ kind: "stop", ev: "sync", word: r.state.state, why: `${repo}: ${r.state.op} — ${r.state.error ?? r.state.files?.join(", ")}` });
      }
      for (const { callsign } of host.sessions()) host.session(callsign)!.refresh();
    })().finally(() => {
      r.running = undefined;
      if (r.again && !stopping) {
        r.again = false;
        void kick(repo);
      }
    });
    return r.running;
  }

  /** Задание модели: что мешает памяти профиля; мешать нечему — ничего. */
  function trouble(id: string): string | null {
    const p = splitId(id);
    if (!p) return null;
    const clone = cloneOf(p.repo);
    const tail = `(клон ${clone}). ${ASK_HUMAN}`;
    if (!folderOf(id)) return `Профиля ${id} нет в клоне ${tail}`;
    const s = repos.get(p.repo)?.state;
    if (s?.state === "conflict") return `Память профиля ${p.folder} не сведена: ${s.op} — конфликт в ${s.files?.join(", ")} (клон ${clone}). Сведи обе версии, закоммить и отправь. ${ASK_HUMAN}`;
    if (s?.state === "error") return `Память профиля ${p.folder} не отправлена: ${s.op} — ${s.error} ${tail}`;
    return null;
  }

  function part(id: string, dir: string): QueryPart {
    const y = yamlOf(dir);
    const settings: Record<string, unknown> = { autoMemoryDirectory: join(dir, "memory") };
    if (y.model) settings.model = y.model;
    if (y.effort) settings.effortLevel = y.effort;
    if (y.max_effort) settings.maxEffortLevel = y.max_effort;
    if (y.fallback_model) settings.fallbackModel = y.fallback_model;
    const task = (event: "SessionStart" | "UserPromptSubmit") => async () => {
      const text = trouble(id);
      return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : {};
    };
    const written = async (input: unknown) => {
      const file = (input as { tool_input?: { file_path?: unknown } }).tool_input?.file_path;
      if (typeof file === "string") {
        const path = resolve(file);
        if ([join(dir, "memory"), join(dir, "skills")].some((d) => path.startsWith(d + sep))) void kick(splitId(id)!.repo);
      }
      return {};
    };
    const claudeMd = join(dir, "CLAUDE.md");
    return {
      ...(existsSync(claudeMd) ? { append: readFileSync(claudeMd, "utf8") } : {}),
      settings,
      env: { SWITCHBOARD_PROFILE: id },
      plugins: [{ type: "local", path: dir }],
      hooks: { PostToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [written] }], SessionStart: [{ hooks: [task("SessionStart")] }], UserPromptSubmit: [{ hooks: [task("UserPromptSubmit")] }] },
    };
  }

  return {
    openingReads: ["profile"],
    opening(s, req) {
      const id = req.profile;
      if (id === undefined || id === null) return;
      if (typeof id !== "string") throw refuse("bad_frame", "session.open: profile — имя профиля");
      if (!folderOf(id)) throw notFound(id);
      seatOf(s).set({ profile: id });
    },
    session(s) {
      const id = seatOf(s).get()?.profile;
      if (!id) return undefined;
      const dir = folderOf(id);
      if (dir) return part(id, dir);
      host.log({ kind: "stop", ev: "profile", word: "no_profile", callsign: s.info.callsign, why: `${id}: профиля нет в клоне — сессия без его части` });
      return undefined;
    },
    fields: {
      profile(s) {
        const id = seatOf(s).get()?.profile;
        if (!id) return undefined;
        const p = splitId(id);
        return { id, state: !folderOf(id) ? "error" : ((p && repos.get(p.repo)?.state.state) ?? "ok") };
      },
    },
    requests: {
      "session.profile"(req) {
        const s = host.session(req.callsign as string)!;
        const id = req.profile;
        if (id !== null && typeof id !== "string") throw refuse("bad_frame", "session.profile: нужно поле profile — имя профиля или null");
        if (id !== null && !folderOf(id)) throw notFound(id);
        if ((seatOf(s).get()?.profile ?? null) === id) return { restart: false };
        seatOf(s).set({ profile: id });
        if (s.state === "stopped" || s.state === "failed") return { restart: false };
        void s.restart();
        return { restart: true };
      },
      async "machine.profiles"(req) {
        if (req.sync === true) await Promise.all([...repos.keys()].map(kick));
        const profiles: Record<string, { model: unknown; effort: unknown; about?: unknown }> = {};
        for (const repo of repos.keys()) {
          const clone = cloneOf(repo);
          if (!existsSync(clone)) continue;
          for (const e of readdirSync(clone, { withFileTypes: true })) {
            const dir = e.isDirectory() && e.name !== ".git" ? folderOf(`${repo}/${e.name}`) : null;
            if (!dir) continue;
            const y = yamlOf(dir);
            profiles[`${repo}/${e.name}`] = { model: y.model ?? null, effort: y.effort ?? null, ...(y.about ? { about: y.about } : {}) };
          }
        }
        return { profiles, repos: Object.fromEntries([...repos].map(([repo, r]) => [repo, r.state])) };
      },
    },
    start(h) {
      host = h;
      for (const repo of host.config<{ repos?: string[] }>()?.repos ?? []) repos.set(repo, { state: { state: "ok" } });
      timer = setInterval(() => {
        for (const repo of repos.keys()) void kick(repo);
      }, SYNC_MS);
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      await Promise.all([...repos.values()].map((r) => r.running));
    },
  };
}
