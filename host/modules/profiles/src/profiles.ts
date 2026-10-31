// Модуль profiles: профиль сессии — папка в git-репозитории: CLAUDE.md (добавка к промпту), profile.yaml
// (модель и усилие) и memory/ (память, пишет только claude). У каждого профиля свой путь памяти —
// settings.autoMemoryDirectory. Память профилей profiles сводит между машинами сам: только папки memory/,
// сетевой git — с токеном приложения GitHub от Worker github, токен — в окружении git, не в аргументах.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { refuse } from "@switchboard/host";
import type { Host, Module, QueryPart, Session } from "@switchboard/host";

/** Запуск git: аргументы, папка, своё окружение поверх окружения Host. */
export type Git = (args: string[], o: { cwd: string; env: Record<string, string> }) => Promise<{ code: number; out: string }>;

export type RepoState = {
  state: "ok" | "error" | "conflict";
  op?: string;
  files?: string[];
  since?: number;
  error?: string;
  last?: string;
};
type Machine = { repos?: Record<string, RepoState>; pending?: Record<string, string | null> };
type Mine = { profile: string | null };
type Config = { repos?: string[] };

/** Синхронизация раз в минуту. */
export const SYNC_MS = 60_000;
/** Окружение каждого git: без вопросов человеку — под Host окна ввода нет. */
export const QUIET = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

export const switchboardHome = () => process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard");
export const cloneDir = (repo: string) => join(switchboardHome(), "profiles", repo.replace("/", "__"));

/** Настоящий git ОС. */
export const realGit: Git = (args, o) =>
  new Promise((res) => {
    execFile("git", args, { cwd: o.cwd, env: { ...process.env, ...o.env }, windowsHide: true, maxBuffer: 16 << 20 }, (e, out, err) => {
      const code = e ? (typeof (e as { code?: unknown }).code === "number" ? ((e as { code: number }).code) : 1) : 0;
      res({ code, out: `${out}${err}` });
    });
  });

/** profile.yaml: строки «ключ: значение» и списки [a, b]. */
export function parseYaml(text: string): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const v = m[2];
    const unq = (x: string) => x.trim().replace(/^["']|["']$/g, "");
    r[m[1]] = v.startsWith("[") ? v.replace(/^\[|\]$/g, "").split(",").map(unq).filter(Boolean) : unq(v);
  }
  return r;
}

/** «team/profiles/ops» → репозиторий и папка. */
export function splitId(id: string): { repo: string; folder: string } | null {
  const parts = id.split("/");
  if (parts.length < 3 || parts.some((p) => !p || p === "." || p === "..")) return null;
  return { repo: parts.slice(0, 2).join("/"), folder: parts.slice(2).join("/") };
}

export function make(deps: { git?: Git } = {}): Module {
  const git = deps.git ?? realGit;
  let host: Host;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;
  /** синхронизации репозитория идут по одной */
  const chains = new Map<string, Promise<void>>();

  const mstore = () => host.store<Machine>();
  const repos = (): string[] => host.config<Config>().repos ?? [];
  const stateOf = (repo: string): RepoState => mstore().get()?.repos?.[repo] ?? { state: "ok" };
  const setState = (repo: string, st: RepoState) => mstore().update((m) => ({ ...m, repos: { ...(m?.repos ?? {}), [repo]: st } }));
  const profileOf = (s: Session) => s.store<Mine>().get()?.profile ?? null;

  /** Папка профиля, если она есть в клоне: с CLAUDE.md или profile.yaml. */
  function dirOf(id: string): string | null {
    const p = splitId(id);
    if (!p) return null;
    const d = join(cloneDir(p.repo), ...p.folder.split("/"));
    return existsSync(join(d, "CLAUDE.md")) || existsSync(join(d, "profile.yaml")) ? d : null;
  }
  const memoryOf = (dir: string) => join(dir, "memory");

  /** Профили клона: папки первого уровня с CLAUDE.md или profile.yaml. */
  function profilesOf(repo: string): string[] {
    const d = cloneDir(repo);
    if (!existsSync(d)) return [];
    return readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && (existsSync(join(d, e.name, "CLAUDE.md")) || existsSync(join(d, e.name, "profile.yaml"))))
      .map((e) => e.name);
  }

  const yamlOf = (dir: string) => (existsSync(join(dir, "profile.yaml")) ? parseYaml(readFileSync(join(dir, "profile.yaml"), "utf8")) : {});

  /** Задание модели, пока состояние репозитория профиля не ok. */
  function task(id: string): string | null {
    const p = splitId(id);
    if (!p) return null;
    const st = stateOf(p.repo);
    const name = p.folder;
    const where = `клон ${cloneDir(p.repo)}`;
    if (!dirOf(id)) return `Профиля ${id} нет в клоне (${where}). Без человека не решить — спроси.`;
    if (st.state === "conflict")
      return `Память профиля ${name} не сведена: ${st.op} — конфликт в ${(st.files ?? []).join(", ")} (${where}). Сведи обе версии, закоммить и отправь. Без человека не решить — спроси.`;
    if (st.state === "error") return `Память профиля ${name} не отправлена: ${st.op} — ${st.error} (${where}). Без человека не решить — спроси.`;
    return null;
  }

  async function run(repo: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string }> {
    return git(["-c", "credential.interactive=never", ...args], { cwd: existsSync(cloneDir(repo)) ? cloneDir(repo) : switchboardHome(), env: { ...QUIET, ...extra } });
  }

  /** Токен приложения GitHub на репозиторий — заголовок http через окружение git. */
  async function token(repo: string): Promise<Record<string, string> | { error: string }> {
    const r = await host.request("github.token", { v: 1, to: "github", repo });
    if (!r.ok) return { error: r.error };
    const t = (r.result as { token: string }).token;
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: basic ${Buffer.from(`x-access-token:${t}`).toString("base64")}`,
    };
  }

  function fail(repo: string, st: RepoState): void {
    setState(repo, { since: Math.floor(Date.now() / 1000), ...st });
    host.log({ kind: "stop", ev: "sync", repo, word: st.state, why: `${repo}: ${st.op} — ${st.error ?? (st.files ?? []).join(", ")}` });
  }

  /** Одна синхронизация: memory/ в коммит, токен, pull --no-rebase, push. */
  async function syncOnce(repo: string): Promise<void> {
    const dir = cloneDir(repo);
    if (!existsSync(join(dir, ".git"))) {
      const env = await token(repo);
      if ("error" in env) return fail(repo, { state: "error", op: "github.token", error: env.error });
      mkdirSync(join(switchboardHome(), "profiles"), { recursive: true });
      const r = await git(["-c", "credential.interactive=never", "clone", `https://github.com/${repo}.git`, dir], { cwd: join(switchboardHome(), "profiles"), env: { ...QUIET, ...env } });
      if (r.code !== 0) return fail(repo, { state: "error", op: "git clone", error: r.out.trim().split("\n").pop() });
      setState(repo, { state: "ok", last: "clone" });
      host.log({ ev: "sync", repo, why: `${repo}: клон` });
      return;
    }
    const mem = profilesOf(repo)
      .map((p) => `${p}/memory`)
      .filter((m) => existsSync(join(dir, m)));
    if (mem.length) {
      const add = await run(repo, ["add", "--", ...mem]);
      if (add.code !== 0) return fail(repo, { state: "error", op: "git add", error: add.out.trim() });
      const diff = await run(repo, ["diff", "--cached", "--quiet"]);
      if (diff.code !== 0) {
        const at = new Date().toTimeString().slice(0, 5);
        const c = await run(repo, ["commit", "-m", `память: ${host.machine} ${at}`]);
        if (c.code !== 0) return fail(repo, { state: "error", op: "git commit", error: c.out.trim() });
      }
    }
    const env = await token(repo);
    if ("error" in env) return fail(repo, { state: "error", op: "github.token", error: env.error });
    const pull = await run(repo, ["pull", "--no-rebase", "--no-edit"], env);
    if (pull.code !== 0) {
      if (/CONFLICT/.test(pull.out)) {
        const u = await run(repo, ["diff", "--name-only", "--diff-filter=U"]);
        const files = u.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        return fail(repo, { state: "conflict", op: "git pull --no-rebase", files, error: pull.out.trim().split("\n")[0] });
      }
      return fail(repo, { state: "error", op: "git pull --no-rebase", error: pull.out.trim().split("\n").pop() });
    }
    const push = await run(repo, ["push"], env);
    if (push.code !== 0) return fail(repo, { state: "error", op: "git push", error: push.out.trim().split("\n").pop() });
    const last = (await run(repo, ["log", "-1", "--format=%s"])).out.trim();
    const was = stateOf(repo).state;
    setState(repo, { state: "ok", ...(last ? { last } : {}) });
    if (was !== "ok") host.log({ ev: "sync", repo, why: `${repo}: память сведена — ok` });
  }

  /** Синхронизация репозитория; идёт другая — после неё. Остановка — новую не начинать. */
  function sync(repo: string): Promise<void> {
    const prev = chains.get(repo) ?? Promise.resolve();
    const p = prev.then(() => (stopping ? undefined : syncOnce(repo)));
    const tail = p.catch((e) => fail(repo, { state: "error", op: "sync", error: (e as Error).message }));
    chains.set(repo, tail);
    return tail;
  }

  /** Хук PostToolUse: запись в memory/ профиля — синхронизация в очередь, ответ сразу. */
  function postTool(id: string) {
    return async (input: unknown) => {
      const path = ((input as { tool_input?: { file_path?: string } })?.tool_input?.file_path ?? "") as string;
      const dir = dirOf(id);
      const p = splitId(id);
      if (dir && p && path) {
        const rel = relative(resolve(memoryOf(dir)), resolve(path));
        if (rel && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel)) void sync(p.repo);
      }
      return {};
    };
  }

  /** Хуки SessionStart и UserPromptSubmit: состояние не ok — задание модели. */
  function nudge(id: string, event: "SessionStart" | "UserPromptSubmit") {
    return async () => {
      const t = task(id);
      return t ? { hookSpecificOutput: { hookEventName: event, additionalContext: t } } : {};
    };
  }

  function part(s: Session): QueryPart | undefined {
    const id = profileOf(s);
    if (!id) return undefined;
    const dir = dirOf(id);
    if (!dir) {
      host.log({ kind: "stop", ev: "profile", word: "no_profile", callsign: s.info.callsign, why: `${id}: профиля нет в клоне — сессия без его части` });
      return undefined;
    }
    const y = yamlOf(dir);
    const settings: Record<string, unknown> = {};
    if (y.model) settings.model = y.model;
    if (y.effort) settings.effortLevel = y.effort;
    if (y.max_effort) settings.maxEffortLevel = y.max_effort;
    if (y.fallback_model) settings.fallbackModel = Array.isArray(y.fallback_model) ? y.fallback_model : [y.fallback_model];
    mkdirSync(memoryOf(dir), { recursive: true });
    settings.autoMemoryDirectory = memoryOf(dir);
    const md = join(dir, "CLAUDE.md");
    return {
      ...(existsSync(md) ? { append: readFileSync(md, "utf8") } : {}),
      settings,
      hooks: {
        PostToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [postTool(id)] }],
        SessionStart: [{ hooks: [nudge(id, "SessionStart")] }],
        UserPromptSubmit: [{ hooks: [nudge(id, "UserPromptSubmit")] }],
      },
    };
  }

  /** Профиль сессии: живой — close() и resume между ходами. */
  function setProfile(s: Session, id: string | null): boolean {
    const was = profileOf(s);
    s.store<Mine>().set({ profile: id });
    const live = s.state !== "stopped" && s.state !== "failed";
    if (was === id || !live) return false;
    void s.restart();
    return true;
  }

  return {
    requests: {
      "session.profile"(f, ctx) {
        const callsign = String(f.callsign ?? "");
        const id = f.profile === null || f.profile === undefined ? null : String(f.profile);
        if (id !== null && !dirOf(id)) throw refuse("no_profile", `${id}: в клонах нет папки профиля с CLAUDE.md или profile.yaml`);
        const s = ctx.host.session(callsign);
        if (!s) {
          // сессия ещё не открыта: профиль — до старта, в query() он уйдёт из session()
          mstore().update((m) => ({ ...m, pending: { ...(m?.pending ?? {}), [callsign]: id } }));
          return { restart: false };
        }
        return { restart: setProfile(s, id) };
      },
      async "machine.profiles"(f) {
        if (f.sync === true) await Promise.all(repos().map((r) => sync(r)));
        const users = new Map<string, string[]>();
        for (const x of host.sessions()) {
          const id = host.session(x.callsign) ? profileOf(host.session(x.callsign)!) : null;
          if (id) users.set(id, [...(users.get(id) ?? []), x.callsign]);
        }
        const profiles: Record<string, unknown> = {};
        const states: Record<string, RepoState> = {};
        for (const repo of repos()) {
          states[repo] = stateOf(repo);
          for (const name of profilesOf(repo)) {
            const id = `${repo}/${name}`;
            const y = yamlOf(join(cloneDir(repo), name));
            profiles[id] = { model: y.model ?? null, effort: y.effort ?? null, sessions: users.get(id) ?? [] };
          }
        }
        return { profiles, repos: states };
      },
    },
    fields: {
      profile: (s) => {
        const id = profileOf(s);
        if (!id) return undefined;
        const p = splitId(id);
        return { id, state: !p || !dirOf(id) ? "error" : stateOf(p.repo).state };
      },
    },
    session(s) {
      const pend = mstore().get()?.pending;
      if (pend && s.info.callsign in pend) {
        s.store<Mine>().set({ profile: pend[s.info.callsign] });
        mstore().update((m) => {
          const pending = { ...(m?.pending ?? {}) };
          delete pending[s.info.callsign];
          return { ...m, pending };
        });
      }
      return part(s);
    },
    start(h) {
      host = h;
      stopping = false;
      timer = setInterval(() => {
        for (const r of repos()) void sync(r);
      }, SYNC_MS);
    },
    async stop() {
      // новую синхронизацию не начинать, идущую — довести
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all([...chains.values()]);
    },
  };
}
