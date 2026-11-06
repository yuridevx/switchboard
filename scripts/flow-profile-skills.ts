// Живой сценарий скилов профиля: репозиторий профилей сведён на машинах, у процесса сессии с профилем есть его скил
// как «<папка>:<скил>». Репозиторий — в ключе fleet.profiles.repos настроек флота. env: FLOW_CLIENT_KEY,
// FLOW_MACHINES (через запятую), FLOW_DIR, FLOW_REPO (владелец/имя), FLOW_PROFILE (папка со skills/), FLOW_SKILL.
import { type Roster } from "@switchboard/relay";
import { client } from "./client.ts";

const MS = process.env.FLOW_MACHINES!.split(",");
const REPO = process.env.FLOW_REPO!;
const NAME = process.env.FLOW_PROFILE!;
const ID = `${REPO}/${NAME}`;
const l = client(process.env.FLOW_CLIENT_KEY!);
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 300)}`);
  if (!ok) fails.push(n);
};
const req = async (f: Record<string, unknown>) => (await l.request({ v: 1, ...f } as never)) as { ok: boolean; result?: any; error?: string };
const rec = (cs: string) => (l.roster as Roster | null)?.sessions.find((s) => s.callsign === cs) as Record<string, any> | undefined;
const wait = async (ok: () => boolean, ms: number) => {
  for (const t0 = Date.now(); !ok(); ) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return true;
};
const state = (cs: string, s: string, ms = 120000) => wait(() => rec(cs)?.state === s, ms);

await wait(() => l.state === "open" && MS.every((m) => (l.roster as Roster | null)?.machines.some((x) => x.machine === m)), 120000);

for (const m of MS) {
  const p = await req({ type: "machine.profiles", v: 2, machine: m, sync: true });
  const repo = p.result?.repos?.[REPO];
  check(`${m}: репозиторий сведён, профиль в списке`, p.ok && repo?.state === "ok" && !!p.result.profiles[ID], { repo, profiles: Object.keys(p.result?.profiles ?? {}).filter((k) => k.startsWith(REPO)) });

  const cs = `skills@${m}`;
  await req({ type: "session.remove", callsign: cs });
  await req({ type: "session.open", v: 2, machine: m, name: "skills", dir: process.env.FLOW_DIR, model: "claude-haiku-4-5", profile: [ID] });
  await state(cs, "idle");
  check(`${m}: сессия с профилем, состояние ok`, rec(cs)?.profile?.[0]?.id === ID && rec(cs)?.profile?.[0]?.state === "ok", rec(cs)?.profile);
  // список команд процесса claude: скилы плагина профиля — «<папка>:<скил>»
  const c = await req({ type: "session.call", callsign: cs, method: "supportedCommands" });
  const mine = ((c.result ?? []) as { name: string }[]).map((x) => x.name).filter((n) => n.startsWith(`${NAME}:`));
  check(`${m}: скил ${NAME}:${process.env.FLOW_SKILL} в сессии`, mine.includes(`${NAME}:${process.env.FLOW_SKILL}`), mine);
  await req({ type: "session.remove", callsign: cs });
}

l.close(1000, "done");
console.log(fails.length ? `profile-skills: ${fails.length} провалов` : "profile-skills: ok");
process.exit(fails.length ? 1 : 0);
