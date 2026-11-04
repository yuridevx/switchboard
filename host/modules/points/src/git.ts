// Git в точке: снимок рабочей папки и подъём правок. Рабочие файлы, индекс и stash папки не трогаются.
// Свои правки — коммит из временного индекса; вместе с неотправленными коммитами — пакет git bundle.
// Подъём ветку назад не двигает: правки точки встают на новую ветку points-<дата-время>.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GitSummary = { state: "clean" | "dirty"; files: number; unpushed: number; url: string; branch: string; commit: string; snap?: string };
export type Folder = "same" | "nogit" | "empty" | "other" | "shared" | "dirty";
export type FolderCheck = { folder: Folder; files: number; branch: string | null; sessions: string[] };
type Snapshot = { summary: GitSummary; bundle: string | null; cleanup: () => void };

/** Имя файла точки с пакетом; в папку проекта он не кладётся. */
export const BUNDLE = "git.bundle";
const SNAP_REF = "refs/points/snap";
const RAISE_REF = "refs/points/raise";
const AUTHOR = { GIT_AUTHOR_NAME: "switchboard", GIT_AUTHOR_EMAIL: "points@switchboard", GIT_COMMITTER_NAME: "switchboard", GIT_COMMITTER_EMAIL: "points@switchboard" };

/** git без вопросов человеку; код и общий вывод. */
function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...env }, windowsHide: true, maxBuffer: 64 << 20 }, (e, out, err) => {
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${out}${err}`.trim() });
    });
  });
}
const countLines = (s: string) => s.split(/\r?\n/).filter((x) => x.trim()).length;

/** Коммит правок из временного индекса и пакет с ним. Сбой — точка без пакета: сводка важнее. */
async function bundleOf(cwd: string, commit: string, dirty: boolean, summary: GitSummary): Promise<Snapshot> {
  const tmp = mkdtempSync(join(tmpdir(), "points-git-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    let snap = commit;
    if (dirty) {
      const env = { GIT_INDEX_FILE: join(tmp, "index"), ...AUTHOR };
      if ((await git(cwd, ["read-tree", "HEAD"], env)).code) throw new Error("read-tree");
      if ((await git(cwd, ["add", "--all", "--", "."], env)).code) throw new Error("add во временный индекс");
      const tree = await git(cwd, ["write-tree"], env);
      const made = await git(cwd, ["commit-tree", tree.out, "-p", commit, "-m", "points: правки точки"], env);
      if (tree.code || made.code) throw new Error("commit-tree");
      snap = made.out;
    }
    summary.snap = snap;
    const bundle = join(tmp, BUNDLE);
    await git(cwd, ["update-ref", SNAP_REF, snap]);
    const packed = await git(cwd, ["bundle", "create", bundle, SNAP_REF, "--not", "--remotes"]);
    await git(cwd, ["update-ref", "-d", SNAP_REF]);
    if (packed.code) throw new Error(`bundle: ${packed.out}`);
    return { summary, bundle, cleanup };
  } catch {
    cleanup();
    return { summary, bundle: null, cleanup: () => {} };
  }
}

/** Снимок папки; не репозиторий или нет коммитов — null. */
export async function snapshot(cwd: string): Promise<Snapshot | null> {
  if (!existsSync(cwd)) return null;
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code || inside.out !== "true") return null;
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  if (head.code) return null;
  const files = countLines((await git(cwd, ["status", "--porcelain"])).out);
  const ahead = await git(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  const unpushed = ahead.code ? 0 : Number(ahead.out) || 0;
  const summary: GitSummary = {
    state: files ? "dirty" : "clean",
    files,
    unpushed,
    url: (await git(cwd, ["config", "--get", "remote.origin.url"])).out,
    branch: (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).out,
    commit: head.out,
  };
  if (!files && !unpushed) return { summary, bundle: null, cleanup: () => {} };
  return bundleOf(cwd, head.out, files > 0, summary);
}

/** Что будет с папкой на подъёме: только чтение. */
export async function checkFolder(g: GitSummary | undefined, dir: string, sessions: string[]): Promise<FolderCheck> {
  const result = (folder: Folder, files = 0, branch: string | null = null): FolderCheck => ({ folder, files, branch, sessions });
  if (!g) return result("nogit");
  if (!existsSync(dir)) return result("empty");
  if ((await git(dir, ["rev-parse", "--is-inside-work-tree"])).code) return result("other");
  if ((await git(dir, ["config", "--get", "remote.origin.url"])).out !== g.url) return result("other");
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).out || null;
  if (sessions.length) return result("shared", 0, branch);
  const files = countLines((await git(dir, ["status", "--porcelain"])).out);
  return files ? result("dirty", files, branch) : result("same", 0, branch);
}

function branchName(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `points-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

/** Правки точки — на новую ветку от её коммита: папки нет — клон; коммиты не с удалённого — из пакета. */
export async function applyToFolder(g: GitSummary, dir: string, folder: Folder, bundle: string | null): Promise<string> {
  if (folder === "empty") {
    const cloned = await git(tmpdir(), ["clone", g.url, dir]);
    if (cloned.code) throw new Error(`git clone: ${cloned.out}`);
  } else await git(dir, ["fetch", "origin"]);
  if (bundle) {
    const fetched = await git(dir, ["fetch", bundle, `+${SNAP_REF}:${RAISE_REF}`]);
    if (fetched.code) throw new Error(`git fetch пакета: ${fetched.out}`);
  }
  const branch = branchName();
  const out = await git(dir, ["checkout", "-b", branch, bundle ? RAISE_REF : g.commit]);
  if (bundle) await git(dir, ["update-ref", "-d", RAISE_REF]);
  if (out.code) throw new Error(`git checkout: ${out.out}`);
  return branch;
}
