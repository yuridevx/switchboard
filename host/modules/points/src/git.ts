// Снимок git рабочей папки и подъём правок точки. Рабочие файлы, индекс и stash папки не трогаются:
// свои правки — коммитом из временного индекса, вместе с неотправленными коммитами — пакетом git bundle.
// Подъём ветку назад не двигает: правки точки встают на новую ветку points-<дата-время>.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Git = (args: string[], o: { cwd: string; env?: Record<string, string> }) => Promise<{ code: number; out: string }>;

/** Сводка git в точке. snap — коммит правок из временного индекса. */
export type GitSummary = {
  state: "clean" | "dirty";
  files: number;
  unpushed: number;
  url: string;
  branch: string;
  commit: string;
  snap?: string;
};

/** Что будет с папкой на подъёме. */
export type Folder = "same" | "nogit" | "empty" | "other" | "shared" | "dirty";

const QUIET = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
const WHO = { GIT_AUTHOR_NAME: "switchboard", GIT_AUTHOR_EMAIL: "points@switchboard", GIT_COMMITTER_NAME: "switchboard", GIT_COMMITTER_EMAIL: "points@switchboard" };
/** Ссылка пакета: в пакете — снимок; на подъёме — временная ссылка в папке цели. */
const SNAP_REF = "refs/points/snap";
const RAISE_REF = "refs/points/raise";
/** Пакет git — файл точки с этим путём; в папку проекта не кладётся. */
export const BUNDLE = "git.bundle";

export const realGit: Git = (args, o) =>
  new Promise((res) => {
    execFile("git", args, { cwd: o.cwd, env: { ...process.env, ...QUIET, ...(o.env ?? {}) }, windowsHide: true, maxBuffer: 64 << 20 }, (e, out, err) => {
      const code = e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0;
      res({ code, out: `${out}${err}`.trim() });
    });
  });

const lines = (s: string) => s.split(/\r?\n/).filter((x) => x.trim());

/** Сводка и, если есть свои правки или неотправленные коммиты, пакет. Не репозиторий — null. */
export async function snapshot(git: Git, cwd: string): Promise<{ summary: GitSummary; bundle: string | null; cleanup: () => void } | null> {
  if (!existsSync(cwd)) return null;
  const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd });
  if (inside.code !== 0 || inside.out !== "true") return null;
  const head = await git(["rev-parse", "HEAD"], { cwd });
  if (head.code !== 0) return null; // репозиторий без коммитов
  const commit = head.out;
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).out;
  const url = (await git(["config", "--get", "remote.origin.url"], { cwd })).out;
  const files = lines((await git(["status", "--porcelain"], { cwd })).out).length;
  const up = await git(["rev-list", "--count", "HEAD", "--not", "--remotes"], { cwd });
  const unpushed = up.code === 0 ? Number(up.out) || 0 : 0;
  const summary: GitSummary = { state: files ? "dirty" : "clean", files, unpushed, url, branch, commit };
  const none = { summary, bundle: null, cleanup: () => {} };
  if (!files && !unpushed) return none;

  const tmp = mkdtempSync(join(tmpdir(), "points-git-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    let snap = commit;
    if (files) {
      // временный индекс: индекс папки не трогается
      const env = { GIT_INDEX_FILE: join(tmp, "index"), ...WHO };
      if ((await git(["read-tree", "HEAD"], { cwd, env })).code !== 0) throw new Error("read-tree");
      if ((await git(["add", "--all", "--", "."], { cwd, env })).code !== 0) throw new Error("add во временный индекс");
      const tree = await git(["write-tree"], { cwd, env });
      const c = await git(["commit-tree", tree.out, "-p", commit, "-m", "points: правки точки"], { cwd, env });
      if (tree.code !== 0 || c.code !== 0) throw new Error("commit-tree");
      snap = c.out;
    }
    summary.snap = snap;
    const bundle = join(tmp, BUNDLE);
    await git(["update-ref", SNAP_REF, snap], { cwd });
    const b = await git(["bundle", "create", bundle, SNAP_REF, "--not", "--remotes"], { cwd });
    await git(["update-ref", "-d", SNAP_REF], { cwd });
    if (b.code !== 0) throw new Error(`bundle: ${b.out}`);
    return { summary, bundle, cleanup };
  } catch {
    cleanup();
    return none;
  }
}

/** Что будет с папкой dir: проверка без изменений. */
export async function folderOf(git: Git, g: GitSummary | undefined, dir: string, live: string[]): Promise<{ folder: Folder; files: number; branch: string | null; sessions: string[] }> {
  const out = (folder: Folder, files = 0, branch: string | null = null) => ({ folder, files, branch, sessions: live });
  if (!g) return out("nogit");
  if (!existsSync(dir)) return out("empty");
  const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  if (inside.code !== 0) return out("other");
  const url = (await git(["config", "--get", "remote.origin.url"], { cwd: dir })).out;
  if (url !== g.url) return out("other");
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })).out || null;
  if (live.length) return out("shared", 0, branch);
  const files = lines((await git(["status", "--porcelain"], { cwd: dir })).out).length;
  if (files) return out("dirty", files, branch);
  return out("same", 0, branch);
}

export const branchName = (now = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `points-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
};

/** Правки точки — на новую ветку от её коммита: папки нет — клон; коммиты не с удалённого — из пакета. */
export async function apply(git: Git, g: GitSummary, dir: string, folder: Folder, bundle: string | null): Promise<string> {
  if (folder === "empty") {
    const c = await git(["clone", g.url, dir], { cwd: tmpdir() });
    if (c.code !== 0) throw new Error(`git clone: ${c.out}`);
  } else {
    await git(["fetch", "origin"], { cwd: dir });
  }
  let target = g.commit;
  if (bundle) {
    const f = await git(["fetch", bundle, `+${SNAP_REF}:${RAISE_REF}`], { cwd: dir });
    if (f.code !== 0) throw new Error(`git fetch пакета: ${f.out}`);
    target = RAISE_REF;
  }
  const branch = branchName();
  const co = await git(["checkout", "-b", branch, target], { cwd: dir });
  if (bundle) await git(["update-ref", "-d", RAISE_REF], { cwd: dir });
  if (co.code !== 0) throw new Error(`git checkout: ${co.out}`);
  return branch;
}
