// Эталон модуля keys 5091 на стенде Host: gate и вход relay отвечают через поддельный relay; инструменты — обработчиком tool().
import { afterEach, describe, expect, it } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../src/keys.ts";

const stands: stand.Stand[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

async function bench(serve: (f: Frame) => Record<string, unknown>) {
  const k = make();
  const st = await stand.standHost({ modules: [{ manifest: manifest as Manifest, module: k.module }] });
  stands.push(st);
  const recv = st.relay.receive.bind(st.relay);
  st.relay.receive = (ws, t) => {
    recv(ws, t);
    const f = JSON.parse(t) as Frame;
    if (f.type === "hello" || f.type === "reply" || typeof f.id !== "string") return;
    queueMicrotask(() => st.relay.deliver({ type: "reply", id: f.id as string, ...serve(f) } as Frame));
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await k.tools().find((x) => x.name === name)!.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0].text, isError: !!r.isError };
  };
  return { st, call };
}

describe("эталоны keys", () => {
  it("5091 · invite и list зовут gate, revoke — вход relay; ответ как есть; отказ — словом", async () => {
    const { st, call } = await bench((f) =>
      f.type === "keys.invite" && f.name === "taken"
        ? { ok: false, error: "name_taken" }
        : { ok: true, result: f.type === "keys.invite" ? { kid: "p3a1", invite: "p3a1.S", addr: "phone~a@b" } : f.type === "keys.list" ? { passes: [] } : { addr: "phone~a@b", closed: 2 } },
    );
    expect(JSON.parse((await call("invite", { role: "client", name: "phone", person: "a@b" })).text)).toEqual({ kid: "p3a1", invite: "p3a1.S", addr: "phone~a@b" });
    expect(await call("invite", { role: "client", name: "taken", person: "a@b" })).toEqual({ text: "keys.invite: name_taken", isError: true });
    expect(JSON.parse((await call("list", { role: "host" })).text)).toEqual({ passes: [] });
    expect(JSON.parse((await call("revoke", { kid: "p3a1" })).text)).toEqual({ addr: "phone~a@b", closed: 2 });
    expect(st.relay.sent.filter((f) => f.type.startsWith("keys.")).map((f) => [f.type, f.to, f.v])).toEqual([
      ["keys.invite", ".gate", 1],
      ["keys.invite", ".gate", 1],
      ["keys.list", ".gate", 1],
      ["keys.revoke", ".relay", 1],
    ]);
  });
});
