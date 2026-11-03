// Приглашение в адресе при уже имеющемся пропуске: ссылку может подсунуть кто угодно (ответ сессии, письмо), поэтому пропуск не меняется без человека.
// Источник: решение главной сессии по находке слепого расширения плана: приглашение выдаёт любой пропуск, значит и сессия; пропуск замещался молча.
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStore, type AppPart } from "../contract.ts";
import { FakeRelay, flush, KEY, stand } from "../stand/app.ts";
import { INVITE, oneMachine } from "../stand/relay.ts";

const OTHER = "client.phone.q7w1.Zzsig";
const part = (): AppPart => ({
  manifest: { name: "web-x", type: "web", version: "1.0.0", provides: { list: 1 }, uses: { "app@web-core": 1 } },
  module: { screens: { list: { nav: "Список", view: () => null, head: () => ({ title: "Список" }) } } },
});

const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text) ?? null;

async function open(key: string | undefined, answer: () => { ok: true; result: { key: string } } | { ok: false; error: string }) {
  const relay = new FakeRelay(oneMachine());
  relay.handlers["gate.redeem"] = answer;
  const store = memoryStore(key ? { key } : {});
  const t = await stand([part()], { relay, store, url: `/#invite=${INVITE}` });
  await flush();
  return { ...t, relay, store };
}

afterEach(() => vi.restoreAllMocks());

describe("приглашение при имеющемся пропуске", () => {
  it("6760 · чужое приглашение: связи нет, gate не тронут, пропуск прежний, адрес чист, спрашиваем человека", async () => {
    const t = await open(KEY, () => ({ ok: true, result: { key: OTHER } }));
    expect(t.relay.sent("gate.redeem")).toEqual([]);
    expect(t.store.data.key).toBe(KEY);
    expect(t.relay.socks).toHaveLength(0);
    expect(location.hash).toBe("");
    expect(t.root.textContent).toContain("Заменить пропуск этого устройства?");
    expect(t.root.textContent).toContain(INVITE.split(".")[0]);
    expect(t.root.textContent).not.toContain(INVITE.split(".")[1]);
  });

  it("6761 · «Заменить пропуск»: gate.redeem, новый пропуск, перезагрузка", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const t = await open(KEY, () => ({ ok: true, result: { key: OTHER } }));
    await t.click(button("Заменить пропуск"));
    await flush();
    expect(t.relay.sent("gate.redeem").map((f) => f.invite)).toEqual([INVITE]);
    expect(t.store.data.key).toBe(OTHER);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("6762 · «Оставить текущий»: приглашение не гасится, пропуск прежний, перезагрузка", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const t = await open(KEY, () => ({ ok: true, result: { key: OTHER } }));
    await t.click(button("Оставить текущий"));
    expect(t.relay.sent("gate.redeem")).toEqual([]);
    expect(t.store.data.key).toBe(KEY);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("6763 · отказ gate при замене: причина словами, пропуск прежний, без перезагрузки", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const t = await open(KEY, () => ({ ok: false, error: "bad_invite" }));
    await t.click(button("Заменить пропуск"));
    await flush();
    expect(t.root.querySelector('[role="alert"]')!.textContent).toBe("Приглашение не принято: bad_invite.");
    expect(t.store.data.key).toBe(KEY);
    expect(reload).not.toHaveBeenCalled();
  });
});
