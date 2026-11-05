// Вход прототипа в прод: приглашения клиентов design-<имя> (ссылка в чат) и design-<имя>-shots (браузер снимков сессии) у gate
// пропуском агента; отзыв — keys.revoke у relay. Секрет агента — из файла, никогда не в argv.
//   node scripts/design/pass.mjs close <папка дизайна> [--app pult]   — отозвать пропуска дизайна (закрытие прототипа)
// Пропуск агента: $SWITCHBOARD_DEV_DIR/prod-agent.pass, по умолчанию ~/.switchboard-dev/prod-agent.pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASK_MS = 10_000;

/** Адреса Worker'ов прода из build.json приложения. */
export async function workersOf(app) {
  const url = `https://${app}.pfarm.app/build.json`;
  const list = await fetch(url, { signal: AbortSignal.timeout(ASK_MS) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
    .catch((e) => Promise.reject(Object.assign(new Error(`${url}: ${e.message}`), { word: "no_build" })));
  if (!list.workers?.relay || !list.workers?.gate) throw Object.assign(new Error(`${url}: нет адресов relay и gate`), { word: "no_build" });
  return list.workers;
}

const agentKey = () => fs.readFileSync(path.join(process.env.SWITCHBOARD_DEV_DIR ?? path.join(os.homedir(), ".switchboard-dev"), "prod-agent.pass"), "utf8").trim();

async function post(url, f) {
  const r = await fetch(url, { method: "POST", body: JSON.stringify({ id: `design-${Date.now().toString(36)}`, v: 1, key: agentKey(), ...f }), signal: AbortSignal.timeout(ASK_MS) }).then((x) => x.json());
  if (!r.ok) throw Object.assign(new Error(`${f.type}: ${r.error}${r.why ? ` — ${r.why}` : ""}`), { word: r.error });
  return r.result;
}

/** Имена пропусков дизайна по папке. */
export const namesOf = (dir) => {
  const base = `design-${path.basename(path.resolve(dir))}`;
  return { user: base, shots: `${base}-shots` };
};

/** Отозвать все пропуска дизайна, и принятые, и ждущие приёма. Возвращает отозванные адреса. */
export async function close(workers, dir) {
  const names = Object.values(namesOf(dir));
  const { passes } = await post(workers.gate, { type: "keys.list" });
  const mine = passes.filter((p) => p.role === "client" && names.includes(p.name));
  for (const p of mine) await post(workers.relay, { type: "keys.revoke", kid: p.id });
  return mine.map((p) => p.addr);
}

/** Старые пропуска дизайна отозвать, выдать два новых приглашения: человеку за пультом и браузеру снимков. */
export async function open(workers, dir) {
  const closed = await close(workers, dir);
  const { you } = await post(workers.gate, { type: "keys.list", role: "client" });
  const person = String(you).split("~")[1];
  const names = namesOf(dir);
  const user = await post(workers.gate, { type: "keys.invite", role: "client", name: names.user, person });
  const shots = await post(workers.gate, { type: "keys.invite", role: "client", name: names.shots, person });
  return { closed, user: user.invite, shots: shots.invite };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--app");
  const app = i >= 0 ? args.splice(i, 2)[1] : "pult";
  const [verb, dir] = args;
  if (verb !== "close" || !dir) {
    console.error("нужно: node scripts/design/pass.mjs close <папка дизайна> [--app pult]");
    process.exit(1);
  }
  try {
    const gone = await close(await workersOf(app), dir);
    console.log(`отозвано ${gone.length}: ${gone.join(", ") || "пропусков дизайна нет"}`);
  } catch (e) {
    console.error(`${e.word ?? "error"}: ${e.message}`);
    process.exit(1);
  }
}
