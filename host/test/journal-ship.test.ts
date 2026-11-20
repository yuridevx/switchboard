// Эталоны отправки журнала машины в историю флота (ClickHouse): пачками с места остановки, место сдвигается только после ответа службы.
// Источник — дизайн «Аккаунты и модели»: слово пользователя 15 нояб. — «вся история и весь лог должен быть в ClickHouse», «observability first».
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Frame } from "@sb/protocol";
import { make as machine, SHIP_MS, SHIP_RETRY_MS } from "../src/modules/machine/machine.ts";
import { stand, until, type Stand } from "../stand/index.ts";

let stands: Stand[] = [];
afterEach(async () => {
  for (const st of stands.splice(0)) await st.stop();
});
const start = async (o: Parameters<typeof stand>[0] = {}) => {
  const st = await stand({ modules: [machine()], ...o });
  stands.push(st);
  return st;
};

/** Строки всех файлов журнала машины, как они лежат на диске. */
const onDisk = (st: Stand): string[] => {
  const dir = join(st.home, "journal");
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean));
};
/** Подделка истории флота: строки складываются по ключу таблицы — файл, начало пачки, номер строки; повтор пачки строк не добавляет. */
const history = () => {
  const rows = new Map<string, string>();
  const take = (f: Frame) => {
    (f.lines as string[]).forEach((text, n) => rows.set(`${f.file}|${f.pos}|${n}`, text));
    return {};
  };
  return { rows, take };
};
const writes = (st: Stand) => st.services.of("log.write");
/** Такт отправки: сдвинуть часы и дождаться, пока служба увидит ещё один запрос. */
const tickShip = async (st: Stand, ms: number) => {
  const before = writes(st).length;
  st.clock.advance(ms);
  await until(() => writes(st).length > before, "пачка журнала ушла службе");
};
const caughtUp = (st: Stand, rows: Map<string, string>) => until(() => rows.size === onDisk(st).length, "в истории столько же строк, сколько в файлах журнала");

describe("журнал машины → история флота", () => {
  // эталон: «ClickHouse недоступен час; сессии работают» — чьё: слово пользователя 15 нояб. — «observability first»; устав — часть падает одна
  it("ClickHouse недоступен час: сессия работает; после возврата отправка продолжилась с места остановки, потерянных строк 0", async () => {
    const st = await start();
    const ch = history();
    st.services.handlers["log.write"] = ch.take;
    await tickShip(st, SHIP_MS);
    await caughtUp(st, ch.rows);
    const accepted = writes(st).length;
    const place = Buffer.byteLength(onDisk(st).join("\n") + "\n");

    st.services.handlers["log.write"] = () => {
      throw { word: "analytics_unavailable", why: "ClickHouse ответил 503" };
    };
    // час без ClickHouse: сессия открывается и ходит, журнал пишется в файл
    await st.open("site", { model: "claude-fable-5-2" });
    await st.turn("site@laptop");
    await tickShip(st, SHIP_MS);
    for (let minute = 1; minute < 60; minute++) {
      st.kernel.log.info("probe", { why: `минута ${minute}` });
      await tickShip(st, SHIP_RETRY_MS);
    }
    expect(st.kernel.sessions.get("site@laptop")!.state).toBe("idle");
    const refused = writes(st).slice(accepted);
    expect(refused).toHaveLength(60);
    // место не сдвинулось: каждая попытка — с того же места того же файла
    expect(new Set(refused.map((f) => `${f.file}|${f.pos}`))).toEqual(new Set([`${refused[0]!.file}|${place}`]));
    // отказ — одна строка журнала, а не строка на попытку
    expect(st.journal().filter((l) => l.msg === "log_ship")).toMatchObject([{ level: "warn", word: "analytics_unavailable" }]);

    st.services.handlers["log.write"] = ch.take;
    await tickShip(st, SHIP_RETRY_MS);
    // возврат — строка журнала; она сама уходит следующей пачкой
    await until(() => st.journal().some((l) => l.msg === "log_ship" && l.level === "info"), "строка о возврате истории");
    await caughtUp(st, ch.rows);
    expect(writes(st)[accepted + 60]).toMatchObject({ file: refused[0]!.file, pos: place });
    expect([...ch.rows.values()].sort()).toEqual(onDisk(st).sort());
    expect(st.journal().filter((l) => l.msg === "log_ship").map((l) => l.level)).toEqual(["warn", "info"]);
  });

  // эталон: «Машину остановили посреди отправки пачки» — чьё: слово пользователя 2 нояб. — «у всех операций лимит и graceful shutdown»
  it("машину остановили посреди отправки: остановка не ждёт ответа; новая машина отправила с того же места, строк в истории — как в файле", async () => {
    const first = await start();
    const ch = history();
    first.services.handlers["log.write"] = ch.take;
    await tickShip(first, SHIP_MS);
    await caughtUp(first, ch.rows);
    // пачка записана, а ответ до машины не дошёл: запрос висит
    first.services.handlers["log.write"] = (f) => (ch.take(f), new Promise(() => {}));
    first.kernel.log.info("probe", { why: "строка перед остановкой" });
    await tickShip(first, SHIP_MS);
    const hung = writes(first).at(-1)!;
    expect(hung.pos).toBeGreaterThan(0);
    await first.stop();
    expect(first.exits).toEqual([0]);

    const second = await start({ home: first.home });
    second.services.handlers["log.write"] = ch.take;
    await tickShip(second, SHIP_MS);
    expect(writes(second)[0]).toMatchObject({ file: hung.file, pos: hung.pos });
    // новая пачка с того же места длиннее прежней: в ней и строки остановки, и строки нового старта
    expect((writes(second)[0]!.lines as string[]).length).toBeGreaterThan((hung.lines as string[]).length);
    await caughtUp(second, ch.rows);
    expect([...ch.rows.values()].sort()).toEqual(onDisk(second).sort());
  });

  // дизайн: пачка — целые строки файла не больше предела; пока есть что слать, пачки идут подряд, место — в записи модуля
  it("журнал длиннее пачки уходит несколькими пачками подряд, каждая — целыми строками; дописанное уходит следующим тактом", async () => {
    const st = await stand({ modules: [machine({ batch: 600 })] });
    stands.push(st);
    const ch = history();
    st.services.handlers["log.write"] = ch.take;
    for (let i = 0; i < 12; i++) st.kernel.log.info("probe", { why: `строка ${i} ${"x".repeat(80)}` });
    await tickShip(st, SHIP_MS);
    await caughtUp(st, ch.rows);
    const sent = writes(st);
    expect(sent.length).toBeGreaterThan(2);
    for (const f of sent) for (const text of f.lines as string[]) expect(() => JSON.parse(text)).not.toThrow();
    // пачки встык: следующая начинается там, где кончилась прежняя
    for (let i = 1; i < sent.length; i++) expect(sent[i]!.pos).toBe((sent[i - 1]!.pos as number) + Buffer.byteLength((sent[i - 1]!.lines as string[]).join("\n") + "\n"));
    const before = sent.length;
    st.clock.advance(SHIP_MS);
    await new Promise((r) => setTimeout(r, 50));
    expect(writes(st)).toHaveLength(before);
    st.kernel.log.info("probe", { why: "дописано" });
    await tickShip(st, SHIP_MS);
    await caughtUp(st, ch.rows);
    expect([...ch.rows.values()].sort()).toEqual(onDisk(st).sort());
  });
});
