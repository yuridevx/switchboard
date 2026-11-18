// Войти в аккаунт ChatGPT и записать вход ключом флота: node tools/fleet/key-chatgpt.ts <флот> <устройство> [имя ключа]
// Вход делает Codex CLI в своей временной папке: вход флота не делит обновления с личным Codex этого компьютера.
// В ключ идёт одна строка — refresh-токен; служба ключей сразу меняет его у OpenAI и дальше обновляет вход сама. Значение не печатается; папка входа удаляется.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApi, httpTransport, keysSet } from "@sb/protocol";
import { dev, fleetEnv } from "../dev.mjs";

const [fleet = "test", device = "cli", name = "chatgpt"] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dev, `v2-${fleet}-${device}.pass`), "utf8").trim();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sb2-chatgpt-"));
try {
  // вход — в файл папки, а не в хранилище паролей системы: оттуда его не взять
  fs.writeFileSync(path.join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  // браузер открывает сам Codex; окно входа и его слова — человеку
  const login = spawnSync("codex", ["login"], { stdio: "inherit", shell: true, env: { ...process.env, CODEX_HOME: home } });
  if (login.status !== 0) throw new Error(`codex login вышел с кодом ${login.status}: вход не сделан`);
  const refresh = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")).tokens?.refresh_token;
  if (!refresh) throw new Error("в файле входа Codex нет refresh-токена: вход не через ChatGPT");
  await createApi(httpTransport({ base: fleetEnv.SB2_BASE!, key })).call(keysSet, { name, protocol: "chatgpt", value: refresh });
  console.log(`ключ флота ${name} записан: протокол chatgpt`);
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
}
