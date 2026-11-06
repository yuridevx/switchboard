// Ключ флота на машине: своя папка рядом с папками слотов — там лежат ссылки на аккаунты. Весь ответ fleetkeys.key: файл токена, env и settings.
// Значение ключа живёт только в файле токена; claude читает его командой apiKeyHelper, в окружение и аргументы он не попадает.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type KeyConfig = { env: Record<string, string>; settings: Record<string, unknown> };
export type KeyAnswer = KeyConfig & { key: string };

const TOKEN = "token";
const CONFIG = "key.json";
/** Прямые косые: путь в команде токена читают и cmd, и bash, и JS-строка. */
const posix = (p: string) => p.split("\\").join("/");

export function keyFolders(home: string) {
  const root = join(home, "fleetkeys");
  const dir = (name: string) => join(root, name);
  const has = (name: string) => existsSync(join(dir(name), CONFIG));

  /** Переписать папку: команда токена может читать файл в этот же момент. */
  function write(name: string, { env, settings, key }: KeyAnswer): void {
    mkdirSync(dir(name), { recursive: true });
    const put = (file: string, text: string) => {
      const tmp = join(dir(name), `${file}.new`);
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, join(dir(name), file));
    };
    put(TOKEN, key);
    put(CONFIG, JSON.stringify({ env, settings }));
  }

  const read = (name: string): KeyConfig | null => (has(name) ? (JSON.parse(readFileSync(join(dir(name), CONFIG), "utf8")) as KeyConfig) : null);
  const remove = (name: string) => rmSync(dir(name), { recursive: true, force: true, maxRetries: 3 });
  const names = () => (existsSync(root) ? readdirSync(root) : []);
  /** Команда токена: claude запускает её оболочкой системы, на Windows это cmd, а под службой cat в PATH нет. Тот же node, что у Host, и прямые косые — работает в обеих оболочках. */
  const helper = (name: string) => `"${posix(process.execPath)}" -p "require('fs').readFileSync('${posix(join(dir(name), TOKEN))}','utf8')"`;

  return { dir, has, write, read, remove, names, helper };
}
