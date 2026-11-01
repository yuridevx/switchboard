// Живая проверка вложенных сессий на тестовом флоте: сессия на A открывает инструментом fleet.open дочь на B,
// дочь кончает ход — её итог приходит родителю сам; родитель закрывает дочь инструментом fleet.remove.
// Каждая строка — ok или FAIL; в конце — число ok и FAIL.
// env: FLOW_CLIENT_KEY (client.*), FLOW_A (машина родителя, по умолчанию win), FLOW_B (машина дочери, wsl),
//      FLOW_DIR (папка обеих сессий, ~/sb-flow), FLOW_MODEL (claude-haiku-4-5).
import { link } from "@switchboard/relay";

const A = process.env.FLOW_A ?? "win";
const B = process.env.FLOW_B ?? "wsl";
const dir = process.env.FLOW_DIR ?? "~/sb-flow";
const model = process.env.FLOW_MODEL ?? "claude-haiku-4-5";
const mark = Math.random().toString(36).slice(2, 8);
const lead = `nestlead${mark}@${A}`;
const kid = `nestkid${mark}@${B}`;
const l = link({ url: process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev", key: process.env.FLOW_CLIENT_KEY! });

const fails: string[] = [];
let oks = 0;
const check = (n: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${detail === undefined ? "" : " · " + JSON.stringify(detail).slice(0, 400)}`);
  if (ok) oks++;
  else fails.push(n);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => Promise<boolean> | boolean, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) return false;
    await sleep(1000);
  }
  return true;
};
const rq = async (type: string, f: Record<string, unknown>) => (await l.request({ type, v: 1, ...f })) as { ok: boolean; error?: string; result?: unknown };
type Roster = { sessions: Array<Record<string, any>> };
const rec = (cs: string) => (l.roster as Roster | null)?.sessions.find((s) => s.callsign === cs);
const history = async (cs: string) => JSON.stringify(await rq("session.history", { callsign: cs, before: null, limit: 40 }));
type Entry = { type?: string; message?: { content?: string | Array<{ type?: string; text?: string }> } };
/** Тексты ввода сессии: строка или текстовые блоки сообщений user. */
const inputs = async (cs: string) => {
  const r = await rq("session.history", { callsign: cs, before: null, limit: 40 });
  const list = ((r.result as { messages?: Entry[] } | undefined)?.messages ?? []).filter((m) => m.type === "user");
  return list.flatMap((m) => (typeof m.message?.content === "string" ? [m.message.content] : (m.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "")));
};

try {
  check("связь", await until(() => l.state === "open", 15000));
  const o = await rq("session.open", { machine: A, name: `nestlead${mark}`, dir, model });
  check(`open ${lead}`, o.ok, o);
  check("родитель", await until(() => !!rec(lead) && rec(lead)!.state === "idle", 60000), rec(lead));
  await rq("session.prompt", {
    callsign: lead,
    text: `Вызови инструмент fleet open: name «nestkid${mark}», machine «${B}», dir «${dir}», model «${model}», text «Ответь одной строкой: ${mark}-готово». Больше ничего не делай.`,
  });
  check(`дочь ${kid} в roster с parent ${lead}`, await until(() => rec(kid)?.parent === lead, 180000), rec(kid));
  // метка есть и в задании родителю — итог ищется только внутри сообщения от дочери
  check("итог хода дочери — у родителя сам", await until(async () => (await inputs(lead)).some((t) => t.startsWith(`<fleet-message from="${kid}">`) && t.includes(`${mark}-готово`)), 240000));
  check("дочь send не звала", !(await history(kid)).includes("mcp__fleet__send"));
  await rq("session.prompt", { callsign: lead, text: `Закрой сессию ${kid} инструментом fleet remove. Больше ничего не делай.` });
  check("remove — дочь ушла из roster", await until(() => !rec(kid), 180000), rec(kid));
} catch (e) {
  check("сценарий", false, (e as Error).message);
} finally {
  if (rec(kid)) await rq("session.remove", { callsign: kid });
  if (rec(lead)) await rq("session.remove", { callsign: lead });
  console.log(`итого: ${oks} ok, ${fails.length} FAIL${fails.length ? " — " + fails.join("; ") : ""}`);
  process.exitCode = fails.length ? 1 : 0;
  l.close(1000, "done");
}
