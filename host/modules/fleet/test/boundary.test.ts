// Леса границы «пропуск сессии и сервер MCP флота», сторона Host: модуль fleet на стенде Host, gate и relay — ответы поддельного relay.
// Вход — открытие, перезапуск и remove сессии; исход — кадры keys.*, gate.redeem и mcpServers сессии. Номер — эталон дизайна «Идентификация».
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../contract.ts";

const stands: stand.Stand[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

async function bench(serve: (f: Frame) => Record<string, unknown> | null) {
  const st = await stand.standHost({ modules: [{ manifest: manifest as Manifest, module: make().module }], workers: { mcp: "https://mcp.stand/" } });
  stands.push(st);
  const recv = st.relay.receive.bind(st.relay);
  st.relay.receive = (ws, t) => {
    recv(ws, t);
    const f = JSON.parse(t) as Frame;
    if (f.type === "hello" || f.type === "reply" || typeof f.id !== "string") return;
    const answer = serve(f);
    if (answer) queueMicrotask(() => st.relay.deliver({ type: "reply", id: f.id as string, ...answer } as Frame));
  };
  return st;
}

const PASSES = { "keys.invite": { ok: true, result: { kid: "k4ab", invite: "k4ab.INV", addr: "site@laptop" } }, "gate.redeem": { ok: true, result: { key: "site.k4ab.SECRET", addr: "site@laptop", kid: "k4ab" } }, "keys.revoke": { ok: true, result: { addr: "site@laptop", closed: 0 } } };
const reply = (f: Frame) => (PASSES as Record<string, Record<string, unknown>>)[f.type] ?? null;

describe("пропуск сессии", () => {
  it("24 · открытие: keys.invite с адресом сессии и redeem один раз; mcpServers.switchboard с пропуском; перезапуск — из раздела, без сети; remove — отзыв", async () => {
    const st = await bench(reply);
    await st.open("site@laptop");
    expect(st.relay.sent.filter((f) => f.type === "keys.invite").map((f) => [f.addr, f.to, f.v])).toEqual([["site@laptop", ".gate", 2]]);
    expect(st.relay.sent.filter((f) => f.type === "gate.redeem").map((f) => f.invite)).toEqual(["k4ab.INV"]);
    const servers = () => st.query("site@laptop").options.mcpServers as Record<string, unknown>;
    expect(servers().switchboard).toEqual({ type: "http", url: "https://mcp.stand/mcp", headers: { Authorization: "Bearer site.k4ab.SECRET" } });
    expect(servers().fleet).toBeDefined();

    const s = st.session("host-fleet", "site@laptop")!;
    await s.restart();
    expect(servers().switchboard).toMatchObject({ headers: { Authorization: "Bearer site.k4ab.SECRET" } });
    expect(st.relay.sent.filter((f) => f.type === "keys.invite")).toHaveLength(1);

    await s.remove();
    await stand.until(() => st.relay.sent.some((f) => f.type === "keys.revoke"));
    expect(st.relay.sent.filter((f) => f.type === "keys.revoke").map((f) => [f.kid, f.to])).toEqual([["k4ab", ".relay"]]);
  });

  it("gate отказал — сессия идёт без сервера switchboard, причина в журнале", async () => {
    const st = await bench((f) => (f.type === "keys.invite" ? { ok: false, error: "name_taken" } : reply(f)));
    await st.open("site@laptop");
    expect(st.query("site@laptop").options.mcpServers).not.toHaveProperty("switchboard");
    expect(st.journal()).toContainEqual(expect.objectContaining({ ev: "session.pass", word: "name_taken", callsign: "site@laptop" }));
  });

  it("gate молчит — за предел чтения сессия идёт без сервера switchboard, fleet в сессии жив", async () => {
    const st = await bench((f) => (f.type === "keys.invite" ? null : reply(f)));
    await st.open("site@laptop");
    const servers = st.query("site@laptop").options.mcpServers as Record<string, unknown>;
    expect(servers).not.toHaveProperty("switchboard");
    expect(servers.fleet).toBeDefined();
    expect(st.journal()).toContainEqual(expect.objectContaining({ ev: "session.pass", word: "timeout", callsign: "site@laptop" }));
  }, 30_000);
});
