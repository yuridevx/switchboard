// Живой сценарий профилей с репозиторием: клон по токену приложения GitHub, профиль живой сессии (перезапуск,
// CLAUDE.md и модель профиля), память профиля уходит в репозиторий и приходит на другую машину, профиль в session.open,
// снятие профиля. Репозиторий — в ключе fleet.profiles.repos настроек флота. env: FLOW_CLIENT_KEY,
// FLOW_FROM_MACHINE, FLOW_TO_MACHINE, FLOW_DIR, FLOW_REPO (владелец/имя), FLOW_PROFILE (папка профиля в репозитории).
import { type Roster } from "@switchboard/relay";
import { client } from "./client.ts";

const M1 = process.env.FLOW_FROM_MACHINE!;
const M2 = process.env.FLOW_TO_MACHINE!;
const dir = process.env.FLOW_DIR!;
const ID = `${process.env.FLOW_REPO}/${process.env.FLOW_PROFILE}`;
const l = client(process.env.FLOW_CLIENT_KEY!);
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 300)}`);
  if (!ok) fails.push(n);
};
const req = async (f: Record<string, unknown>) => (await l.request({ v: 1, ...f } as never)) as { ok: boolean; result?: any; error?: string };
const rec = (cs: string) => (l.roster as Roster | null)?.sessions.find((s) => s.callsign === cs) as Record<string, any> | undefined;
const wait = async (ok: () => boolean | Promise<boolean>, ms: number) => {
  for (const t0 = Date.now(); !(await ok()); ) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return true;
};
const state = (cs: string, s: string, ms = 120000) => wait(() => rec(cs)?.state === s, ms);
async function turn(cs: string, t: string) {
  await req({ type: "session.prompt", callsign: cs, text: t });
  await state(cs, "busy", 60000);
  await state(cs, "idle", 180000);
  const h = await req({ type: "session.history", callsign: cs, before: null, limit: 6 });
  return ((JSON.stringify(h).match(/"text":"(?:[^"\\]|\\.)*"/g) ?? []).slice(-1)[0] ?? "").slice(8, -1);
}
const open = async (m: string, name: string) => {
  const cs = `${name}@${m}`;
  await req({ type: "session.remove", callsign: cs });
  const o = await req({ type: "session.open", v: 2, machine: m, name, dir, model: "claude-haiku-4-5" });
  await state(cs, "idle");
  return { cs, o };
};

await wait(() => l.state === "open" && [M1, M2].every((m) => (l.roster as Roster | null)?.machines.some((x) => x.machine === m)), 120000);

// --- клон и список профилей на обеих машинах ---
for (const m of [M1, M2]) {
  const p = await req({ type: "machine.profiles", v: 2, machine: m, sync: true });
  const repo = p.result?.repos?.[process.env.FLOW_REPO!];
  check(`${m}: клон по токену приложения, профиль в списке`, p.ok && repo?.state === "ok" && !!p.result.profiles[ID], { repo, profiles: Object.keys(p.result?.profiles ?? {}) });
}

// --- профиль на живой сессии ---
const { cs: A } = await open(M1, "prof");
const set = await req({ type: "session.profile", v: 2, callsign: A, profile: [ID] });
check("профиль живой сессии — перезапуск", set.ok && set.result.restart === true, set.result ?? set.error);
await wait(() => rec(A)?.profile?.[0]?.id === ID, 60000);
await state(A, "idle");
check("roster: поле profile с состоянием ok", rec(A)?.profile?.[0]?.state === "ok", rec(A)?.profile);
check("CLAUDE.md профиля в промпте", /сова-42/.test(await turn(A, "Какой у тебя профиль? Ответь как велит твой профиль.")));
const mp = await req({ type: "machine.profiles", v: 2, machine: M1 });
check("machine.profiles: кусочек в списке и сессия на нём", !!mp.result?.profiles?.[ID] && (rec(A)?.profile as Array<{ id?: string }> | undefined)?.[0]?.id === ID, mp.result?.profiles?.[ID]);

// --- память профиля: запись на одной машине → репозиторий → другая машина ---
// метка прогона: память профиля копит записи прошлых прогонов — спрашиваем запись именно этого
const run = `прогон-${Date.now().toString(36)}`;
const color = `бирюзовый-${Date.now() % 10000}`;
await turn(A, `Сохрани в свою автоматическую память (memory) факт: цвет для метки «${run}» — «${color}». Запиши файлом памяти, подтверди одним словом.`);
const before = Date.now();
const pushed = await wait(async () => {
  const r = await req({ type: "machine.profiles", v: 2, machine: M1, sync: true });
  const repo = r.result?.repos?.[process.env.FLOW_REPO!];
  return repo?.state === "ok" && repo.at >= before;
}, 120000);
const st1 = (await req({ type: "machine.profiles", v: 2, machine: M1 })).result?.repos?.[process.env.FLOW_REPO!];
check(`${M1}: память профиля закоммичена и отправлена`, pushed, st1);
const pulled = await wait(async () => (await req({ type: "machine.profiles", v: 2, machine: M2, sync: true })).result?.repos?.[process.env.FLOW_REPO!]?.state === "ok", 60000);
check(`${M2}: синхронизация ok`, pulled);

// --- профиль в session.open на другой машине: память пришла ---
const B = `prof@${M2}`;
await req({ type: "session.remove", callsign: B });
const pre = await req({ type: "session.profile", v: 2, callsign: B, profile: [ID] });
check("session.profile сессии, которой нет, — offline: профиль новой — полем session.open", !pre.ok && pre.error === "offline", pre.error ?? pre.result);
await req({ type: "session.open", v: 2, machine: M2, name: "prof", dir, model: "claude-haiku-4-5", profile: [ID] });
await state(B, "idle");
check("сессия открылась сразу с профилем", rec(B)?.profile?.[0]?.id === ID, rec(B)?.profile);
const recall = await turn(B, `Какой цвет для метки «${run}»? Посмотри в своей памяти и повтори запись дословно, вместе с цифрами.`);
check(`${M2}: память профиля с другой машины`, recall.includes(color), recall);

// --- снятие профиля ---
const un = await req({ type: "session.profile", v: 2, callsign: A, profile: [] });
check("снятие профиля — перезапуск", un.ok && un.result.restart === true, un.result ?? un.error);
await wait(() => !rec(A)?.profile, 60000);
await state(A, "idle");
check("roster без поля profile", !rec(A)?.profile, rec(A)?.profile);
// сессия без истории: профиль в session.open, снят до первого хода — перезапуск тем же id заново, не resume
const { cs: C } = await open(M1, "bare");
await req({ type: "session.remove", callsign: C });
await req({ type: "session.open", v: 2, machine: M1, name: "bare", dir, model: "claude-haiku-4-5", profile: [ID] });
await state(C, "idle");
const unC = await req({ type: "session.profile", v: 2, callsign: C, profile: [] });
check("снятие профиля до первого хода — перезапуск", unC.ok && unC.result.restart === true, unC.result ?? unC.error);
await wait(() => !rec(C)?.profile, 60000);
await state(C, "idle");
const bare = await turn(C, "Какой у тебя профиль? Если в инструкциях профиля нет — ответь «нет».");
check("перезапуск до первого хода поднял сессию, CLAUDE.md профиля не в промпте", rec(C)?.state === "idle" && !/сова-42/.test(bare), { state: rec(C)?.state, bare });

for (const cs of [A, B, C]) await req({ type: "session.remove", callsign: cs });
l.close(1000, "done");
console.log(fails.length ? `profiles: ${fails.length} провалов` : "profiles: ok");
process.exit(fails.length ? 1 : 0);
