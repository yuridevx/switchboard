// Эталон аналитики на свежем ClickHouse. Отдельным файлом: какие таблицы заведены, модуль помнит на экземпляр — здесь он свежий.
import { expect, it } from "vitest";
import { stand } from "../../test/stand.ts";

// чьё: факт — на свежем ClickHouse «Расход» отказывал «Unknown table sb2_calls», пока первая точка не завела таблицу (флот в коробке, 18 нояб.)
it("чтение раньше первой записи: отчёт сам заводит таблицу и отвечает пустым; состояние — «отвечает»", async () => {
  const s = stand(undefined, { env: { CH_URL: "https://ch.test:8443/" } });
  let made = false;
  s.state.net = (url) => {
    const q = new URL(url).searchParams.get("query") ?? "";
    if (q.startsWith("CREATE TABLE")) return ((made = true), new Response(""));
    return made ? Response.json({ data: [] }) : new Response("Code: 60. DB::Exception: Unknown table expression identifier 'sb2_calls'", { status: 404 });
  };
  expect((await s.ask("analytics.query", { by: "day", since: "2026-11-01", until: "2026-11-10" })).result).toEqual({ rows: [] });
  expect(new URL(s.seen.net[0]!.url).searchParams.get("query")).toMatch(/^CREATE TABLE IF NOT EXISTS/);
  expect((await s.ask("analytics.state", {})).result).toMatchObject({ on: true, ok: true });
});
