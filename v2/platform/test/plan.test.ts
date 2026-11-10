// Свойства плана тестов v2 без теста: заведение флота (отказы) и удаление человека.
// Источник — устав («система ловит»: отказ словом, ничего не изменено) и код («чьё: код»).
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ANYA, api, ask, boot, newFleet, page, pass, YURI } from "./kit.ts";

const post = async (body: unknown, secret = "boot-secret") => {
  const res = await SELF.fetch("https://p.test/boot", { method: "POST", headers: { authorization: "Bearer " + secret }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string } };
};

describe("заведение флота", () => {
  it("секрет неверный — forbidden, флот не заведён: верным секретом он заводится", async () => {
    const fleet = newFleet();
    expect(await post({ fleet, person: YURI }, "wrong-secret")).toMatchObject({ status: 403, json: { ok: false, error: "forbidden" } });
    expect(await post({ fleet, person: YURI })).toMatchObject({ status: 200, json: { ok: true } });
  });

  it("флот уже заведён — exists, прежний админ на месте", async () => {
    const fleet = newFleet(), yuri = await boot(fleet);
    expect(await post({ fleet, person: ANYA })).toMatchObject({ status: 409, json: { ok: false, error: "exists" } });
    const people = ((await ask(fleet, yuri, { type: "people.list" })).result as { people: Array<{ person: string }> }).people.map((p) => p.person);
    expect(people).toEqual([YURI]);
  });

  it("вход отклонён: тело не по форме — bad_input", async () => {
    expect(await post({ fleet: newFleet(), person: "yuri" })).toMatchObject({ status: 400, json: { ok: false, error: "bad_input" } });
  });
});

describe("удаление человека", () => {
  it("админ удаляет человека: его нет в списке, пропуск отозван, открытая страница закрыта словом revoked", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), anya = await pass(fleet, yuri, "pult" + ANYA);
    const p = await page(fleet, anya);
    expect(await ask(fleet, yuri, { type: "people.remove", person: ANYA })).toMatchObject({ ok: true });
    expect((await p.closed).reason).toBe("revoked");
    const people = ((await ask(fleet, yuri, { type: "people.list" })).result as { people: Array<{ person: string }> }).people.map((x) => x.person);
    expect(people).toEqual([YURI]);
    expect(await api.who(anya)).toMatchObject({ error: expect.any(String) });
  });

  it("не админ — forbidden; такого человека нет — not_found", async () => {
    const fleet = newFleet(), yuri = await boot(fleet), anya = await pass(fleet, yuri, "pult" + ANYA);
    expect(await ask(fleet, anya, { type: "people.remove", person: YURI })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await ask(fleet, yuri, { type: "people.remove", person: "~nobody@example.com" })).toMatchObject({ ok: false, error: "not_found" });
  });
});
