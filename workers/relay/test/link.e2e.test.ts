// link насквозь: Node 24 (глобальный WebSocket) → relay в miniflare → настоящий gate по привязке.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sign } from "../../gate/src/key.ts";
import { link, type Link, type LinkState } from "../contract.ts";

const OWNER = "owner@example.com";
/** адрес устройства владельца флота: ключи клиентов выданы ему */
const dev = (n: string) => `${n}~${OWNER}`;
import type { Frame } from "@switchboard/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "e2e-secret";
const bundle = (entry: string) =>
  buildSync({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", external: ["cloudflare:workers"], write: false }).outputFiles[0].text;

let mf: Miniflare;
let url: string;
const links: Link[] = [];

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [
      {
        name: "switchboard",
        modules: true,
        script: bundle(join(here, "..", "src", "index.ts")),
        compatibilityDate: "2026-08-01",
        durableObjects: { FLEET: { className: "Fleet", useSQLite: true } },
        serviceBindings: { GATE: { name: "switchboard-gate", entrypoint: "Gate" } },
        bindings: { PROTO: [1], PARTICIPANTS: {}, OWNER: "owner@example.com" },
      },
      {
        name: "switchboard-gate",
        modules: true,
        script: bundle(join(here, "..", "..", "gate", "src", "index.ts")),
        compatibilityDate: "2026-08-01",
        bindings: { FLEET_SECRET: SECRET, REVOKED: ["client.phone.k2a9"] },
      },
    ],
  }));
  url = (await mf.ready).href.replace(/^http/, "ws");
}, 60_000);

afterAll(async () => {
  for (const l of links) l.close();
  await mf?.dispose();
});

async function until<T>(get: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function open(key: string, hello?: () => Record<string, unknown>, onFrame?: (f: Frame) => void) {
  const states: Array<[LinkState, string | undefined]> = [];
  const l = link({ url, key, hello, onFrame, onState: (s, why) => states.push([s, why]), pauseMs: 100 });
  links.push(l);
  return { l, states };
}

describe("link · насквозь через relay и gate", () => {
  it("Host и пульт: запрос по callsign, ответ Host по from; уход Host — ждущий запрос disconnected", async () => {
    const hostFrames: Frame[] = [];
    const host = open(
      await sign(SECRET, "host", "laptop", "k7f3"),
      () => ({ sdk: "0.3.311", contract: { "session.history": 1 }, sessions: [{ callsign: "site@laptop", state: "idle" }] }),
      (f) => hostFrames.push(f),
    );
    await until(() => host.l.state === "open");
    const panel = open(await sign(SECRET, "client", "panel-desk", "k3f1"));
    await until(() => panel.l.state === "open" && panel.l.roster?.machines.length === 1);
    expect(panel.l.roster?.sessions).toEqual([{ callsign: "site@laptop", state: "idle" }]);
    expect(panel.l.roster?.machines[0]).toMatchObject({ machine: "laptop", proto: 1, sdk: "0.3.311", contract: { "session.history": 1 } });

    // запрос → Host → ответ по from
    const p = panel.l.request({ type: "session.history", callsign: "site@laptop" });
    const req = await until(() => hostFrames.find((f) => f.type === "session.history"));
    expect(req.from).toBe(dev("panel-desk"));
    expect(host.l.send({ type: "reply", id: req.id!, to: req.from, ok: true, result: { turns: 3 } })).toBe(true);
    expect(await p).toMatchObject({ ok: true, result: { turns: 3 }, from: "@laptop" });

    // адресата нет — offline от relay
    expect(await panel.l.request({ type: "session.open", machine: "pc" })).toMatchObject({ ok: false, error: "offline" });

    // Host ушёл, пока пульт ждал — disconnected по roster
    const waiting = panel.l.request({ type: "session.history", callsign: "site@laptop" });
    await until(() => hostFrames.filter((f) => f.type === "session.history").length === 2);
    host.l.close(1000, "shutting_down");
    expect(await waiting).toMatchObject({ ok: false, error: "disconnected" });
    expect(host.states.at(-1)).toEqual(["stopped", "shutting_down"]);
  }, 30_000);

  it("ping → pong автоответом relay: связь живёт дольше нескольких периодов ping", async () => {
    const l = link({ url, key: await sign(SECRET, "client", "nightly", "p0w2"), pingMs: 100 });
    links.push(l);
    await until(() => l.state === "open");
    await new Promise((r) => setTimeout(r, 600));
    expect(l.state).toBe("open");
  }, 30_000);

  it("отказ gate — stopped со словом, без переподключений: чужой секрет bad_key, отозванный revoked", async () => {
    const bad = open(await sign("чужой", "client", "phone", "k8e1"));
    await until(() => bad.l.state === "stopped");
    expect(bad.states.at(-1)).toEqual(["stopped", "bad_key"]);
    const old = open(await sign(SECRET, "client", "phone", "k2a9"));
    await until(() => old.l.state === "stopped");
    expect(old.states.at(-1)).toEqual(["stopped", "revoked"]);
  }, 30_000);

  it("второй Host той же машины вытесняет первый: replaced — stopped, без переподключения", async () => {
    const key = await sign(SECRET, "host", "pc", "m3d1");
    const first = open(key);
    await until(() => first.l.state === "open");
    const second = open(key);
    await until(() => second.l.state === "open");
    await until(() => first.l.state === "stopped");
    expect(first.states.at(-1)).toEqual(["stopped", "replaced"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(second.l.state).toBe("open");
  }, 30_000);
});
