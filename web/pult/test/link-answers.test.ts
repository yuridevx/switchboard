// Ответы машин при обрыве связи клиента: запрос оборвался — отказ disconnected; связь вернулась — машины спрошены заново, а не при новом открытии экрана.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fleetRelay, flush, pult } from "./stand.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const profiles = { profiles: { "team/profiles/ops": { model: "opus", effort: "high", about: "дежурство" } }, repos: {} };

describe("связь клиента вернулась", () => {
  it("6870 · профили: запрос оборвался обрывом связи — после hello машина спрошена заново, экран показывает ответ", async () => {
    // источник: устав — соединение с объектом relay оборвалось: клиенты переподключаются; находка плана ui-machine-answers
    const relay = fleetRelay();
    relay.handlers["machine.profiles"] = () => undefined;
    const t = await pult({ relay, url: "/#profiles" });
    await flush(10);
    const asked = relay.sent("machine.profiles").length;
    expect(asked).toBeGreaterThan(0);
    relay.handlers["machine.profiles"] = () => ({ ok: true, result: profiles });
    relay.drop();
    await new Promise((r) => setTimeout(r, 30));
    await flush(10);
    expect(relay.sent("machine.profiles").length).toBeGreaterThan(asked);
    expect(t.$('[data-profile="team/profiles/ops"]')).not.toBeNull();
  });
});
