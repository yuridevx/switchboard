// Живая проверка флота: node tools/fleet/smoke.ts <флот> [устройство]
// Зовёт по одному запросу каждого вида цели и открывает соединение страницы; печатает исход и путь запроса по частям.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApi, httpTransport, ledgerRead, obsRecent, passes, peopleList, prefsGet, prefsSet, whoami, type Frame, type RequestDef } from "@sb/protocol";

const dir = path.join(os.homedir(), ".switchboard-dev");
const env = Object.fromEntries(fs.readFileSync(path.join(dir, "v2-fleet.env"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const [fleet = "test", device = "cli"] = process.argv.slice(2);
const key = fs.readFileSync(path.join(dir, `v2-${fleet}-${device}.pass`), "utf8").trim();
const transport = httpTransport({ base: env.SB2_BASE!, key });
const api = createApi(transport);

let bad = 0;
async function step<I, O>(def: RequestDef<I, O>, input: I, show: (o: O) => string) {
  const t0 = Date.now();
  try {
    const o = await api.call(def, input as never);
    console.log(`✓ ${def.name} · ${Date.now() - t0} мс · ${show(o as O)}`);
  } catch (e) {
    bad++;
    console.log(`✗ ${def.name} · ${(e as Error).message}`);
  }
}

await step(whoami, {}, (o) => `${o.addr}, админ: ${o.admin}, машин: ${o.machines.length}`);
await step(peopleList, {}, (o) => `людей ${o.people.length}, проектов ${o.projects.length}`);
await step(passes, {}, (o) => `пропусков ${o.passes.length}`);
await step(prefsSet, { scope: "me", name: "smoke", value: { at: Date.now() } }, () => "записано");
await step(prefsGet, { scope: "me", prefix: "smoke" }, (o) => `ключей ${Object.keys(o.values).length}`);
await step(ledgerRead, { limit: 5 }, (o) => `событий ${o.events.length}`);
await step(obsRecent, { limit: 5 }, (o) => `строк ${o.rows.length}; последняя: ${o.rows[0]?.type} ${JSON.stringify(o.rows[0]?.spans ?? [])}`);

const roster = await new Promise<Frame | null>((res) => {
  const timer = setTimeout(() => (link.close(), res(null)), 10_000);
  const link = transport.open("page", { onFrame: (f) => f.type === "roster" && (clearTimeout(timer), link.close(), res(f)) });
});
if (roster) console.log(`✓ картина · машин ${(roster.machines as unknown[]).length}, сессий ${(roster.sessions as unknown[]).length}`);
else {
  bad++;
  console.log("✗ картина не пришла за 10 с");
}
console.log(bad ? `сбоев: ${bad}` : "флот отвечает");
process.exit(bad ? 1 : 0);
