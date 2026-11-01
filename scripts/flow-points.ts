// Живые точки R2: пометить сессию «в R2», снять точку, поднять копию на другой машине и проверить,
// что разговор переехал; в конце снять пометку (точки уходят из R2). env: FLOW_CLIENT_KEY, FLOW_FROM (a@m1), FLOW_TO_MACHINE.
import { link } from "@switchboard/relay";

const l = link({ url: process.env.SWITCHBOARD_URL ?? "wss://switchboard.yuridevx1608.workers.dev", key: process.env.FLOW_CLIENT_KEY! });
const from = process.env.FLOW_FROM!;
const toMachine = process.env.FLOW_TO_MACHINE!;
const wait = async (what: string, ok: () => Promise<boolean> | boolean, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) throw new Error("не дождался: " + what);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const req = async (f: Record<string, unknown>) => {
  const r = await l.request({ v: 1, ...f } as never);
  console.log(`${f.type}:`, JSON.stringify(r.ok ? r.result : r).slice(0, 300));
  if (!r.ok) throw new Error(`${f.type}: ${(r as { error?: string }).error}`);
  return r.result as Record<string, unknown>;
};
const state = (cs: string) => l.roster?.sessions.find((s) => s.callsign === cs)?.state;
let copy = "";
try {
  await wait("связь", () => l.state === "open", 15000);
  await req({ type: "session.r2", callsign: from, on: true });
  const saved = await req({ type: "points.save", callsign: from });
  // sid сессии — из обзора флота у points, как у пульта
  const fleet = await req({ type: "points.list", to: ".points" });
  const sid = (fleet.sessions as Array<{ sid: string; callsign?: string }>).find((x) => x.callsign === from)?.sid;
  if (!sid) throw new Error("points.list: нет сессии " + from);
  await l.request({ type: "session.remove", v: 1, callsign: `copy@${toMachine}` }); // копия прошлого прогона, если есть
  const raised = await req({ type: "points.raise", machine: toMachine, sid, point: saved.point, copy: true, dir: "~/sb-copy", name: "copy", files: "point" });
  copy = raised.callsign as string;
  await wait(`${copy} idle`, () => state(copy) === "idle", 120000);
  await req({ type: "session.prompt", callsign: copy, text: "Что я спрашивал у тебя самым первым сообщением в этом разговоре? Ответь коротко." });
  await wait("ответ копии", async () => {
    const h = JSON.stringify(await l.request({ type: "session.history", v: 1, callsign: copy, before: null, limit: 6 }));
    return /столиц|франц|capital|france/i.test(h.split('"type":"assistant"').slice(-1)[0] ?? "");
  }, 180000);
  console.log(`points: ok · ${from} → точка ${saved.point} → ${copy}: разговор переехал`);
} catch (e) {
  console.log("points: FAIL ·", (e as Error).message);
  process.exitCode = 1;
} finally {
  const off = await l.request({ type: "session.r2", v: 1, callsign: from, on: false });
  console.log("снять пометку:", JSON.stringify(off.ok ? off.result : off));
  if (copy) await l.request({ type: "session.remove", v: 1, callsign: copy });
  l.close(1000, "done");
}
