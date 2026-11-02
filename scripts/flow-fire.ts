// Живой «пожар»: машина с помеченной сессией умерла — сессия поднимается из R2 на другой машине; вернувшаяся машина
// уступает её новому хозяину. Остановку и запуск машины делает тот, кто запускает сценарий (FIRE_STOP / FIRE_START —
// команды оболочки). env: FLOW_CLIENT_KEY, FLOW_CALLSIGN (помеченная сессия на умирающей машине), FLOW_TO_MACHINE, FLOW_DIR.
import { execSync } from "node:child_process";
import { type Roster } from "@switchboard/relay";
import { client } from "./client.ts";

const CS = process.env.FLOW_CALLSIGN!;
const DEAD = CS.split("@")[1];
const TO = process.env.FLOW_TO_MACHINE!;
const l = client(process.env.FLOW_CLIENT_KEY!);
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 260)}`);
  if (!ok) fails.push(n);
};
const req = async (f: Record<string, unknown>) => (await l.request({ v: 1, ...f } as never)) as { ok: boolean; result?: any; error?: string };
const roster = () => l.roster as Roster | null;
const rec = (cs: string) => roster()?.sessions.find((s) => s.callsign === cs) as Record<string, any> | undefined;
const wait = async (ok: () => boolean | Promise<boolean>, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return true;
};
const turn = async (cs: string, text: string) => {
  await req({ type: "session.prompt", callsign: cs, text });
  await wait(() => rec(cs)?.state === "busy", 60000);
  await wait(() => rec(cs)?.state === "idle", 120000);
  const h = await req({ type: "session.history", callsign: cs, before: null, limit: 4 });
  return ((JSON.stringify(h).match(/"text":"(?:[^"\\]|\\.)*"/g) ?? []).slice(-1)[0] ?? "").slice(8, -1);
};

await wait(() => l.state === "open", 15000);
if (!rec(CS)?.r2) await req({ type: "session.r2", callsign: CS, on: true });
const headOf = async () => ((await req({ type: "points.list", to: ".points" })).result.sessions as any[]).find((s) => s.callsign === CS);
const before = (await headOf())?.head?.id;
console.log("до пожара:", await turn(CS, "Повтори дословно одно слово: «уголь». Ничего не сохраняй в память."));
// точка после хода — не раньше 2 мин после прошлой (правило точек): пожар теряет только то, что после последней точки,
// поэтому машину гасим, когда ход «уголь» уже в точке
check("ход «уголь» лёг в точку", await wait(async () => ((await headOf())?.head?.id ?? 0) > (before ?? 0), 180000), { before, now: (await headOf())?.head?.id });
const sid = (await headOf())?.sid;
check("у помеченной сессии есть точки в R2", !!sid);

execSync(process.env.FIRE_STOP!, { stdio: "inherit" });
check(`машина ${DEAD} ушла из roster`, await wait(() => !roster()?.machines.some((m) => m.machine === DEAD), 60000));
const off = await req({ type: "session.prompt", callsign: CS, text: "x" });
check("сессия умершей машины — offline", !off.ok && off.error === "offline", off.error);

const list = await req({ type: "points.list", to: ".points", sid });
const head = list.result.head as number;
const fire = await req({ type: "points.raise", machine: TO, sid, point: head, dir: process.env.FLOW_DIR, name: "fire", files: "point" });
check("пожар: сессия поднята на другой машине из последней точки", fire.ok, fire.result ?? fire.error);
const NEW = fire.result?.callsign as string;
await wait(() => rec(NEW)?.state === "idle", 120000);
check("разговор цел на новой машине", /уголь/i.test(await turn(NEW, "Какое слово ты повторял последним? Одним словом.")));
const owner = ((await req({ type: "points.list", to: ".points" })).result.sessions as any[]).find((s) => s.sid === sid)?.owner;
check("хозяин в реестре — новая машина", owner === TO, owner);

execSync(process.env.FIRE_START!, { stdio: "inherit" });
check(`машина ${DEAD} вернулась`, await wait(() => !!roster()?.machines.some((m) => m.machine === DEAD), 120000));
check("вернувшаяся машина уступила сессию: прежней копии нет в roster", await wait(() => !rec(CS), 180000), rec(CS));
check("новая копия жива", rec(NEW)?.state === "idle", rec(NEW)?.state);

await req({ type: "session.r2", callsign: NEW, on: false });
await req({ type: "session.remove", callsign: NEW });
l.close(1000, "done");
console.log(fails.length ? `fire: ${fails.length} провалов` : "fire: ok");
process.exit(fails.length ? 1 : 0);
