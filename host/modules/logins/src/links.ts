// Папки аккаунтов и ссылки слотов. Имя папки — почта. Кто в слоте, знает только ссылка на диске. Новый вход идёт в пустой папке .new и ложится в папку почты, когда она известна.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { refuse } from "@switchboard/host";

/** Имена самого claude: файл входа и блокировка его обновления (опыт 1 нояб.). */
const CREDENTIALS = ".credentials.json";
const REFRESH_LOCK = ".oauth_refresh.lock";
/** Свою блокировку claude держит меньше секунды. */
const LOCK_WAIT_MS = 10_000;
const LOCK_STEP_MS = 100;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function folders(home: string) {
  const accDir = (email: string) => join(home, "accounts", email);
  const newDir = join(home, "accounts", ".new");
  const slotDir = (slot: string) => join(home, "slots", slot);

  /** Кто в слоте: битая ссылка, обычная папка и пустое место — никто. */
  function inSlot(slot: string): string | null {
    const dir = slotDir(slot);
    try {
      const target = basename(readlinkSync(dir));
      return existsSync(dir) ? target : null;
    } catch {
      return null;
    }
  }

  /** Обновление входа и подмена не должны идти разом: папка блокировки — та, что понимает claude. Папки аккаунта нет — и входа нет. */
  async function locked<T>(name: string | null, work: () => T): Promise<T> {
    if (!name || !existsSync(accDir(name))) return work();
    const lock = join(accDir(name), REFRESH_LOCK);
    const end = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() >= end) throw refuse("refresh_locked", `${name}: claude обновляет вход дольше ${LOCK_WAIT_MS / 1000} с; повторите запрос`);
        await pause(LOCK_STEP_MS);
      }
    }
    try {
      return work();
    } finally {
      rmdirSync(lock);
    }
  }

  /** Снять ссылку или пустую папку; папка с файлами остаётся и не даёт поставить ссылку. */
  function clear(dir: string): void {
    const on = lstatSync(dir, { throwIfNoEntry: false });
    if (!on) return;
    if (on.isSymbolicLink()) return unlinkSync(dir);
    if (readdirSync(dir).length) throw refuse("slot_dir_busy", `${dir}: на месте ссылки слота папка с файлами`);
    rmdirSync(dir);
  }

  /** Поставить аккаунт в слот; блокировка — того, кто уходит. Вошёл ли он, знает его запись. */
  async function place(slot: string, name: string): Promise<void> {
    const dir = slotDir(slot);
    try {
      await locked(inSlot(slot), () => {
        clear(dir);
        mkdirSync(dirname(dir), { recursive: true });
        symlinkSync(accDir(name), dir, process.platform === "win32" ? "junction" : "dir");
      });
    } catch (e) {
      const r = e as { word?: string; why?: string };
      if (r.word !== "slot_dir_busy") throw e;
      throw refuse(r.word, `${slot}: ${name} не встал в слот — ${r.why}`);
    }
  }

  /** Файл входа из .new — в папку почты, под блокировкой её обновления: новая и известная почта идут одним путём. */
  async function settle(email: string): Promise<void> {
    mkdirSync(accDir(email), { recursive: true });
    try {
      await locked(email, () => renameSync(join(newDir, CREDENTIALS), join(accDir(email), CREDENTIALS)));
    } catch (e) {
      if ((e as { word?: string }).word) throw e;
      throw refuse("account_dir_busy", `${email}: файл входа занят — ${(e as Error).message}; войдите заново`);
    }
  }

  /** Стереть папку идущего входа: при старте, при остановке, перед новым входом и после него. */
  const clearNew = () => rmSync(newDir, { recursive: true, force: true, maxRetries: 3 });

  const unplace = (slot: string) => locked(inSlot(slot), () => clear(slotDir(slot)));

  return { accDir, newDir, slotDir, inSlot, place, unplace, settle, clearNew };
}

/** Окружение короткого процесса Claude: обе папки заданы явно, вход и конфиг — в одной. */
export const envOf = (dir: string) => ({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir });

export type Folders = ReturnType<typeof folders>;
