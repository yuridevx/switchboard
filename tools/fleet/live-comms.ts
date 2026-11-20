// Живая проверка связи сессий и знания о флоте: node tools/fleet/live-comms.ts [флот] [устройство] [машина]
// Без модели: короткая картина флота, отказ на выдуманный проект, сервер инструментов (инструкции, примеры, справка, чистка ответа, строка журнала).
// С моделью (ключ и модель — SB2_KEY и SB2_MODEL): родитель даёт задачу дочери — итог видом result; дочь с фоновой командой отвечает дважды;
// подмена Host посреди хода — итог дошёл, задача не пришла дважды; справка прочитана; правила пережили сжатие; карточки входящего на странице.
// Части (SB2_PART): talk — разговор сессий без перезапуска; swap — подмена Host посреди хода (перезапускает Host своей машины).
import path from "node:path";
import { check } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

/** Просьба родителю: один вызов message сервера fleet с задачей дочери. */
const give = (to: string, task: string) => script(tool("mcp__fleet__message", { to, text: task }), say("задача отдана"));
const short = (v: string, n = 60) => v.replace(/\s+/g, " ").slice(0, n);

await check(async (t: any) => {
  const stepTalk = t.only("talk");
  const stepSwap = t.only("swap");
  /** Входящие от флота у сессии: разобранные отправитель, вид и текст. */
  const incoming = async (s: any, from: string, kind: string): Promise<string[]> => (await s.history()).filter((e: any) => e.peer?.from === from && e.peer.kind === kind).map((e: any) => e.peer.text);
  /** Ждать, пока входящих этого вида станет больше n: новые — ответом. */
  const more = (s: any, from: string, kind: string, n: number) => {
    let seen = 0;
    return t.wait(`у ${s.callsign} входящих «${kind}» от ${from} больше ${n}`, async () => {
      const got = await incoming(s, from, kind);
      seen = got.length;
      return got.length > n && got.slice(n);
    }, () => `входящих ${seen}`);
  };
  /** Вызов сервера инструментов тем же пропуском, что у человека со своим Claude. */
  const mcp = async (method: string, params: unknown = {}): Promise<any> => {
    const res = await t.fetch(t.base + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t.key }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };

  // ───────── без модели ─────────

  await stepTalk("картина флота: короткая строка сессии; полная — по full", async () => {
    const brief = await t.must("fleet.list", {});
    const full = await t.must("fleet.list", { full: true });
    if (brief.sessions.some((s: any) => "spec" in s || "result" in s)) throw new Error("в короткой строке документ или последний ответ");
    if (full.sessions.length && !full.sessions.every((s: any) => "spec" in s)) throw new Error("в полной строке нет документа");
    return `сессий ${brief.sessions.length}, знаков: короткая ${JSON.stringify(brief).length}, полная ${JSON.stringify(full).length}`;
  });

  await stepTalk("выдуманный проект отвергнут: отказ no_project со списком «номер — имя»", async () => {
    const projects = (await t.must("people.list", {})).projects;
    // открылась — своя сессия: обвязка её уберёт
    const r = await t.session({ name: "np", project: "vydumannyj-proekt" }).then(() => null, (e: any) => e);
    if (!r) throw new Error("сессия с выдуманным проектом открылась");
    if (r.word !== "no_project") throw r;
    for (const p of projects) if (!String(r.why).includes(`${p.id} — ${p.name}`)) throw new Error(`в отказе нет «${p.id} — ${p.name}»`);
    return `проектов во флоте ${projects.length}; отказ: ${String(r.why).slice(0, 90)}`;
  });

  await stepTalk("сервер инструментов: инструкции, пример у каждого инструмента, пометка «только чтение», страницы справки", async () => {
    const init = await mcp("initialize", { protocolVersion: "2025-06-18" });
    if (!String(init.instructions).includes("fleet_list") || String(init.instructions).length > 4096) throw new Error("инструкций нет или они длиннее 4 096");
    const tools = (await mcp("tools/list")).tools as Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean } }>;
    const without = tools.filter((x) => !/\nПример: \{/.test(x.description)).map((x) => x.name);
    if (without.length) throw new Error("без примера: " + without.join(", "));
    const long = tools.filter((x) => x.description.length > 4096).map((x) => x.name);
    if (long.length) throw new Error("описание длиннее 4 096: " + long.join(", "));
    if (!tools.find((x) => x.name === "fleet_list")?.annotations?.readOnlyHint || tools.find((x) => x.name === "message")?.annotations) throw new Error("пометка «только чтение» стоит не там");
    const pages = (await mcp("resources/list")).resources as Array<{ uri: string }>;
    const page = (await mcp("resources/read", { uri: "fleet://guide/practices" })).contents[0].text as string;
    // страницы справки по именам: новая страница проверку не роняет, пропавшая — роняет
    const missing = ["fleet://guide/practices", "fleet://guide/architecture", "fleet://guide/memory"].filter((uri) => !pages.some((x) => x.uri === uri));
    if (missing.length || !page.includes("session_remove")) throw new Error("справка не та" + (missing.length ? ": нет " + missing.join(", ") : ""));
    return `инструментов ${tools.length}, знаков описаний ${tools.reduce((n, x) => n + x.description.length, 0)}, инструкций ${String(init.instructions).length}, страниц справки ${pages.length}`;
  });

  // ───────── с моделью ─────────

  let parent: any, child: any;
  await t.step("родитель даёт задачу дочери — итог её хода приходит родителю видом result", async () => {
    parent = await t.session({ name: "cm-lead" });
    child = await t.session({ name: "cm-kid", cwd: parent.cwd, parent: parent.callsign });
    await parent.turn(give(child.callsign, script(say("принято"))));
    const tasks = await more(child, parent.callsign, "task", 0);
    const results = await more(parent, child.callsign, "result", 0);
    return `задач у дочери ${tasks.length}, итог: ${short(results[0])}`;
  });

  await stepTalk("история через сервер инструментов: подписей и счётчиков нет, номер события на месте; строка о вызове — в истории флота", async () => {
    const raw = JSON.stringify(await t.must("session.history", { to: child.callsign, limit: 50 }));
    const text = (await mcp("tools/call", { name: "session_history", arguments: { to: child.callsign, limit: 50 } })).content[0].text as string;
    for (const word of ['"signature"', '"usage"', '"modelUsage"', '"session_id"']) if (text.includes(word)) throw new Error(`в ответе модели осталось ${word}`);
    if (!text.includes('"uuid"')) throw new Error("номера события нет");
    // история флота лежит в ClickHouse: строка о вызове инструмента message — в data строки
    const line = t.lacks("clickhouse") ? "без ClickHouse не читается" : await t.wait("строка журнала о вызове message родителем", async () =>
      (await t.must("log.query", { msg: "tool", session: parent.callsign, limit: 20 })).lines.find((l: any) => (typeof l.data === "string" ? JSON.parse(l.data || "{}") : l.data ?? {}).tool === "message"));
    return `знаков: странице ${raw.length}, модели ${text.length} (${(raw.length / text.length).toFixed(1)}×); строка: ${JSON.stringify(line).slice(0, 110)}`;
  });

  await stepTalk("дочь с фоновой командой отвечает дважды — оба итога у родителя", async () => {
    const before = (await incoming(parent, child.callsign, "result")).length;
    // фоновая команда стоит на воротах: первый итог дочери приходит, пока она идёт; второй — после того, как проверка её отпустит
    const g = t.gate(t.machine, child.cwd);
    await parent.turn(give(child.callsign, script(tool("Bash", { command: g.command("fon-gotov"), run_in_background: true }), say("запустила"), say("фон кончился", "придёт уведомление о конце фоновой команды"))));
    const first = await more(parent, child.callsign, "result", before);
    if (first.length !== 1) throw new Error(`до конца фоновой команды итогов ${first.length}, ждали один`);
    await g.open();
    const got = await more(parent, child.callsign, "result", before + 1);
    return [...first, ...got].map((x) => short(x, 40)).join(" ‖ ");
  });

  // NO_SWAP=1 — без подмены Host: на флоте с чужими сессиями подмену делает сама выкладка сборки
  if (!process.env.NO_SWAP) await stepSwap("подмена Host посреди хода дочери — процесс новый, сессии на месте, итог дошёл родителю, задача не пришла дважды", async () => {
    const before = (await incoming(parent, child.callsign, "result")).length;
    const tasks = (await incoming(child, parent.callsign, "task")).length;
    // ход дочери стоит на воротах, пока проверка их не откроет: подмена приходит именно посреди хода
    const g = t.gate(t.machine, child.cwd);
    await parent.turn(give(child.callsign, script(tool("Bash", { command: g.command() }), say("подмена пережита: {итог 1}"))));
    await t.wait(`${child.callsign} стоит на воротах`, async () => JSON.stringify((await child.history()).filter((e: any) => e.type === "assistant")).includes(g.id));
    const keeper = `.keeper@${t.machine}`;
    const pid = (await t.must("keeper.state", { to: keeper })).host.pid;
    await t.must("host.restart", { to: keeper });
    await t.wait("новый процесс Host", async () => {
      const k = await t.must("keeper.state", { to: keeper });
      return k.host.state === "running" && k.host.pid !== pid;
    });
    // старый Host закрыл соединение до выхода: машина на связи — это уже новый процесс
    const back = await t.wait("машина снова в картине", async () => {
      const l = await t.must("fleet.list", { machine: t.machine });
      return l.machines[0]?.online && l.sessions.map((s: any) => s.callsign);
    });
    if (![parent.callsign, child.callsign].every((c) => back.includes(c))) throw new Error(`после подмены на машине нет своих сессий: ${parent.callsign}, ${child.callsign}; есть ${back.join(",")}`);
    await g.open();
    const got = await more(parent, child.callsign, "result", before);
    // барьер: сообщение дочери тем же входом, что и задача; задача, пришедшая дважды, встала бы в очередь до него
    await child.turn(script(say("барьер")));
    const now = (await incoming(child, parent.callsign, "task")).length;
    if (now !== tasks + 1) throw new Error(`задач у дочери ${tasks} → ${now}: ждали ровно одну новую`);
    return `итог: ${short(got[0], 50)}; задач у дочери ${tasks} → ${now}`;
  });

  await stepTalk("справка прочитана: сессия по просьбе читает страницу практик и называет инструмент", async () => {
    const a = (await child.turn(script(tool("ReadMcpResourceTool", { server: "fleet", uri: "fleet://guide/practices" }), say("страница практик: {итог 1}")))).text;
    if (!a.includes("session_remove")) throw new Error("ответ: " + a.slice(0, 120));
    return short(a, 80);
  });

  // свой позывной и правила сессия знает из слов Host: назвать их может только модель, которая понимает прочитанное
  if (!t.lacks("mind")) await stepTalk("правила пережили сжатие: сессия называет свой позывной и инструмент ответа соседу", async () => {
    // сжатие встаёт в очередь ввода первым: вопрос идёт после него
    await t.must("session.call", { to: child.callsign, method: "compact" });
    const a = (await child.turn("Назови одной строкой свой позывной во флоте и имя инструмента, которым отвечают на сообщение другой сессии (kind message).")).text;
    if (!(await child.history()).some((e: any) => e.subtype === "compact_boundary")) throw new Error("сжатия в разговоре нет");
    if (!a.includes(child.callsign) || !/\bmessage\b/.test(a)) throw new Error("ответ: " + a.slice(0, 120));
    return short(a, 90);
  });

  await stepTalk("карточки входящего от флота стоят в разговоре ведущей на выложенной странице", async () => {
    const page = await t.page({ console: true });
    await page.goto(t.base + "/#/work/" + parent.callsign);
    await page.locator(".pcard").first().waitFor({ state: "attached" });
    let cards: string[] = [];
    for (const [w, h, scheme] of [[1280, 900, "light"], [390, 844, "dark"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      // прокрутка к карточке ждёт, пока она встанет на место в новой раскладке
      await page.locator(".pcard").first().scrollIntoViewIfNeeded();
      cards = await page.locator(".pcard").evaluateAll((els: Element[]) => els.map((e) => `${e.getAttribute("aria-label")} [${e.className.replace("pcard ", "")}]`));
      await page.screenshot({ path: path.join(t.shots(), `cards-${w}-${scheme}.png`) });
    }
    if (!cards.length) throw new Error("карточек входящего нет");
    return `карточек ${cards.length}: ${[...new Set(cards)].join("; ").slice(0, 160)}`;
  });
});
