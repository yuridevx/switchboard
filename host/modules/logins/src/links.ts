// Слот на диске — ссылка на папку аккаунта: junction на Windows, symlink на Linux. Кто в слоте — сама ссылка, больше нигде.
// Перевешивает под блокировкой обновления входа claude: он держит её на время обновления (опыт 1 ноя: ~0,7 с).
import { lstatSync, mkdirSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { refuse } from "@switchboard/host";

/** Файл входа claude в папке Claude. */
export const CREDENTIALS = ".credentials.json";
/** Блокировка обновления входа claude — папка рядом с файлом входа. */
const REFRESH_LOCK = ".oauth_refresh.lock";
/** Сколько ждать, пока claude обновляет вход: свою блокировку он держит меньше секунды. */
const LOCK_WAIT_MS = 10_000;

const statOf = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

export const exists = (p: string) => statOf(p) !== null;

/** Убрать ссылку слота или пустую папку на её месте. Папка аккаунта за ссылкой не трогается. */
export function unlink(p: string): void {
  const st = statOf(p);
  if (!st) return;
  if (st.isSymbolicLink()) {
    try {
      unlinkSync(p);
    } catch {
      rmdirSync(p); // junction на Windows
    }
  } else if (st.isDirectory()) {
    try {
      rmdirSync(p);
    } catch {
      throw refuse("slot_dir_busy", `${p}: на месте ссылки слота папка с файлами`);
    }
  } else unlinkSync(p);
}

/** Ссылка на папку: Windows — junction заново (rename поверх — EPERM); Linux — symlink во временное имя и rename, атомарно. */
export function link(slot: string, target: string): void {
  mkdirSync(dirname(slot), { recursive: true });
  if (process.platform === "win32") {
    unlink(slot);
    symlinkSync(target, slot, "junction");
    return;
  }
  if (!statOf(slot)?.isSymbolicLink()) unlink(slot);
  const tmp = `${slot}.link`;
  unlink(tmp);
  symlinkSync(target, tmp);
  renameSync(tmp, slot);
}

/** Куда ведёт ссылка; не ссылка или её нет — null. */
export const targetOf = (p: string) => (statOf(p)?.isSymbolicLink() ? resolve(dirname(p), readlinkSync(p)) : null);

/** fn под блокировкой обновления входа в папке dir. Держит её claude дольше предела — refresh_locked. */
export async function underRefreshLock<T>(dir: string, fn: () => T): Promise<T> {
  const lock = join(dir, REFRESH_LOCK);
  const end = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() >= end) throw refuse("refresh_locked", `${dir}: claude обновляет вход дольше ${LOCK_WAIT_MS / 1000} с`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}
