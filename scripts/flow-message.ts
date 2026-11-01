// Живая переписка сессий: просим сессию A отправить сообщение сессии B инструментом fleet,
// ждём, что B получила его во вводе; затем — что у A нет ListAgents (переписка Claude Code выключена).
// env: FLOW_CLIENT_KEY, FLOW_FROM (a@m1), FLOW_TO (b@m2).
import { link } from "@switchboard/relay";

const l = link({ url: process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev", key: process.env.FLOW_CLIENT_KEY! });
const from = process.env.FLOW_FROM!;
const to = process.env.FLOW_TO!;
const mark = "метка-" + Math.random().toString(36).slice(2, 7);
const wait = async (what: string, ok: () => Promise<boolean> | boolean, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) throw new Error("не дождался: " + what);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const history = async (callsign: string) => {
  const h = await l.request({ type: "session.history", v: 1, callsign, before: null, limit: 30 });
  return JSON.stringify(h);
};
try {
  await wait("связь", () => l.state === "open", 15000);
  const p = await l.request({
    type: "session.prompt",
    v: 1,
    callsign: from,
    text: `Отправь сессии ${to} инструментом fleet (send) ровно такой текст: «${mark}». Больше ничего не делай.`,
  });
  console.log("prompt:", p.ok ? "ok" : JSON.stringify(p));
  await wait(`сообщение у ${to}`, async () => (await history(to)).includes(mark), 180000);
  console.log(`message: ok · ${to} получила «${mark}» от ${from}`);
  // в тексте запроса меток ответа нет: они складываются только в ответе модели
  const yes = mark + "-ЕСТЬ";
  const no = mark + "-НЕТ";
  await l.request({
    type: "session.prompt",
    v: 1,
    callsign: from,
    text: `Вызови инструмент ListAgents. Ответь одной строкой: «${mark}», дефис и заглавными НЕТ, если такого инструмента у тебя нет, или ЕСТЬ, если вызов прошёл.`,
  });
  let h = "";
  await wait(`ответ ${from} про ListAgents`, async () => (h = await history(from)).includes(yes) || h.includes(no), 180000);
  if (h.includes(yes)) throw new Error(`у ${from} есть ListAgents`);
  console.log(`list-agents: ok · у ${from} нет ListAgents`);
} catch (e) {
  console.log("message: FAIL ·", (e as Error).message);
  console.log("история отправителя:", (await history(from)).slice(-800));
  process.exitCode = 1;
} finally {
  l.close(1000, "done");
}
