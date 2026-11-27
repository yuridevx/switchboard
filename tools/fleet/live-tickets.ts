// Живая проверка тикетов: node tools/fleet/live-tickets.ts [флот] [устройство] [машина]
// Своя сессия останавливается; тикет ей создаётся и поднимает её сам (письмо остановленной получило бы отказ); сессия сдаёт тикет
// инструментом ticket_set; история флота отдаёт движения тикета по имени строки. Ключ и модель — SB2_KEY и SB2_MODEL.
// Проекта проверки на флоте может не быть — тогда она его заводит и в конце убирает: это меняет общее для флота, проверка идёт одна (дорожка «одна»).
import { check } from "./harness.mjs";
import { say, tool, turn as script } from "./turn.mjs";

/** Проект проверки: один на флот, тикеты в нём копятся — номер своего тикета проверка узнаёт из ответа. */
const PROJECT = "tk";

await check(async (t) => {
  const one = async (id: string) => (await t.must("ticket.list", { ticket: id })).tickets[0];
  let s: Awaited<ReturnType<typeof t.session>>, id = "";

  await t.step("своя сессия открыта в проекте проверки и остановлена: письмо ей — отказ", async () => {
    const me = await t.must("whoami", {});
    const projects = (await t.must("people.list", {})).projects;
    const made = !projects.some((p: { id: string }) => p.id === PROJECT);
    if (made) await t.must("project.set", { project: PROJECT, name: "Проверка тикетов", members: [me.person] });
    // общее флота возвращается как было — по порядку: свой тикет, не доведённый до вердикта, снимается (открытым он остался бы на исполнителе,
    // которого уже нет; снимает его участник проекта), потом проект, который завела проверка, убирается
    t.defer(`тикет проверки${made ? " и проект " + PROJECT : ""}`, async (go: (type: string, fields: unknown) => Promise<{ ok: boolean; error?: string }>) => {
      if (id) {
        const r = await go("ticket.set", { ticket: id, drop: true, note: "живая проверка кончена" });
        // закрытый снимать нечего
        if (!r.ok && r.error !== "bad_state") return r;
      }
      if (made) return go("project.remove", { project: PROJECT });
    });
    s = await t.session({ name: "tk", project: PROJECT });
    await t.must("session.stop", { to: s.callsign });
    await t.wait(`${s.callsign} остановлена`, async () => (await s.row())?.state === "stopped");
    const refused = await t.call("message", { to: s.callsign, text: "проснись" });
    if (refused.ok || refused.error !== "stopped") throw new Error(`письмо остановленной: ${refused.ok ? "принято" : refused.error}`);
    return `${s.callsign} остановлена, письмо — отказ stopped`;
  });

  await t.step("тикет остановленной сессии доставлен: сессия поднята и сдала его вердиктом", async () => {
    // в тексте тикета {id} — его номер: шаг сценария называет его инструменту
    const text = script(tool("mcp__fleet__ticket_set", { ticket: "{id}", verdict: "done", note: "живая проверка " + t.tag }), say("тикет сдан"));
    id = (await t.must("ticket.new", { project: PROJECT, to: s.callsign, for: "10m", title: "Живая проверка тикета " + t.tag, text })).id;
    let state = "";
    const done = await t.wait(`тикет ${id} закрыт`, async () => {
      const x = await one(id);
      state = x.state;
      // тикет встал — это отказ, а не «ещё нет»: ждать нечего
      if (x.state === "stop") throw new Error(`тикет встал: ${x.why}`);
      return x.state === "done" && x;
    }, () => `тикет ${state}`);
    const note = done.notes?.find((n: { verdict?: string }) => n.verdict === "done");
    if (note?.by !== s.callsign || !note.text.includes(t.tag)) throw new Error(`вердикт не от сессии: ${JSON.stringify(done.notes)}`);
    // строка сессии в картине догоняет подъём: остановленной она быть перестала
    const up = await t.wait(`${s.callsign} поднята`, async () => {
      const st = (await s.row())?.state;
      return st && st !== "stopped" && st;
    }, () => "строка сессии — stopped");
    return `${id}: вердикт done от ${s.callsign}, сессия ${up}`;
  });

  // сайту нужен свой поддомен — в коробке его нет
  if (!t.lacks("sites"))
    await t.step("комментарии сайта уходят одним тикетом сессии, которая его выложила", async () => {
      const name = "tk-" + t.tag;
      t.defer("сайт " + name, async (go: (type: string, fields: unknown) => Promise<{ ok: boolean; error?: string }>) => {
        const r = await go("site.remove", { name });
        if (!r.ok && r.error !== "no_site") return r;
      });
      await s.turn(script(
        tool("Write", { file_path: `${s.cwd}/site/index.html`, content: `<!doctype html><meta charset="utf-8"><section id="a" data-block><h2>Блок ${t.tag}</h2></section>` }),
        tool("mcp__fleet__site_publish", { to: s.callsign, dir: "site", name }),
        say("выложено"),
      ));
      const blocks = (await s.history()).flatMap((e: any) => (Array.isArray(e.message?.content) ? e.message.content : []));
      const use = blocks.findLast((b: any) => b.type === "tool_use" && String(b.name).endsWith("site_publish"));
      const res = blocks.find((b: any) => b.type === "tool_result" && b.tool_use_id === use?.id);
      const url = JSON.parse(typeof res?.content === "string" ? res.content : (res?.content ?? []).map((c: any) => c.text ?? "").join("")).url as string;
      const post = async (path: string, body: unknown) => (await fetch(url + path, { method: "POST", body: JSON.stringify(body) })).json();
      for (const text of ["первый " + t.tag, "второй", "третий"]) await post("_sb/db", { sql: "INSERT INTO sb_comments (block, el, label, text, at) VALUES ('a', '0', 'Блок', ?, 1)", params: [text] });
      const sent = await post("_sb/submit", {});
      if (!sent.ticket || sent.comments !== 3) throw new Error(`отправка комментариев: ${JSON.stringify(sent)}`);
      const made = await one(sent.ticket);
      // тикет снимается сразу: работа по нему в проверку не входит
      await t.must("ticket.set", { ticket: sent.ticket, drop: true, note: "живая проверка кончена" });
      if (made.by !== ".sites" || made.to !== s.callsign || !made.text.includes("первый " + t.tag) || !made.title.endsWith("· 3")) throw new Error(`тикет с комментариями не тот: ${JSON.stringify(made)}`);
      const again = await post("_sb/submit", {});
      if (again.ticket !== null) throw new Error(`повторная отправка завела тикет: ${JSON.stringify(again)}`);
      return `3 комментария → 1 тикет ${sent.ticket} для ${made.to}`;
    });

  if (!t.lacks("clickhouse"))
    await t.step("история флота по имени строки «ticket» отдаёт движения тикета: создан, дан, сдан", async () => {
      const want = ["new", "given", "done"];
      let got: string[] = [];
      // строки истории доходят не сразу: ждём все три движения своего тикета
      await t.wait("строки истории о тикете", async () => {
        const lines = (await t.must("log.query", { msg: "ticket", machine: t.machine, limit: 200 })).lines.filter((l: { data?: { ticket?: string } }) => l.data?.ticket === id);
        got = lines.map((l: { kind?: string }) => l.kind);
        return want.every((k) => got.includes(k));
      }, () => `движений: ${got.join(", ") || "нет"}`);
      return `${want.length} из ${want.length}: ${[...got].reverse().join(" → ")}`;
    });
});
