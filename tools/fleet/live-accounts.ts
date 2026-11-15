// Живая проверка аккаунтов и моделей: node tools/fleet/live-accounts.ts [флот] [устройство] [машина]
// Нужен хотя бы один аккаунт Claude — ключ флота с протоколом claude. Модель сессий — SB2_CLAUDE_MODEL или самая дешёвая из каталога (Haiku).
// Шаги: каталог Claude; ход без входа и час кэша; строки журнала вызова — на машине и в ClickHouse; негодный токен — переход без обрыва хода;
// «/model слова» сообщением; модель провайдера из каталога. Свой негодный аккаунт сценарий заводит и убирает сам.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountList, CallError, CLAUDE, createApi, fleetList, httpTransport, keysList, keysModels, keysRemove, keysSet, logQuery, machineJournal, message, sessionOpen, sessionRemove, type SessionRow } from "@sb/protocol";
import { fleetEnv } from "../dev.mjs";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = fleetEnv;
const [fleet = "test", device = "cli", machine = "devbox"] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const wire = httpTransport({ base: env.SB2_BASE!, key });
const api = createApi({ ...wire, call: async (f) => { for (let i = 0; ; i++) { const r = await wire.call(f); if (r.ok || r.error !== "offline" || i >= 4) return r; await new Promise((x) => setTimeout(x, 3000)); } } });
const tag = Date.now().toString(36).slice(-4);
const cwd = machine === "wsl" ? `/tmp/sb2-accounts-${tag}` : `C:/Users/${os.userInfo().username}/AppData/Local/Temp/sb2-accounts-${tag}`;
/** Свой негодный аккаунт сценария: токен не настоящий. */
const BOGUS = `bogus-${tag}@example.com`;
const PROMPT = "Ответь одним словом: ok";

let bad = 0, total = 0;
const made: string[] = [];
async function step(label: string, fn: () => Promise<string>) {
  total++;
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${e instanceof CallError ? `${e.word}: ${e.why ?? ""}` : (e as Error).message.split("\n")[0]}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowOf = async (cs: string): Promise<SessionRow | undefined> => ((await api.call(fleetList, { machine, full: true })).sessions as SessionRow[]).find((s) => s.callsign === cs);
async function until<T>(what: string, fn: () => Promise<T | undefined | false | null>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`не дождался: ${what}`);
    await sleep(1500);
  }
}
/** Сессия ответила: свободна и в строке есть начало ответа. */
const answered = (cs: string) => until(`${cs} ответила`, async () => { const r = await rowOf(cs); return r?.state === "idle" && r.result ? r : r?.state === "failed" ? Promise.reject(new Error(`${cs}: сбой — ${r.error}`)) : undefined; }, 240_000);
const open = async (name: string, doc: { key: string; model: string }, prompt = PROMPT) => {
  const r = await api.call(sessionOpen, { to: "@" + machine, spec: { name: `${name}-${tag}`, cwd, ...doc }, mkdir: true, prompt });
  made.push(r.callsign);
  return r.callsign;
};
const journal = async (msg: string, session: string) => (await api.call(machineJournal, { to: "@" + machine, session, limit: 200 })).lines.filter((l) => l.msg === msg) as Array<Record<string, unknown>>;

let models: Array<{ id: string; family?: string; window?: number }> = [];
let cheap = "";
let real: string[] = [];

await step("каталог Claude по токену аккаунта: модели с семейством и окном", async () => {
  real = (await api.call(keysList, {})).keys.filter((k) => k.protocol === CLAUDE).map((k) => k.name);
  if (!real.length) throw new Error("у флота нет аккаунта Claude: keys.set { name: почта, protocol: claude, value: токен }");
  models = (await api.call(keysModels, { name: CLAUDE })).models;
  cheap = process.env.SB2_CLAUDE_MODEL ?? models.find((m) => /haiku/i.test(m.id))?.id ?? "";
  if (!cheap) throw new Error("в каталоге нет Haiku: назовите модель в SB2_CLAUDE_MODEL");
  if (models.some((m) => !m.family || !m.window)) throw new Error("модель без семейства или окна: " + JSON.stringify(models.find((m) => !m.family || !m.window)));
  return `моделей ${models.length}, аккаунтов ${real.length}; сессии сценария — ${cheap}`;
});

let first = "";
await step("ход без входа: сессия ответила на аккаунте, который выбрала машина; кэш разговора часовой", async () => {
  first = await open("acc", { key: CLAUDE, model: cheap });
  const row = await answered(first);
  if (!row.account || !real.includes(row.account)) throw new Error("аккаунт в строке: " + row.account);
  if (row.answers) throw new Error(`ответила ${row.answers}, а в документе ${row.spec.model}`);
  const left = row.cache ? Math.round((row.cache.until - Date.now()) / 60_000) : -1;
  if (left < 50 || left > 61) throw new Error(`час кэша: осталось ${left} мин — ждали около 60`);
  const list = (await api.call(accountList, { to: "@" + machine })).accounts.find((a) => a.name === row.account);
  if (!list?.ok || !list.limits.some((l) => l.name === "seven_day")) throw new Error("окна аккаунта из заголовков: " + JSON.stringify(list));
  return `${row.account}: кэш тёплый ещё ${left} мин; неделя ${Math.round((list.limits.find((l) => l.name === "seven_day")!.used) * 100)} %`;
});

await step("каждый вызов и решение — строка журнала машины; те же строки читаются из ClickHouse", async () => {
  const calls = await journal("call", first);
  const ok = calls.filter((l) => l.status === 200 && l.account && l.req);
  if (!ok.length) throw new Error("строк call со статусом 200, аккаунтом и номером запроса нет: " + JSON.stringify(calls.slice(0, 2)));
  if (!(await journal("route", first)).some((l) => Array.isArray(l.candidates))) throw new Error("строки route с кандидатами нет");
  const stored = await until("строки call сессии в ClickHouse", async () => { const r = await api.call(logQuery, { msg: "call", session: first, limit: 50 }); return r.lines.length >= ok.length ? r.lines : undefined; }, 180_000);
  return `call на машине ${calls.length}, в ClickHouse ${stored.length}`;
});

await step("токен аккаунта не годен: вызов ушёл на следующий аккаунт, ход не оборван; аккаунт выбыл с причиной; происшествие", async () => {
  await api.call(keysSet, { name: BOGUS, protocol: CLAUDE, value: `sk-ant-oat01-${tag}-not-a-token` });
  await until("машина прочитала новый аккаунт", async () => (await api.call(accountList, { to: "@" + machine })).accounts.some((a) => a.name === BOGUS), 30_000);
  // свежая неделя негодного аккаунта даёт ему высокий счёт: новая сессия пробует его первым
  const cs = await open("hop", { key: CLAUDE, model: cheap });
  const row = await answered(cs);
  const tried = (await journal("call", cs)).some((l) => l.account === BOGUS && l.status === 401);
  const out = (await api.call(accountList, { to: "@" + machine })).accounts.find((a) => a.name === BOGUS);
  if (tried && (out?.ok !== false || !real.includes(row.account ?? ""))) throw new Error(`после 401: аккаунт ${JSON.stringify(out)}, сессия на ${row.account}`);
  if (!tried && !real.includes(row.account ?? "")) throw new Error("сессия на " + row.account);
  return tried ? `401 на ${BOGUS} → ${row.account}; причина: ${out?.why}` : `машина выбрала ${row.account} сразу: негодный не пробовался (его счёт ниже)`;
});
await api.call(keysRemove, { name: BOGUS }).catch(() => {});

await step("«/model слова» сообщением ставит модель, в разговор команда не уходит; несколько подходящих — отказ; у каждого семейства Claude модель ответа совпала с каталогом", async () => {
  const many = await api.call(message, { to: first, text: "/model claude" }).then(() => "ok", (e) => (e as CallError).word);
  if (many !== "many_models") throw new Error("«/model claude»: " + many);
  // по одной модели семейства — первая в каталоге; SB2_FAMILIES=Haiku,Sonnet сужает проверку
  const only = process.env.SB2_FAMILIES?.split(",");
  const firsts = models.filter((m, i) => models.findIndex((x) => x.family === m.family) === i && (!only || only.includes(m.family ?? "")));
  const drift: string[] = [];
  for (const m of firsts) {
    const set = await api.call(message, { to: first, text: `/model ${m.id}` });
    const row = await rowOf(first);
    if (!set.model || row?.spec.model !== set.model || !set.model.startsWith(m.id)) throw new Error(`модель ${m.id}: ответ ${set.model}, документ ${row?.spec.model}`);
    const before = row.last ?? 0;
    await api.call(message, { to: first, text: PROMPT });
    const after = await until(`${first} ответила на ${m.id}`, async () => { const r = await rowOf(first); return r?.state === "idle" && (r.last ?? 0) > before ? r : undefined; }, 240_000);
    if (after.answers) drift.push(`${after.spec.model} → ${after.answers}`);
  }
  if (drift.length) throw new Error("ответила не названная модель: " + drift.join("; "));
  return `совпали ${firsts.length} из ${firsts.length}: ${firsts.map((m) => m.id).join(", ")}`;
});

await step("модель провайдера из каталога: сессия на ключе флота отвечает моделью, названной в документе", async () => {
  const provider = (await api.call(keysList, {})).keys.find((k) => k.protocol !== CLAUDE);
  if (!provider) throw new Error("у флота нет ключа провайдера");
  const list = (await api.call(keysModels, { name: provider.name })).models;
  if (!list.length) throw new Error(`каталог ${provider.name} пуст`);
  const model = process.env.SB2_MODEL ?? list[0]!.id;
  const row = await answered(await open("prov", { key: provider.name, model }));
  if (row.account) throw new Error("у сессии провайдера в строке аккаунт Claude: " + row.account);
  return `${provider.name}/${model}: моделей в каталоге ${list.length}`;
});

for (const c of made) await api.call(sessionRemove, { to: c }).catch(() => {});
console.log(bad ? `сбоев: ${bad} из ${total}` : `аккаунты: ${total} из ${total}`);
process.exit(bad ? 1 : 0);
