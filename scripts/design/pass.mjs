// Вход страницы во флот: приглашения клиентов design-<имя> (ссылка в чат) и design-<имя>-shots (браузер снимков сессии) у gate
// пропуском агента флота; отзыв — keys.revoke у relay. Секрет агента — из файла, никогда не в argv.
//   node scripts/design/pass.mjs close <папка> [--app pult] [--fleet test]   — отозвать пропуска папки; флот по умолчанию — прод
// Адреса: build.json страницы флота или SWITCHBOARD_WORKERS — одна карта адресов, как у клиента флота.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pageOf, passFile } from "../fleets.ts";

const ASK_MS = 10_000;

/** Адреса Worker'ов флота из build.json приложения. */
export async function workersOf(app, fleet) {
  if (process.env.SWITCHBOARD_WORKERS) return JSON.parse(process.env.SWITCHBOARD_WORKERS);
  const url = new URL("build.json", pageOf(fleet, app)).href;
  const list = await fetch(url, { signal: AbortSignal.timeout(ASK_MS) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
    .catch((e) => Promise.reject(Object.assign(new Error(`${url}: ${e.message}`), { word: "no_build" })));
  if (!list.workers?.relay || !list.workers?.gate) throw Object.assign(new Error(`${url}: нет адресов relay и gate`), { word: "no_build" });
  return list.workers;
}

async function post(url, fleet, f) {
  const key = fs.readFileSync(passFile(fleet), "utf8").trim();
  const r = await fetch(url, { method: "POST", body: JSON.stringify({ id: `design-${Date.now().toString(36)}`, v: 1, key, ...f }), signal: AbortSignal.timeout(ASK_MS) }).then((x) => x.json());
  if (!r.ok) throw Object.assign(new Error(`${f.type}: ${r.error}${r.why ? ` — ${r.why}` : ""}`), { word: r.error });
  return r.result;
}

/** Имена пропусков дизайна по папке. */
export const namesOf = (dir) => {
  const base = `design-${path.basename(path.resolve(dir))}`;
  return { user: base, shots: `${base}-shots` };
};

/** Отозвать все пропуска дизайна, и принятые, и ждущие приёма. Возвращает отозванные адреса. */
export async function close(workers, dir, fleet) {
  const names = Object.values(namesOf(dir));
  const { passes } = await post(workers.gate, fleet, { type: "keys.list", v: 2, kind: "device" });
  const mine = passes.filter((p) => names.includes(p.addr.split("~")[0]));
  for (const p of mine) await post(workers.relay, fleet, { type: "keys.revoke", kid: p.kid });
  return mine.map((p) => p.addr);
}

/** Старые пропуска дизайна отозвать, выдать новые приглашения: человеку за пультом и, если agent, браузеру снимков. */
export async function open(workers, dir, fleet, agent) {
  const closed = await close(workers, dir, fleet);
  const { you } = await post(workers.gate, fleet, { type: "keys.list", v: 2, kind: "machine" });
  const person = String(you).split("~")[1];
  const names = namesOf(dir);
  const invite = (name) => post(workers.gate, fleet, { type: "keys.invite", v: 2, addr: `${name}~${person}` }).then((r) => r.invite);
  return { closed, user: await invite(names.user), shots: agent ? await invite(names.shots) : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, none) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : none; };
  const app = flag("--app", "pult");
  const fleet = flag("--fleet", "prod");
  const [verb, dir] = args;
  if (verb !== "close" || !dir) {
    console.error("нужно: node scripts/design/pass.mjs close <папка> [--app pult] [--fleet test]");
    process.exit(1);
  }
  try {
    const gone = await close(await workersOf(app, fleet), dir, fleet);
    console.log(`отозвано ${gone.length}: ${gone.join(", ") || "пропусков дизайна нет"}`);
  } catch (e) {
    console.error(`${e.word ?? "error"}: ${e.message}`);
    process.exit(1);
  }
}
