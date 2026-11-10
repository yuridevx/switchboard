import { describe, expect, it, vi } from "vitest";
import { CALL_MS, MAX_FRAME, type ObsRow, type Reply } from "@sb/protocol";
import { newFleet, stand } from "../test/stand.ts";

describe("вход служб", () => {
  it("не кадр и кадр без id — 400 bad_frame", async () => {
    const s = stand();
    for (const body of ["не json", '{"id":"1"}', '{"type":"prefs.get"}']) {
      const res = await s.http("/call", { method: "POST", body });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Reply).error).toBe("bad_frame");
    }
  });

  it("запроса нет в договоре — unknown_request словом", async () => {
    const s = stand();
    expect(await s.ask("no.such")).toMatchObject({ ok: false, error: "unknown_request" });
  });

  it("без пропуска и с чужим пропуском — bad_key", async () => {
    const s = stand();
    expect(await s.ask("prefs.get", { scope: "me" }, null)).toMatchObject({ ok: false, error: "bad_key" });
    expect(await s.ask("prefs.get", { scope: "me" }, "knobody")).toMatchObject({ ok: false, error: "bad_key" });
  });

  it("не админ зовёт выкладку сборки — forbidden, обработчик не вызван", async () => {
    const s = stand();
    expect(await s.ask("builds.deploy", { build: 7 }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
    // обработчик на несуществующую сборку ответил бы not_found и ничего бы не разослал
    expect(s.seen.broadcasts).toHaveLength(0);
    expect(((await s.ask("builds.list")).result as { stable: number | null }).stable).toBeNull();
  });

  it("запрос только для машины от устройства — forbidden", async () => {
    const s = stand();
    await s.ask("keys.set", { name: "orca", provider: "anthropic", value: "sk-secret-1234" });
    expect(await s.ask("keys.value", { name: "orca" }, "kyura1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await s.ask("keys.value", { name: "orca" }, "klaptop")).toMatchObject({ ok: true, result: { value: "sk-secret-1234" } });
  });

  it("запрос сессии на чужой машине — forbidden, кадр не доставлен", async () => {
    const s = stand();
    expect(await s.ask("message", { to: "site@oleg-mac", text: "привет" }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(s.seen.delivered).toHaveLength(0);
  });

  it("запрос сессии на своей машине доставлен с отправителем и trace; отрезки пути сложены", async () => {
    const s = stand();
    const r = await s.ask("message", { to: "site@laptop", text: "привет", лишнее: 1 }, "kanya1");
    expect(r.ok).toBe(true);
    expect(s.seen.delivered).toHaveLength(1);
    const f = s.seen.delivered[0]!;
    expect(f).toMatchObject({ type: "message", to: "site@laptop", text: "привет", from: "pult~anya@example.com" });
    expect(f.trace).toBe(r.trace);
    // поля вне схемы до машины не доходят
    expect(f).not.toHaveProperty("лишнее");
    expect(r.spans?.map((x) => x.part)).toEqual(["host", "services"]);
  });

  it("машина говорит за свою сессию: отправитель — позывной; чужой позывной — отказ", async () => {
    const s = stand();
    await s.ask("message", { to: "docs@server", text: "обнови" }, "klaptop", "site@laptop");
    expect(s.seen.delivered[0]!.from).toBe("site@laptop");
    expect(await s.ask("message", { to: "docs@server", text: "обнови" }, "klaptop", "site@server")).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("ввод не по схеме — bad_input с причиной, обработчик не вызван", async () => {
    const s = stand();
    const r = await s.ask("session.open", { to: "@laptop", spec: { name: "site" } });
    expect(r).toMatchObject({ ok: false, error: "bad_input" });
    expect(r.why).toContain("spec.cwd");
    expect(s.seen.delivered).toHaveLength(0);
  });

  it("запрос объекту флота уходит платформе с тем, кто пришёл; приём приглашения — без пропуска, флот из приглашения", async () => {
    const s = stand();
    expect(await s.ask("passes", {}, "kanya1")).toMatchObject({ ok: true, result: { called: "passes" } });
    expect(s.seen.fleetCalls[0]).toMatchObject({ fleet: s.fleet, who: { person: "~anya@example.com" } });
    expect(await s.ask("redeem", { invite: `${s.fleet}:kinvite1:${"x".repeat(20)}` }, null)).toMatchObject({ ok: true });
    expect(s.seen.fleetCalls[1]).toMatchObject({ fleet: s.fleet, who: null, frame: { type: "redeem" } });
  });

  it("обработчик бросил ошибку — module_failed; следующий запрос модуля обслужен", async () => {
    const s = stand();
    s.state.broadcastFails = true;
    expect(await s.ask("prefs.set", { scope: "fleet", name: "names", value: { a: 1 } })).toMatchObject({ ok: false, error: "module_failed" });
    s.state.broadcastFails = false;
    expect(await s.ask("prefs.get", { scope: "fleet" })).toMatchObject({ ok: true });
  });

  it("на каждый запрос — строка наблюдения с исходом и отрезками; сами запросы наблюдения не пишутся", async () => {
    const s = stand();
    const sent = await s.ask("message", { to: "site@laptop", text: "привет" });
    await s.ask("message", { to: "site@oleg-mac", text: "нет" }, "kanya1");
    const rows = ((await s.ask("obs.recent", {})).result as { rows: ObsRow[] }).rows;
    expect(rows.map((r) => [r.type, r.ok, r.word])).toEqual([["message", false, "forbidden"], ["message", true, undefined]]);
    expect(rows[1]).toMatchObject({ trace: sent.trace, from: "pult~yuri@example.com", to: "site@laptop" });
    expect(rows[1]!.spans?.map((x) => x.part)).toEqual(["host", "services"]);
    expect(((await s.ask("obs.recent", {})).result as { rows: ObsRow[] }).rows).toHaveLength(2);
  });

  it("два флота в одной выкладке не видят записей друг друга", async () => {
    const a = stand(newFleet()), b = stand(newFleet());
    await a.ask("prefs.set", { scope: "fleet", name: "projects", value: { site: 1 } });
    expect(((await a.ask("prefs.get", { scope: "fleet" })).result as { values: object }).values).toEqual({ projects: { site: 1 } });
    expect(((await b.ask("prefs.get", { scope: "fleet" })).result as { values: object }).values).toEqual({});
  });

  it("соединения /f и /m уходят в платформу как есть; /health отвечает", async () => {
    const s = stand();
    expect(await (await s.http(`/f/${s.fleet}`)).text()).toBe("platform");
    expect(await (await s.http(`/m/${s.fleet}/laptop`)).text()).toBe("platform");
    expect(s.seen.fetched.map((r) => new URL(r.url).pathname)).toEqual([`/f/${s.fleet}`, `/m/${s.fleet}/laptop`]);
    expect(await (await s.http("/health")).json()).toMatchObject({ ok: true, part: "services" });
  });
});

describe("вход: только владелец машины", () => {
  it("перезапуск Host: владелец и админ — доставлено Keeper; достающий до машины, но не владелец — forbidden", async () => {
    const s = stand();
    // Аня достаёт до laptop (общий проект с Юрой), но владелец — Юра
    expect(await s.ask("host.restart", { to: ".keeper@laptop" }, "kanya1")).toMatchObject({ ok: false, error: "forbidden" });
    expect(s.seen.delivered).toHaveLength(0);
    expect((await s.ask("host.restart", { to: ".keeper@laptop" }, "kyura1")).ok).toBe(true);
    expect(s.seen.delivered.at(-1)).toMatchObject({ type: "host.restart", to: ".keeper@laptop" });
    // своя машина — можно и не админу
    expect((await s.ask("host.restart", { to: ".keeper@oleg-mac" }, "koleg1")).ok).toBe(true);
  });
});

describe("вход: сообщение человеку", () => {
  it("message на адрес человека или устройства — отказ not_session с подсказкой про reach.send", async () => {
    const s = stand();
    const r = await s.ask("message", { to: "~anya@example.com", text: "привет" });
    expect(r).toMatchObject({ ok: false, error: "not_session" });
    expect(r.why).toContain("reach.send");
    expect(await s.ask("message", { to: "phone~anya@example.com", text: "привет" })).toMatchObject({ ok: false, error: "not_session" });
  });
});

describe("вход: предел ответа", () => {
  // слово пользователя 2 нояб.: «у всех операций должен быть лимит»
  it("машина не ответила за предел — timeout с причиной словами; отказ записан строкой наблюдения", async () => {
    const s = stand();
    // платформа приняла кадр и молчит
    s.platform.deliver = () => new Promise(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const waiting = s.ask("message", { to: "site@laptop", text: "привет" });
      await vi.advanceTimersByTimeAsync(CALL_MS + 1000);
      const r = await waiting;
      expect(r).toMatchObject({ ok: false, error: "timeout" });
      expect(r.why).toContain("машина не ответила");
    } finally {
      vi.useRealTimers();
    }
    const rows = ((await s.ask("obs.recent", { failed: true })).result as { rows: ObsRow[] }).rows;
    expect(rows.map((x) => [x.type, x.ok, x.word])).toEqual([["message", false, "timeout"]]);
  });
});

describe("вход OAuth: платформа не ответила", () => {
  // устав: «прямой запрос … не прошёл — отказ словом»
  it("/token при молчащей платформе — 503 server_error, пропуск не выдан", async () => {
    const s = stand();
    s.platform.fleetCall = async () => { throw new Error("платформа упала"); };
    const res = await s.http("/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: `${s.fleet}:kinvite1:${"s".repeat(20)}`, code_verifier: "good", client_id: "https://c.example/c.json", redirect_uri: "https://c.example/cb" }).toString(),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "server_error", error_description: "платформа не ответила" });
    expect(body.access_token).toBeUndefined();
  });
});

describe("адрес установки приложения", () => {
  /** Файлы страницы: разметка со ссылкой на манифест и сам манифест. */
  const ASSETS = {
    fetch: async (req: Request) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/manifest.webmanifest") return Response.json({ name: "Switchboard", start_url: "/" });
      return new Response('<html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>', { headers: { "content-type": "text/html" } });
    },
  } as unknown as Fetcher;
  const INVITE = "home:kinvite1:" + "s".repeat(20);

  // факт: проверено пользователем на iPhone — приложение с экрана «Домой» входит без вставки приглашения
  it("с приглашением: страница ссылается на манифест с приглашением, а его адрес запуска несёт приглашение", async () => {
    const s = stand(undefined, { env: { ASSETS } });
    const page = await (await s.http("/i?invite=" + encodeURIComponent(INVITE))).text();
    expect(page).toContain('href="/manifest.webmanifest?invite=' + encodeURIComponent(INVITE) + '"');
    const manifest = (await (await s.http("/manifest.webmanifest?invite=" + encodeURIComponent(INVITE))).json()) as { name: string; start_url: string };
    expect(manifest).toEqual({ name: "Switchboard", start_url: "/i?invite=" + encodeURIComponent(INVITE) });
  });

  // чьё: код
  it("без приглашения — страница и манифест как в файлах страницы", async () => {
    const s = stand(undefined, { env: { ASSETS } });
    expect(await (await s.http("/i")).text()).toContain('href="/manifest.webmanifest"');
    expect(await (await s.http("/manifest.webmanifest")).json()).toEqual({ name: "Switchboard", start_url: "/" });
  });
});

describe("вход: предел кадра", () => {
  // устав: «система ловит» — отказ словом; чьё: код
  it("кадр больше предела — 413 too_large, обработчик не вызван", async () => {
    const s = stand();
    const res = await s.http("/call", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + s.key("kyura1") }, body: JSON.stringify({ type: "prefs.set", id: "r1", scope: "me", name: "big", value: "x".repeat(MAX_FRAME) }) });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, error: "too_large" });
    expect((await s.ask("prefs.get", { scope: "me" })).result).toEqual({ values: {} });
  });
});
