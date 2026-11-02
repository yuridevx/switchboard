// Живой главный флоу: клиент открывает сессию на машине, шлёт текст, ждёт конца хода и читает ответ из истории.
// env: FLOW_CLIENT_KEY (client.*), FLOW_MACHINE, FLOW_DIR (папка проекта на машине), FLOW_MODEL (по умолчанию haiku).
import { type Roster } from "@switchboard/relay";
import { client } from "./client.ts";

const url = process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev";
const key = process.env.FLOW_CLIENT_KEY!;
const machine = process.env.FLOW_MACHINE!;
const dir = process.env.FLOW_DIR!;
const model = process.env.FLOW_MODEL ?? "claude-haiku-4-5";
const name = process.env.FLOW_NAME ?? "flow";
const callsign = `${name}@${machine}`;

const states: string[] = [];
const l = client(key, {
  onFrame: (f) => {
    if (f.type === "roster") {
      const s = (f as unknown as Roster).sessions.find((x) => x.callsign === callsign);
      const st = s ? String(s.state) : "—";
      if (states[states.length - 1] !== st) states.push(st);
    }
  },
});
const until = async (what: string, ok: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`не дождался: ${what} (состояния: ${states.join(" → ")})`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const last = () => states[states.length - 1];

try {
  await until("связь", () => l.state === "open", 15000);
  const caps = l.roster?.machines.find((m) => m.machine === machine);
  console.log(`машина ${machine}: ${caps ? Object.keys(caps.contract ?? {}).length + " имён контракта" : "нет в roster"}`);
  const prev = l.roster?.sessions.find((s) => s.callsign === callsign);
  if (prev) {
    const rm = await l.request({ type: "session.remove", v: 1, callsign });
    console.log("старая сессия убрана:", rm.ok ? "ok" : rm);
  }
  const open = await l.request({ type: "session.open", v: 1, machine, name, dir, model });
  console.log("session.open:", JSON.stringify(open).slice(0, 300));
  if (!open.ok) process.exit(1);
  await until("idle после открытия", () => last() === "idle", 90000);
  const p = await l.request({ type: "session.prompt", v: 1, callsign, text: "Ответь одним словом: столица Франции?" });
  console.log("session.prompt:", JSON.stringify(p).slice(0, 200));
  await until("ход начался", () => states.includes("running") || states.includes("busy"), 60000);
  await until("конец хода", () => last() === "idle", 180000);
  const h = await l.request({ type: "session.history", v: 1, callsign, before: null, limit: 10 });
  const msgs = ((h as { result?: { messages?: Array<{ type: string; message?: { content?: unknown } }> } }).result?.messages ?? []);
  const text = msgs
    .filter((m) => m.type === "assistant")
    .flatMap((m) => (Array.isArray(m.message?.content) ? (m.message!.content as Array<{ type: string; text?: string }>) : []))
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join(" ");
  console.log("состояния:", states.join(" → "));
  console.log("ответ модели:", text || JSON.stringify(h).slice(0, 400));
  console.log(/париж|paris/i.test(text) ? "flow: ok" : "flow: FAIL");
  process.exitCode = /париж|paris/i.test(text) ? 0 : 1;
} catch (e) {
  console.log("flow: FAIL ·", (e as Error).message);
  process.exitCode = 1;
} finally {
  l.close(1000, "done");
}
