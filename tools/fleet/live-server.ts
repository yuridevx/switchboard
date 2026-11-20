// Живая проверка серверных функций флота: node tools/fleet/live-server.ts <флот> <устройство> [машина] [машина для переноса]
// Архив проверяется на своей сессии: проверка открывает её, даёт ей один ход со своим словом и убирает за собой.
// Сервер MCP (список инструментов, вызов; путь входа клиента — в live-oauth.mjs), здоровье, точка → архив → поиск → разговор → перенос на другую машину.
import { check } from "./harness.mjs";
import { say, turn } from "./turn.mjs";

await check(async (t) => {
  const rpc = async (body: unknown) => (await t.fetch(t.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + t.key }, body: JSON.stringify(body) })).json();

  await t.step("MCP: список инструментов", async () => {
    const j = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result?: { tools: { name: string }[] } };
    const names = j.result?.tools.map((x) => x.name) ?? [];
    for (const need of ["session_open", "message", "fleet_list", "points_list", "obs_health", "reach_send"]) if (!names.includes(need)) throw new Error("нет инструмента " + need);
    return `инструментов ${names.length}`;
  });
  await t.step("MCP: вызов инструмента fleet_list", async () => {
    const j = (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fleet_list", arguments: {} } })) as { result?: { content: { text: string }[]; isError?: boolean } };
    if (!j.result || j.result.isError) throw new Error(JSON.stringify(j).slice(0, 200));
    return `ответ ${j.result.content[0]!.text.length} знаков`;
  });
  await t.step("адрес установки с приглашением: страница зовёт манифест с ним, манифест запускает приложение с ним", async () => {
    // приглашение не принимается: шаг читает только разметку и манифест
    const asked = encodeURIComponent(`${t.fleet}:kshow${t.tag}:${"s".repeat(20)}`);
    const page = await (await t.fetch(`${t.base}/i?invite=${asked}`)).text();
    const link = /<link[^>]*manifest[^>]*>/.exec(page)?.[0] ?? "";
    if (!link.includes("/manifest.webmanifest?invite=" + asked)) throw new Error("ссылка на манифест в разметке: " + (link || "нет"));
    const plain = (await (await t.fetch(t.base + "/manifest.webmanifest")).json()) as { start_url?: string };
    const m = (await (await t.fetch(t.base + "/manifest.webmanifest?invite=" + asked)).json()) as { start_url?: string; name?: string };
    if (m.start_url !== "/i?invite=" + asked || plain.start_url === m.start_url) throw new Error(`start_url: ${m.start_url}, без приглашения: ${plain.start_url}`);
    return `${m.name}: запуск с приглашением, без него — ${plain.start_url}`;
  });
  await t.step("картина флота для модели", async () => {
    const r = await t.must("fleet.list", {});
    return `машин ${r.machines.length}, сессий ${r.sessions.length}`;
  });
  await t.step("сводка здоровья", async () => JSON.stringify(await t.must("obs.health", {})).slice(0, 160));

  // архив: блоки разговора идут в хранилище по подписанным ссылкам
  if (t.lacks("r2")) return;
  const word = "сервер" + t.tag;
  let source: Awaited<ReturnType<typeof t.session>>, sid = "";
  await t.step("своя сессия ответила своим словом", async () => {
    // первая задача сессии — ответить словом проверки: обвязка ждёт итог этого хода
    source = await t.session({ name: "srv", prompt: turn(say(word)) });
    if (!source.first.text) throw new Error("ответа сессии нет");
    return source.callsign;
  });
  await t.step("архив включён у сессии", async () => (await t.must("session.update", { to: source.callsign, patch: { backup: true } }), "backup: true"));
  await t.step("точка сохранена", async () => {
    const r = await t.must("points.save", { to: source.callsign, label: "живая проверка" });
    return `точка ${r.point}${r.same ? " (та же)" : ""}`;
  });
  await t.step("сессия видна в архиве", async () => {
    const r = await t.must("points.list", { machine: source.machine });
    const s = r.sessions.find((x: { callsign: string }) => x.callsign === source.callsign);
    if (!s) throw new Error("сессии нет в каталоге: " + r.sessions.map((x: { callsign: string }) => x.callsign).join(", "));
    sid = s.sid;
    return `sid ${sid.slice(0, 8)}, точек ${s.points}`;
  });
  await t.step("поиск по слову находит сессию", async () => {
    // слово точки доходит до поиска не сразу за сохранением: ждём находку, а не читаем один раз
    let n = 0;
    const hit = await t.wait("сессия найдена поиском по слову", async () => {
      const r = await t.must("points.list", { q: word });
      n = r.sessions.length;
      return r.sessions.find((x: { sid: string }) => x.sid === sid);
    }, () => `не найдена; нашлось: ${n}`);
    return `найдено ${n}; строка: ${hit.hit?.slice(0, 60)}`;
  });
  await t.step("разговор читается из архива", async () => {
    const r = await t.must("points.history", { sid, limit: 20 });
    if (!r.events.length) throw new Error("событий нет");
    return `событий ${r.events.length}`;
  });
  if (t.second) await t.step("копия поднята на другой машине", async () => {
    const cwd = `${await t.tmp(t.second)}/raised-${t.tag}`;
    const r = await t.must("points.raise", { to: "@" + t.second, sid, name: "raised" + t.tag, cwd });
    // копия своя, проверочная: уборка — обвязки
    if (r.callsign) t.own(r.callsign, cwd);
    return String(r.callsign);
  });
});
