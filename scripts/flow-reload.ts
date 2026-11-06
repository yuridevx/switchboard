// Живой сценарий перечитывания. Шаги — аргументы, между ними сценарий выходит, сессии живут: выкладка идёт снаружи.
//   open                 открыть сессии reload@<машина>, запомнить инструмент fleet.history
//   tools <есть|нет>     у той же сессии инструмент FLOW_TOOL (сервер:имя) есть или нет
//   schema <YES|NO>      модель той же сессии отвечает, есть ли в схеме fleet.history поле people
//   skill                файл уже лежит в кусочке: session.reload, скил есть в списке команд
//   noskill              файл убран: session.reload, скила нет в списке команд
//   close                убрать сессии
// env: FLOW_CLIENT_KEY, FLOW_MACHINES, FLOW_DIR, FLOW_PROFILE (id кусочка), FLOW_SKILL (плагин:скил), FLOW_TOOL.
import { type Roster } from "@switchboard/relay";
import { client } from "./client.ts";

const MS = process.env.FLOW_MACHINES!.split(",");
const [step, arg] = process.argv.slice(2);
const l = client(process.env.FLOW_CLIENT_KEY!);
const fails: string[] = [];
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${n}${d === undefined ? "" : " · " + JSON.stringify(d).slice(0, 300)}`);
  if (!ok) fails.push(n);
};
const req = async (f: Record<string, unknown>) => (await l.request({ v: 1, ...f } as never)) as { ok: boolean; result?: any; error?: string; why?: string };
const rec = (cs: string) => (l.roster as Roster | null)?.sessions.find((s) => s.callsign === cs) as Record<string, any> | undefined;
const wait = async (ok: () => boolean, ms: number) => {
  for (const t0 = Date.now(); !ok(); ) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return true;
};
/** Инструменты встроенного сервера глазами Claude: статус MCP отдаёт имена, схем не отдаёт. */
const tools = async (cs: string, server: string) => {
  const r = await req({ type: "session.call", callsign: cs, method: "mcpServerStatus" });
  return ((r.result ?? []) as Array<{ name: string; tools?: Array<{ name: string }> }>).find((s) => s.name === server)?.tools?.map((t) => t.name) ?? [];
};

await wait(() => l.state === "open" && MS.every((m) => (l.roster as Roster | null)?.machines.some((x) => x.machine === m)), 120_000);

for (const m of MS) {
  const cs = `reload@${m}`;
  if (step === "open") {
    await req({ type: "session.remove", callsign: cs });
    const r = await req({ type: "session.open", v: 2, machine: m, name: "reload", dir: process.env.FLOW_DIR, model: "claude-haiku-4-5", ...(process.env.FLOW_PROFILE ? { profile: [process.env.FLOW_PROFILE] } : {}) });
    check(`${m}: сессия открыта`, r.ok, r.error ?? r.why);
    check(`${m}: сессия idle`, await wait(() => rec(cs)?.state === "idle", 120_000), rec(cs)?.state);
    check(`${m}: инструменты fleet видны`, (await tools(cs, "fleet")).length > 0);
  }
  if (step === "tools") {
    check(`${m}: сессия жива`, await wait(() => rec(cs)?.state === "idle", 120_000), rec(cs)?.state);
    const [server, name] = process.env.FLOW_TOOL!.split(":");
    const list = await tools(cs, server);
    check(`${m}: ${server}.${name} ${arg}`, list.includes(name) === (arg === "есть"), list);
  }
  if (step === "schema") {
    check(`${m}: сессия жива`, await wait(() => rec(cs)?.state === "idle", 120_000), rec(cs)?.state);
    const { session_id: before } = (await req({ type: "session.call", callsign: cs, method: "initializationResult" })).result ?? {};
    await req({ type: "session.prompt", callsign: cs, text: 'Use ToolSearch with query "select:mcp__fleet__history". Does the input schema of that tool have a property named people? Reply with exactly one word: YES or NO.' });
    await wait(() => rec(cs)?.state !== "idle", 30_000);
    check(`${m}: ход окончен`, await wait(() => rec(cs)?.state === "idle", 120_000));
    const h = await req({ type: "session.history", callsign: cs, before: null, limit: 8 });
    const said = ((h.result?.messages ?? []) as Array<{ type: string; message?: { content?: Array<{ type: string; text?: string }> } }>).filter((x) => x.type === "assistant").flatMap((x) => x.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").at(-1);
    check(`${m}: модель видит people = ${arg}`, (said ?? "").trim().toUpperCase().startsWith(arg), { said, before });
  }
  if (step === "skill" || step === "noskill") {
    const name = process.env.FLOW_SKILL!;
    const t0 = Date.now();
    const r = await req({ type: "session.reload", callsign: cs });
    const ms = Date.now() - t0;
    check(`${m}: session.reload`, r.ok, { ms, error: r.error, why: r.why });
    const c = await req({ type: "session.call", callsign: cs, method: "supportedCommands" });
    const names = ((c.result ?? []) as Array<{ name: string }>).map((x) => x.name);
    check(`${m}: скил ${name} ${step === "skill" ? "есть" : "нет"}`, names.includes(name) === (step === "skill"), names.filter((n) => n.includes(":")).slice(0, 12));
    check(`${m}: процесс не перезапущен`, rec(cs)?.state === "idle", rec(cs)?.state);
  }
  if (step === "close") check(`${m}: сессия убрана`, (await req({ type: "session.remove", callsign: cs })).ok);
}

l.close(1000, "done");
console.log(fails.length ? `reload ${step}: ${fails.length} провалов` : `reload ${step}: ok`);
process.exit(fails.length ? 1 : 0);
