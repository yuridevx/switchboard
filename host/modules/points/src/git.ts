// Git точки: снимок папки в пакет и папка подъёма. Индекс и ссылки папки снимок не меняет; git не спрашивает пароль.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refuse } from "@switchboard/host";
import { CALL_MS } from "@switchboard/protocol";

/** Сводка git в строке точки. snap — коммит пакета: правки поверх commit или неотправленный commit. */
export type Summary = { state: "clean" | "dirty"; files: number; unpushed: number; url?: string; branch?: string; commit: string; snap?: string };
export type Folder = { folder: "nogit" | "empty" | "other" | "same" | "dirty" | "shared"; files: number; branch: string | null; sessions: string[] };

export const BUNDLE = "git.bundle";
const REF = "refs/points/snap";

const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  new Promise<string>((done, fail) => {
    execFile("git", args, { cwd, timeout: CALL_MS, maxBuffer: 1 << 26, windowsHide: true, env: { ...process.env, GCM_INTERACTIVE: "never", GIT_TERMINAL_PROMPT: "0", ...env } }, (e, out) => (e ? fail(e) : done(out)));
  });
const quiet = (cwd: string, args: string[]) => git(cwd, args).then((x) => x.trim(), () => null);
const changed = async (cwd: string) => (await git(cwd, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
const repoKey = (url: string) => url.replace(/\.git$/, "");

/** Сводка папки и пакет, если в ней есть то, чего нет на remote; папка не под git — ничего. */
export async function snapshot(cwd: string): Promise<{ summary: Summary; bundle?: Buffer } | undefined> {
  const commit = await quiet(cwd, ["rev-parse", "HEAD"]);
  if (!commit) return undefined;
  const files = await changed(cwd);
  const unpushed = Number(await git(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]));
  const url = await quiet(cwd, ["remote", "get-url", "origin"]);
  const branch = await quiet(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const summary: Summary = { state: files ? "dirty" : "clean", files, unpushed, ...(url === null ? {} : { url }), ...(branch === null ? {} : { branch }), commit };
  if (!files && !unpushed) return { summary };
  const tmp = mkdtempSync(join(tmpdir(), "sb-point-"));
  try {
    const snap = files ? await commitOfChanges(cwd, commit, join(tmp, "index")) : commit;
    await git(cwd, ["update-ref", REF, snap]);
    const file = join(tmp, BUNDLE);
    await git(cwd, ["bundle", "create", file, REF, "--not", "--remotes"]).finally(() => git(cwd, ["update-ref", "-d", REF]));
    return { summary: { ...summary, snap }, bundle: readFileSync(file) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Коммит правок поверх HEAD из своего индекса: индекс папки не меняется. */
async function commitOfChanges(cwd: string, head: string, index: string): Promise<string> {
  const env = { GIT_INDEX_FILE: index };
  await git(cwd, ["read-tree", head], env);
  await git(cwd, ["add", "-A"], env).catch(() => {}); // файл, который git не берёт, не держит точку разговора: в снимке то, что встало
  const tree = (await git(cwd, ["write-tree"], env)).trim();
  return (await git(cwd, ["-c", "user.name=points", "-c", "user.email=points@switchboard", "commit-tree", tree, "-p", head, "-m", "снимок точки"])).trim();
}

const two = (n: number) => String(n).padStart(2, "0");
function branchName(): string {
  const d = new Date();
  return `points-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
}

/** Что будет с папкой подъёма; sessions — другие сессии в ней. */
export async function folderOf(dir: string, summary: Summary | undefined, sessions: string[]): Promise<Folder> {
  const plain = { files: 0, branch: null, sessions: [] };
  if (!summary) return { folder: "nogit", ...plain };
  if (!existsSync(dir)) return { folder: "empty", ...plain };
  const url = await quiet(dir, ["remote", "get-url", "origin"]);
  if (url === null || !summary.url || repoKey(url) !== repoKey(summary.url)) return { folder: "other", ...plain };
  const files = await changed(dir);
  if (sessions.length) return { folder: "shared", files, branch: branchName(), sessions };
  return files ? { folder: "dirty", ...plain, files } : { folder: "same", files, branch: branchName(), sessions };
}

/** Папка точки: клон в пустую, ветка от коммита точки в том же репозитории без правок и чужих сессий; пакет — поверх. Ответ — имя ветки. */
export async function bring(dir: string, summary: Summary, folder: "empty" | "same", bundle: Buffer | undefined): Promise<string> {
  const branch = branchName();
  const tmp = mkdtempSync(join(tmpdir(), "sb-point-"));
  try {
    if (folder === "empty") {
      mkdirSync(dirname(dir), { recursive: true });
      await git(dirname(dir), ["clone", "-q", summary.url ?? "", dir]);
    } else await quiet(dir, ["fetch", "-q", "origin"]); // нет связи с origin — коммит точки мог быть на месте: скажет checkout
    const target = summary.snap ?? summary.commit;
    if (bundle) {
      const file = join(tmp, BUNDLE);
      writeFileSync(file, bundle);
      await git(dir, ["fetch", "-q", file, REF]);
    }
    await git(dir, ["checkout", "-q", "-b", branch, target]);
    return branch;
  } catch (e) {
    throw refuse("bad_point", `папка ${dir}: ${e}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
