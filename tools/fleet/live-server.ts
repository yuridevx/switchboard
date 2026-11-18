// Живая проверка серверных функций флота: node tools/fleet/live-server.ts <флот> <устройство> [машина] [машина для переноса]
// Архив проверяется на своей сессии: проверка открывает её, даёт ей один ход со своим словом и убирает за собой.
// Сервер MCP (401 без пропуска, список инструментов, вызов), здоровье, точка → архив → поиск → разговор → перенос на другую машину.
import fs from "node:fs";
import path from "node:path";
import { createApi, fleetList, httpTransport, keysModels, obsHealth, pointsHistory, pointsList, pointsRaise, pointsSave, sessionOpen, sessionRemove, sessionUpdate, type SessionRow } from "@sb/protocol";
import { dev, fleetEnv } from "../dev.mjs";
import { lacks, machineTmp, newTag } from "./harness.mjs";
import { say, turn } from "./turn.mjs";

const dir = dev;
const env = fleetEnv;
const [fleet = "test", device = "cli", machine = "devbox", target = ""] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const base = env.SB2_BASE!;
const api = createApi(httpTransport({ base, key }));

let bad = 0;
async function step(label: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    console.log(`✓ ${label} · ${Date.now() - t0 >= 0 ? "" : ""}${await fn()} · ${Date.now() - t0} мс`);
  } catch (e) {
    bad++;
    console.log(`✗ ${label} · ${(e as Error).message.split("\n")[0]}`);
  }
}
const rpc = async (body: unknown, auth = true) => fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: "Bearer " + key } : {}) }, body: JSON.stringify(body) });

await step("MCP без пропуска — 401 и адрес сервера входа", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, false);
  const h = r.headers.get("www-authenticate") ?? "";
  if (r.status !== 401 || !h.includes("resource_metadata")) throw new Error(`HTTP ${r.status}, заголовок: ${h}`);
  return "401";
});
await step("MCP: список инструментов", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const j = (await r.json()) as { result?: { tools: { name: string }[] } };
  const names = j.result?.tools.map((t) => t.name) ?? [];
  for (const need of ["session_open", "message", "fleet_list", "points_list", "obs_health", "reach_send"]) if (!names.includes(need)) throw new Error("нет инструмента " + need);
  return `инструментов ${names.length}`;
});
await step("MCP: вызов инструмента fleet_list", async () => {
  const r = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fleet_list", arguments: {} } });
  const j = (await r.json()) as { result?: { content: { text: string }[]; isError?: boolean } };
  if (!j.result || j.result.isError) throw new Error(JSON.stringify(j).slice(0, 200));
  return `ответ ${j.result.content[0]!.text.length} знаков`;
});
await step("метаданные сервера входа OAuth", async () => {
  const r = await fetch(base + "/.well-known/oauth-authorization-server");
  const j = (await r.json()) as { token_endpoint?: string; authorization_endpoint?: string };
  if (!j.token_endpoint || !j.authorization_endpoint) throw new Error("нет адресов в метаданных");
  return j.authorization_endpoint;
});
await step("адрес установки с приглашением: страница зовёт манифест с ним, манифест запускает приложение с ним", async () => {
  // приглашение не принимается: шаг читает только разметку и манифест
  const asked = encodeURIComponent(`${fleet}:kshow${newTag()}:${"s".repeat(20)}`);
  const page = await (await fetch(`${base}/i?invite=${asked}`)).text();
  const link = /<link[^>]*manifest[^>]*>/.exec(page)?.[0] ?? "";
  if (!link.includes("/manifest.webmanifest?invite=" + asked)) throw new Error("ссылка на манифест в разметке: " + (link || "нет"));
  const plain = (await (await fetch(base + "/manifest.webmanifest")).json()) as { start_url?: string };
  const m = (await (await fetch(base + "/manifest.webmanifest?invite=" + asked)).json()) as { start_url?: string; name?: string };
  if (m.start_url !== "/i?invite=" + asked || plain.start_url === m.start_url) throw new Error(`start_url: ${m.start_url}, без приглашения: ${plain.start_url}`);
  return `${m.name}: запуск с приглашением, без него — ${plain.start_url}`;
});
await step("картина флота для модели", async () => {
  const r = await api.call(fleetList, {});
  return `машин ${r.machines.length}, сессий ${r.sessions.length}`;
});
await step("сводка здоровья", async () => JSON.stringify(await api.call(obsHealth, {})).slice(0, 160));

// архив: блоки разговора идут в хранилище по подписанным ссылкам
if (!lacks("r2")) {
  const tag = newTag();
  const word = "сервер" + tag;
  const SEAT = process.env.SB2_KEY ?? "muse";
  let source = "";
  let sid = "";
  await step("своя сессия ответила своим словом", async () => {
    const model = process.env.SB2_MODEL ?? (await api.call(keysModels, { name: SEAT })).models[0]!.id;
    source = (await api.call(sessionOpen, { to: "@" + machine, spec: { name: "srv-" + tag, cwd: `${machineTmp(fleet, device, machine)}/sb2-server-${tag}`, key: SEAT, model }, mkdir: true, prompt: turn(say(word)) })).callsign;
    for (const end = Date.now() + 120_000; ; await new Promise((r) => setTimeout(r, 1500))) {
      const row = ((await api.call(fleetList, { machine, full: true })).sessions as SessionRow[]).find((s) => s.callsign === source);
      if (row?.state === "failed") throw new Error("сессия failed: " + row.error);
      if (row?.state === "idle" && row.result) return source;
      if (Date.now() > end) throw new Error("сессия не ответила за 120 с");
    }
  });
  await step("архив включён у сессии", async () => (await api.call(sessionUpdate, { to: source, patch: { backup: true } }), "backup: true"));
  await step("точка сохранена", async () => {
    const r = await api.call(pointsSave, { to: source, label: "живая проверка" });
    return `точка ${r.point}${r.same ? " (та же)" : ""}`;
  });
  await step("сессия видна в архиве", async () => {
    const r = await api.call(pointsList, { machine: source.split("@")[1] });
    const s = r.sessions.find((x) => x.callsign === source);
    if (!s) throw new Error("сессии нет в каталоге: " + r.sessions.map((x) => x.callsign).join(", "));
    sid = s.sid;
    return `sid ${sid.slice(0, 8)}, точек ${s.points}`;
  });
  await step("поиск по слову находит сессию", async () => {
    const r = await api.call(pointsList, { q: word });
    if (!r.sessions.some((x) => x.sid === sid)) throw new Error("не найдена; нашлось: " + r.sessions.length);
    return `найдено ${r.sessions.length}; строка: ${r.sessions.find((x) => x.sid === sid)?.hit?.slice(0, 60)}`;
  });
  await step("разговор читается из архива", async () => {
    const r = await api.call(pointsHistory, { sid, limit: 20 });
    if (!r.events.length) throw new Error("событий нет");
    return `событий ${r.events.length}`;
  });
  if (target) await step("копия поднята на другой машине", async () => {
    const r = await api.call(pointsRaise, { to: "@" + target, sid, name: "raised" + tag, cwd: `${machineTmp(fleet, device, target)}/sb2-raised-${tag}` });
    // копия своя, проверочная: убрать за собой
    if (r.callsign) await api.call(sessionRemove, { to: r.callsign }).catch(() => {});
    return String(r.callsign);
  });
  if (source) await api.call(sessionRemove, { to: source }).catch(() => {});
}
console.log(bad ? `сбоев: ${bad}` : "серверные функции отвечают");
process.exit(bad ? 1 : 0);
