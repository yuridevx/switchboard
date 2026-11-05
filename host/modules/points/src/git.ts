// Git точки: сводка папки и снимок своих правок пакетом; при подъёме — проба папки и ветка points-… . Индекс и файлы папки снимок не трогает.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CALL_MS } from "@switchboard/protocol";
import { refuse } from "@switchboard/host";

export type GitSummary = { state: "clean" | "dirty"; files: number; unpushed: number; url?: string; branch?: string; commit: string; snap?: string };
export type Probe = { folder: string; files: number; branch: string | null; sessions: string[] };

/** Имя ссылки внутри пакета: пакеты лежат в R2, это формат хранилища. */
const PACK_REF = "refs/points/snap";
/** Git не спрашивает пароль: спросить некого, запрос только ждал бы предела. */
const QUIET = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

type Run = { code: number; out: string };
const git = (cwd: string, args: string[], env: Record<string, string> = {}): Promise<Run> =>
  new Promise((done) => {
    execFile("git", args, { cwd, env: { ...process.env, ...QUIET, ...env }, windowsHide: true, timeout: CALL_MS, maxBuffer: 1 << 26 }, (e, out, err) => done({ code: e ? 1 : 0, out: e ? String(err) : String(out).trim() }));
  });

const words = (s: string) => s.split("\n").filter(Boolean).length;
const urlKey = (u: string) => u.replace(/\.git$/, "");

function withTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "sb-points-"));
  return work(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Коммит со своими правками: временный индекс, индекс папки цел. */
async function snapshot(cwd: string, head: string): Promise<string> {
  return withTemp(async (dir) => {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    await git(cwd, ["read-tree", head], env);
    await git(cwd, ["add", "-A"], env);
    const tree = await git(cwd, ["write-tree"], env);
    const commit = await git(cwd, ["-c", "user.name=points", "-c", "user.email=points@switchboard", "commit-tree", tree.out, "-p", head, "-m", "снимок точки"]);
    if (commit.code) throw new Error(`снимок git: ${commit.out}`);
    return commit.out;
  });
}

/** Пакет с тем, чего нет на remote: ссылка в refs/points живёт только на время сборки. */
async function bundle(cwd: string, snap: string): Promise<Buffer> {
  return withTemp(async (dir) => {
    const file = join(dir, "git.bundle");
    await git(cwd, ["update-ref", PACK_REF, snap]);
    const made = await git(cwd, ["bundle", "create", file, PACK_REF, "--not", "--remotes"]);
    await git(cwd, ["update-ref", "-d", PACK_REF]);
    if (made.code) throw new Error(`пакет git: ${made.out}`);
    return readFileSync(file);
  });
}

/** Сводка папки сессии; не репозиторий или нет коммитов — точка без git. */
export async function summarize(cwd: string): Promise<{ git: GitSummary; pack?: Buffer } | undefined> {
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  if (head.code) return undefined;
  const commit = head.out;
  const files = words((await git(cwd, ["status", "--porcelain"])).out);
  const unpushed = Number((await git(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"])).out) || 0;
  const remote = await git(cwd, ["remote", "get-url", "origin"]);
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const summary: GitSummary = { state: files ? "dirty" : "clean", files, unpushed, ...(remote.code ? {} : { url: remote.out }), ...(branch.code ? {} : { branch: branch.out }), commit };
  if (!files && !unpushed) return { git: summary };
  const snap = files ? await snapshot(cwd, commit) : commit;
  return { git: { ...summary, snap }, pack: await bundle(cwd, snap) };
}

const branchName = () => {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `points-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
};

/** Что будет с папкой при подъёме. Только читает. */
export async function probe(point: GitSummary | undefined, dir: string, sessions: string[]): Promise<Probe> {
  const none = { files: 0, branch: null, sessions: [] as string[] };
  if (!point) return { folder: "nogit", ...none };
  if (!existsSync(dir)) return { folder: "empty", ...none };
  const url = await git(dir, ["remote", "get-url", "origin"]);
  if (url.code || !point.url || urlKey(url.out) !== urlKey(point.url)) return { folder: "other", ...none };
  const files = words((await git(dir, ["status", "--porcelain"])).out);
  if (sessions.length) return { folder: "shared", files, branch: branchName(), sessions };
  return files ? { folder: "dirty", ...none, files } : { folder: "same", files, branch: branchName(), sessions };
}

/** Папка к подъёму: пустая — клон; свой репозиторий без правок и чужих сессий — ветка от точки с её правками. */
export async function place(point: GitSummary, dir: string, folder: string, pack: Buffer | undefined): Promise<string | null> {
  if (folder !== "empty" && folder !== "same") return null;
  if (folder === "empty") {
    mkdirSync(dirname(dir), { recursive: true });
    const cloned = await git(dirname(dir), ["clone", "-q", point.url ?? "", dir]);
    if (cloned.code) throw refuse("bad_point", `клон ${point.url}: ${cloned.out}`);
  } else {
    await git(dir, ["fetch", "-q", "origin"]);
  }
  const target = point.snap ?? point.commit;
  if (pack) {
    await withTemp(async (tmp) => {
      const file = join(tmp, "git.bundle");
      writeFileSync(file, pack);
      const fetched = await git(dir, ["fetch", "-q", file, PACK_REF]);
      if (fetched.code) throw refuse("bad_point", `пакет git: ${fetched.out}`);
    });
  }
  const branch = branchName();
  const out = await git(dir, ["checkout", "-q", "-b", branch, target]);
  if (out.code) throw refuse("bad_point", `ветка ${branch}: ${out.out}`);
  return branch;
}
