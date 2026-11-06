// Выкладка на флот: FLEET=test|prod node scripts/fleet.ts <команда>. Пропуск — ~/.switchboard-dev/<флот>-agent.pass.
//   state                     stable, машины, keeper и Host на каждой, сессии
//   deploy '<json>' | set '<json>'   releases.deploy и releases.set
//   sessions save <файл>      снимок сессий по именам до выкладки
//   sessions check <файл>     сверка: кого нет и кто новый; потеря — код 1
//   page                      настоящие страницы в Chromium: проверочный пропуск, ошибки страницы, отзыв пропуска
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pageOf, passFile } from "./fleets.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONNECT_MS = 30_000;
const SETTLE_MS = 2_000;
const PAGE_MS = 15_000;
const prod = process.env.FLEET === "prod";
if (!prod && process.env.FLEET !== "test") {
  console.error("fleet: FLEET=test или FLEET=prod");
  process.exit(2);
}
if (prod) {
  process.env.SWITCHBOARD_WORKERS = JSON.stringify(Object.fromEntries(["relay", "gate", "push", "points", "ledger", "github", "prefs", "fleetkeys", "releases"].map((n) => [n, `https://${n}.pfarm.app/`])));
}
const PAGES = ["pult", "phone"].map((app) => pageOf(prod ? "prod" : "test", app));
const VIEWPORT = { width: 1280, height: 800 };

type Session = { callsign: string; state: string };
const { client } = await import(pathToFileURL(join(ROOT, "scripts", "client.ts")).href);
const c = client(readFileSync(passFile(prod ? "prod" : "test"), "utf8").trim());
for (const end = Date.now() + CONNECT_MS; c.state !== "open" && Date.now() < end; ) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, SETTLE_MS));
const ask = (f: Record<string, unknown>, read = false) => c.request({ v: 1, ...f }, read);
const sessions = () => (c.roster?.sessions ?? []) as Session[];

async function state(): Promise<number> {
  const r = await ask({ type: "releases.list", to: ".releases" }, true);
  if (!r.ok) throw new Error(`releases.list: ${r.error}`);
  const parts = r.result.parts;
  console.log("stable:", ["host", "pult", "phone", "keeper"].map((n) => `${n} ${parts[n]?.stable ?? "-"}`).join(" · "));
  const machines = (c.roster?.machines ?? []) as Array<{ machine: string }>;
  const all = sessions();
  const by: Record<string, number> = {};
  for (const s of all) by[s.state] = (by[s.state] ?? 0) + 1;
  console.log("сессии:", all.length, JSON.stringify(by));
  for (const { machine } of machines) {
    const k = await ask({ type: "keeper.state", to: `.keeper@${machine}` }, true).catch((e: Error) => ({ ok: false, error: e.message }));
    if (!k.ok) {
      console.log(`  ${machine}: keeper.state ${k.error}`);
      continue;
    }
    const held = (k.result.parts ?? []) as Array<{ part: string; version: string; state: string }>;
    console.log(`  ${machine}: keeper ${k.result.keeper} · ${held.map((p) => `${p.part} ${p.version} ${p.state}`).join(" · ")}`);
  }
  return 0;
}

async function release(type: string, json: string): Promise<number> {
  const r = await ask({ type: `releases.${type}`, to: ".releases", ...JSON.parse(json) });
  console.log(JSON.stringify(r.ok ? r.result : r.error));
  return r.ok ? 0 : 1;
}

function snapshot(action: string, file: string): number {
  const names = sessions().map((s) => s.callsign).sort();
  if (action === "save") {
    writeFileSync(file, JSON.stringify(names, null, 1));
    console.log(`сессий ${names.length}: ${file}`);
    return 0;
  }
  if (!existsSync(file)) throw new Error(`нет снимка ${file}`);
  const before = JSON.parse(readFileSync(file, "utf8")) as string[];
  const lost = before.filter((n) => !names.includes(n));
  const fresh = names.filter((n) => !before.includes(n));
  console.log(`сессий ${before.length} → ${names.length}; пропали: ${lost.join(", ") || "нет"}; новые: ${fresh.join(", ") || "нет"}`);
  return lost.length ? 1 : 0;
}

/** Страница вошла: приглашение принято, на экране раздел «Вам», ошибок страницы нет. Приглашение одноразовое: своё на страницу. */
async function openPage(browser: { newContext(o: unknown): Promise<any> }, url: string): Promise<boolean> {
  const invite = await ask({ type: "keys.invite", to: ".gate", role: "client", name: "fleet-check", person: "fleet-check@example.com" });
  if (!invite.ok) throw new Error(`keys.invite: ${invite.error}`);
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const p = await context.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e: Error) => errors.push(e.message));
    await p.goto(`${url}#invite=${invite.result.invite}`);
    await p.waitForTimeout(PAGE_MS);
    const text = (await p.innerText("body")).replace(/\s+/g, " ");
    console.log(`${url} · ошибок страницы ${errors.length} · ${text.slice(0, 200)}`);
    if (errors.length) console.log(errors.slice(0, 3).join(" | ").slice(0, 300));
    await context.close();
    return !errors.length && text.includes("Вам");
  } finally {
    const r = await ask({ type: "keys.revoke", to: ".relay", kid: invite.result.kid });
    console.log(`пропуск ${invite.result.kid}: ${r.ok ? "отозван" : r.error}`);
  }
}

async function page(): Promise<number> {
  const { chromium } = createRequire(join(ROOT, "package.json"))("playwright-core");
  const browser = await chromium.launch();
  try {
    let code = 0;
    for (const url of PAGES) if (!(await openPage(browser, url))) code = 1;
    return code;
  } finally {
    await browser.close();
  }
}

const [command, a, b] = process.argv.slice(2);
let code = 2;
try {
  if (command === "state") code = await state();
  else if (command === "deploy" || command === "set") code = await release(command, a);
  else if (command === "sessions" && (a === "save" || a === "check") && b) code = snapshot(a, b);
  else if (command === "page") code = await page();
  else console.error("fleet: state | deploy '<json>' | set '<json>' | sessions save|check <файл> | page");
} catch (e) {
  console.error(`fleet: ${(e as Error).message}`);
  code = 1;
}
c.close(1000, "done");
process.exit(code);
