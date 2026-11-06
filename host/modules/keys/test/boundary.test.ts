// Леса границы «пропуск участника», сторона Host: инструменты keys на стенде Host, gate и вход relay — ответы поддельного relay.
// Вход — инструмент MCP сессии, исход — кадр и текст модели. Тексты инструментов читает модель: держатся слово в слово. Номер — эталон; без номера — чьё: код.
import { afterEach, describe, expect, it, vi } from "vitest";
import { stand } from "@switchboard/host";
import type { Frame, Manifest } from "@switchboard/host";
import manifest from "../module.json" with { type: "json" };
import { make } from "../contract.ts";

const stands: stand.Stand[] = [];
afterEach(async () => {
  for (const s of stands.splice(0)) await s.close();
});

async function bench(serve: (f: Frame) => Record<string, unknown> | null) {
  const k = make();
  const st = await stand.standHost({ modules: [{ manifest: manifest as Manifest, module: k.module }] });
  stands.push(st);
  const recv = st.relay.receive.bind(st.relay);
  st.relay.receive = (ws, t) => {
    recv(ws, t);
    const f = JSON.parse(t) as Frame;
    if (f.type === "hello" || f.type === "reply" || typeof f.id !== "string") return;
    const answer = serve(f);
    if (answer) queueMicrotask(() => st.relay.deliver({ type: "reply", id: f.id as string, ...answer } as Frame));
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await k.tools().find((x) => x.name === name)!.handler(args as never, {})) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0].text, isError: !!r.isError };
  };
  const sent = (type: string) => st.relay.sent.filter((f) => f.type === type);
  return { st, call, sent };
}

describe("инструменты keys", () => {
  it("5091 · invite и list зовут gate, revoke — вход relay; ответ как есть, с отступами; отказ — словом с именем запроса", async () => {
    const { st, call } = await bench((f) =>
      f.name === "taken" || f.kid === "gone"
        ? { ok: false, error: f.name === "taken" ? "name_taken" : "unknown_key" }
        : { ok: true, result: f.type === "keys.invite" ? { kid: "p3a1", invite: "p3a1.S", addr: "phone~a@b" } : f.type === "keys.list" ? { passes: [] } : { addr: "phone~a@b", closed: 2 } },
    );
    expect(await call("invite", { role: "client", name: "phone", person: "a@b" })).toEqual({ text: JSON.stringify({ kid: "p3a1", invite: "p3a1.S", addr: "phone~a@b" }, null, 2), isError: false });
    expect(await call("invite", { role: "client", name: "taken", person: "a@b" })).toEqual({ text: "keys.invite: name_taken", isError: true });
    expect(JSON.parse((await call("list", { role: "host" })).text)).toEqual({ passes: [] });
    expect(JSON.parse((await call("revoke", { kid: "p3a1" })).text)).toEqual({ addr: "phone~a@b", closed: 2 });
    expect(await call("revoke", { kid: "gone" })).toEqual({ text: "keys.revoke: unknown_key", isError: true });
    expect(st.relay.sent.filter((f) => f.type.startsWith("keys.")).map((f) => [f.type, f.to, f.v])).toEqual([
      ["keys.invite", ".gate", 1],
      ["keys.invite", ".gate", 1],
      ["keys.list", ".gate", 1],
      ["keys.revoke", ".relay", 1],
      ["keys.revoke", ".relay", 1],
    ]);
  });

  it("поля кадра: invite без person — поля нет; list без роли — поля нет; с ролью — есть; revoke — номер", async () => {
    const { call, sent } = await bench(() => ({ ok: true, result: {} }));
    await call("invite", { role: "host", name: "laptop" });
    await call("invite", { role: "client", name: "phone", person: "a@b" });
    await call("invite", { role: "host", name: "laptop2", person: "" });
    await call("list", {});
    await call("list", { role: "client" });
    await call("revoke", { kid: "k1" });
    const [a, b, empty] = sent("keys.invite");
    expect(a).toMatchObject({ role: "host", name: "laptop" });
    expect(a).not.toHaveProperty("person");
    expect(b).toMatchObject({ role: "client", name: "phone", person: "a@b" });
    expect(empty).not.toHaveProperty("person");
    const [c, d] = sent("keys.list");
    expect(c).not.toHaveProperty("role");
    expect(d).toMatchObject({ role: "client" });
    expect(sent("keys.revoke")[0]).toMatchObject({ kid: "k1" });
  });

  it("каждой сессии — сервер MCP keys с тремя инструментами", async () => {
    const { st } = await bench(() => ({ ok: true, result: {} }));
    await st.open("site@laptop");
    const servers = st.query("site@laptop").options.mcpServers as Record<string, { name?: string }>;
    expect(Object.keys(servers)).toContain("keys");
    expect(servers.keys).toMatchObject({ name: "keys" });
  });

  it("тексты инструментов и подписи полей — слово в слово: их читает модель", () => {
    const tools = make().tools() as unknown as Array<{ name: string; description: string; inputSchema: Record<string, { description?: string }> }>;
    const params = (t: (typeof tools)[number]) => Object.fromEntries(Object.entries(t.inputSchema).map(([k, v]) => [k, v.description ?? null]));
    expect(tools.map((t) => [t.name, t.description, params(t)])).toEqual([
      [
        "invite",
        "Выдать пропуск флота одноразовым приглашением. Машина — role host и имя машины: приглашение принимает keeper install. Устройство или программа — role client, имя и почта человека: телефон и пульт принимают приглашение ссылкой с #invite=<приглашение> или в поле ввода, программа — switchboard redeem. У адреса один живой пропуск: занят — name_taken, сначала отзовите прежний.",
        { role: null, name: "имя машины, устройства или программы: A-Z a-z 0-9 _ -", person: "почта человека за устройством или программой; у машины нет" },
      ],
      ["list", "Пропуска флота: номер, роль, имя, человек, адрес, состояние (wait — приглашение не принято, ok), кем выдан и когда. role — только принятые этой роли.", { role: null }],
      ["revoke", "Отозвать пропуск или непринятое приглашение по номеру: отметка у gate, соединения с этим номером закрыты на всех машинах сразу. Пропуска, выданные отозванным, живут — смотрите их по «кем» в list.", { kid: "номер пропуска" }],
    ]);
    // схему видит модель, handler мимо неё: роли держатся здесь
    const role = tools[0].inputSchema.role as unknown as { safeParse(x: string): { success: boolean } };
    expect(["host", "client", "admin"].map((r) => role.safeParse(r).success)).toEqual([true, true, false]);
  });

  it("молчание gate: list — чтение, timeout за 10 с; invite за эти 10 с ещё ждёт", async () => {
    const { call } = await bench(() => null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let invited = false;
      void call("invite", { role: "host", name: "laptop" }).then(() => (invited = true));
      const list = call("list", {});
      await vi.advanceTimersByTimeAsync(10_100);
      expect(await list).toEqual({ text: "keys.list: timeout", isError: true });
      expect(invited).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
