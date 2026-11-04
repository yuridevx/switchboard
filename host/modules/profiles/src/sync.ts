// Память и скилы профилей между машинами: только папки memory/ и skills/, сетевой git — с токеном приложения GitHub
// от Worker github, токен — в окружении git, не в аргументах. Синхронизации репозитория идут по одной.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "@switchboard/host";

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
type Machine = { repos?: Record<string, RepoState> };

/** Папки профиля, которые сводятся между машинами, — со своим словом в коммите. */
const SYNCED = [
  ["memory", "память"],
  ["skills", "скилы"],
] as const;
/** Окружение каждого git: без вопросов человеку — под Host окна ввода нет. */
const QUIET = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const NO_PROMPT = ["-c", "credential.interactive=never"];

const lastLine = (s: string) => s.trim().split("\n").pop();

/** Настоящий git ОС. */
export const realGit: Git = (args, o) =>
  new Promise((done) => {
    execFile("git", args, { cwd: o.cwd, env: { ...process.env, ...o.env }, windowsHide: true, maxBuffer: 16 << 20 }, (e, out, err) => {
      const code = e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0;
      done({ code, out: `${out}${err}` });
    });
  });

export const syncedDirs = () => SYNCED.map(([s]) => s);

export function makeSync(host: () => Host, git: Git) {
  const chains = new Map<string, Promise<void>>();
  let stopping = false;

  const cloneDir = (repo: string) => join(host().dataDir, "profiles", repo.replace("/", "__"));
  const stateOf = (repo: string): RepoState => host().store<Machine>().get()?.repos?.[repo] ?? { state: "ok" };
  const setState = (repo: string, st: RepoState) => host().store<Machine>().update((m) => ({ ...m, repos: { ...(m?.repos ?? {}), [repo]: st } }));
  const inClone = (repo: string, args: string[], env: Record<string, string> = {}) => git([...NO_PROMPT, ...args], { cwd: cloneDir(repo), env: { ...QUIET, ...env } });

  /** Профили клона: папки первого уровня с CLAUDE.md или profile.yaml. */
  function profilesOf(repo: string): string[] {
    const dir = cloneDir(repo);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && (existsSync(join(dir, e.name, "CLAUDE.md")) || existsSync(join(dir, e.name, "profile.yaml"))))
      .map((e) => e.name);
  }

  /** Токен приложения GitHub на репозиторий — заголовок http через окружение git. */
  async function tokenEnv(repo: string): Promise<Record<string, string> | { error: string }> {
    const r = await host().request("github.token", { repo });
    if (!r.ok) return { error: r.error };
    const token = (r.result as { token: string }).token;
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    };
  }

  function fail(repo: string, st: RepoState): void {
    setState(repo, { since: Math.floor(Date.now() / 1000), ...st });
    host().log({ kind: "stop", ev: "sync", repo, word: st.state, why: `${repo}: ${st.op} — ${st.error ?? (st.files ?? []).join(", ")}` });
  }

  async function clone(repo: string): Promise<void> {
    const env = await tokenEnv(repo);
    if ("error" in env) return fail(repo, { state: "error", op: "github.token", error: env.error });
    const parent = join(host().dataDir, "profiles");
    mkdirSync(parent, { recursive: true });
    const r = await git([...NO_PROMPT, "clone", `https://github.com/${repo}.git`, cloneDir(repo)], { cwd: parent, env: { ...QUIET, ...env } });
    if (r.code !== 0) return fail(repo, { state: "error", op: "git clone", error: lastLine(r.out) });
    setState(repo, { state: "ok", last: "clone" });
    host().log({ ev: "sync", repo, why: `${repo}: клон` });
  }

  /** Одна синхронизация: memory/ и skills/ — каждая своим коммитом, токен, pull --no-rebase, push. */
  async function once(repo: string): Promise<void> {
    if (!existsSync(join(cloneDir(repo), ".git"))) return clone(repo);
    for (const [sub, word] of SYNCED) {
      const dirs = profilesOf(repo).map((p) => `${p}/${sub}`).filter((d) => existsSync(join(cloneDir(repo), d)));
      if (!dirs.length) continue;
      const add = await inClone(repo, ["add", "--", ...dirs]);
      if (add.code !== 0) return fail(repo, { state: "error", op: "git add", error: add.out.trim() });
      const diff = await inClone(repo, ["diff", "--cached", "--quiet"]);
      if (diff.code === 0) continue;
      const commit = await inClone(repo, ["commit", "-m", `${word}: ${host().machine} ${new Date().toTimeString().slice(0, 5)}`]);
      if (commit.code !== 0) return fail(repo, { state: "error", op: "git commit", error: commit.out.trim() });
    }
    const env = await tokenEnv(repo);
    if ("error" in env) return fail(repo, { state: "error", op: "github.token", error: env.error });
    const pull = await inClone(repo, ["pull", "--no-rebase", "--no-edit"], env);
    if (pull.code !== 0) {
      if (!/CONFLICT/.test(pull.out)) return fail(repo, { state: "error", op: "git pull --no-rebase", error: lastLine(pull.out) });
      const files = (await inClone(repo, ["diff", "--name-only", "--diff-filter=U"])).out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      return fail(repo, { state: "conflict", op: "git pull --no-rebase", files, error: pull.out.trim().split("\n")[0] });
    }
    const push = await inClone(repo, ["push"], env);
    if (push.code !== 0) return fail(repo, { state: "error", op: "git push", error: lastLine(push.out) });
    const last = (await inClone(repo, ["log", "-1", "--format=%s"])).out.trim();
    const was = stateOf(repo).state;
    setState(repo, { state: "ok", ...(last ? { last } : {}) });
    if (was !== "ok") host().log({ ev: "sync", repo, why: `${repo}: память сведена — ok` });
  }

  return {
    cloneDir,
    stateOf,
    profilesOf,
    /** Синхронизация репозитория; идёт другая — после неё. Остановка — новую не начинать. */
    sync(repo: string): Promise<void> {
      const tail = (chains.get(repo) ?? Promise.resolve())
        .then(() => (stopping ? undefined : once(repo)))
        .catch((e) => fail(repo, { state: "error", op: "sync", error: (e as Error).message }));
      chains.set(repo, tail);
      return tail;
    },
    /** Новую синхронизацию не начинать, идущую — довести. */
    async stop() {
      stopping = true;
      await Promise.all(chains.values());
    },
    begin() {
      stopping = false;
    },
  };
}
