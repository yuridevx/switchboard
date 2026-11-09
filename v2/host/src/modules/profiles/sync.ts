// Кусочки между машинами: весь клон с учётом .gitignore, git и токен приложения GitHub. Токен — в окружении команды, не в аргументах.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CALL_MS, within } from "@sb/protocol";

type Run = { code: number; out: string };
export type Git = (args: string[], o: { cwd: string; env: Record<string, string> }) => Promise<Run>;
/** wait — машина ещё не сводила этот репозиторий; dir — клон; at — последнее сведение, мс. */
export type RepoState = { state: "ok" | "wait" | "conflict" | "error"; op?: string; files?: string[]; error?: string; dir?: string; at?: number };

/** Настоящий git с пределом на команду: процесс убит, а его потомок может держать вывод — ответа не ждём. */
export const gitWithin = (ms: number): Git => (args, o) => {
  const late = `git не ответил за ${ms / 1000} с`;
  return within(
    new Promise((done, fail) => {
      execFile("git", args, { cwd: o.cwd, env: { ...process.env, ...o.env }, windowsHide: true, maxBuffer: 16 << 20, timeout: ms }, (e, out, err) => {
        if ((e as { killed?: boolean } | null)?.killed) return fail(new Error(late));
        done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${out}${err}` });
      });
    }),
    ms,
    late,
  );
};

export const realGit = gitWithin(CALL_MS);

const NEVER_ASK = ["-c", "credential.interactive=never"];
/** Шаг, на котором синхронизация встала. */
class Stuck extends Error {
  readonly op: string;
  constructor(op: string, word: string) {
    super(word);
    this.op = op;
  }
}

const auth = (token: string) => ({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
});

/** Одно сведение: коммит всего клона, затем общая сеть; нет клона — клон. Идёт слияние — его сводит сессия, клон не трогаем: git add завершил бы слияние с метками. token — запрос к github. */
export async function syncRepo(git: Git, repo: string, clone: string, machine: string, token: () => Promise<string>, note: (why: string) => void): Promise<RepoState> {
  const run = async (op: string, cwd: string, args: string[], env: Record<string, string> = {}) => {
    const r = await git([...NEVER_ASK, ...args], { cwd, env: { GIT_TERMINAL_PROMPT: "0", ...env } });
    if (r.code !== 0 && op) throw new Stuck(op, r.out.trim());
    return r;
  };
  const pass = async () => {
    try {
      return auth(await token());
    } catch (e) {
      throw new Stuck("github.token", (e as Error).message);
    }
  };
  const conflict = async (): Promise<RepoState> => ({ state: "conflict", op: "git pull --no-rebase", files: (await run("", clone, ["diff", "--name-only", "--diff-filter=U"])).out.split("\n").filter(Boolean) });

  try {
    if (!existsSync(join(clone, ".git"))) {
      const env = await pass();
      mkdirSync(dirname(clone), { recursive: true });
      await run("git clone", dirname(clone), ["clone", `https://github.com/${repo}.git`, clone], env);
      note(`${repo}: клон`);
      return { state: "ok" };
    }
    if (existsSync(join(clone, ".git", "MERGE_HEAD"))) return await conflict();
    await run("git add", clone, ["add", "-A"]);
    if ((await run("", clone, ["diff", "--cached", "--quiet"])).code !== 0) await run("git commit", clone, ["commit", "-m", `сведение: ${machine} ${new Date().toTimeString().slice(0, 5)}`]);
    const env = await pass();
    const pull = await run("", clone, ["pull", "--no-rebase", "--no-edit"], env);
    if (pull.code !== 0) {
      if (!/CONFLICT/.test(pull.out)) throw new Stuck("git pull --no-rebase", pull.out.trim());
      return await conflict();
    }
    await run("git push", clone, ["push"], env);
    return { state: "ok" };
  } catch (e) {
    return { state: "error", op: e instanceof Stuck ? e.op : "sync", error: (e as Error).message };
  }
}
