// Живая проверка флота: node tools/fleet/smoke.ts <флот> [устройство]
// Зовёт по одному запросу каждого вида цели и сверяет картину флота, пришедшую по соединению страницы; шаг — имя запроса.
import { ledgerRead, obsRecent, passes, peopleList, prefsGet, prefsSet, whoami, type InputOf, type OutputOf, type RequestDef } from "@sb/protocol";
import { check } from "./harness.mjs";

await check(async (t) => {
  /** Шаг — один запрос договора: его имя, ввод и что сказать об ответе. */
  const ask = <D extends RequestDef<any, any>>(def: D, input: InputOf<D>, show: (o: OutputOf<D>) => string) => t.step(def.name, async () => show(await t.must(def, input)));
  let me = "";
  await ask(whoami, {}, (o) => ((me = o.addr), `${o.addr}, админ: ${o.admin}, машин: ${o.machines.length}`));
  await ask(peopleList, {}, (o) => `людей ${o.people.length}, проектов ${o.projects.length}`);
  await ask(passes, {}, (o) => `пропусков ${o.passes.length}`);
  await ask(prefsSet, { scope: "me", name: "smoke", value: { at: Date.now() } }, () => "записано");
  await ask(prefsGet, { scope: "me", prefix: "smoke" }, (o) => `ключей ${Object.keys(o.values).length}`);
  await ask(ledgerRead, { limit: 5 }, (o) => `событий ${o.events.length}`);
  await ask(obsRecent, { limit: 5 }, (o) => `строк ${o.rows.length}; последняя: ${o.rows[0]?.type} ${JSON.stringify(o.rows[0]?.spans ?? [])}`);
  // картину проверке уже отдало соединение страницы — его держит обвязка; чьё: код — снимок картины называет, кому он пришёл
  await t.step("картина", async () => {
    const p = t.picture;
    if (p.you?.addr !== me) throw new Error(`картина пришла не этому устройству: ${p.you?.addr ?? "никому"}, запросы шли от ${me}`);
    return `машин ${Object.keys(p.machines).length}, сессий ${Object.keys(p.sessions).length}`;
  });
});
