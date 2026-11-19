// Эталоны обвязки живых проверок на поддельном флоте и поддельных часах: node tools/test/run.mjs tools
// Поддельный флот — провод общего клиента: запросы отвечает таблица, картина приходит кадрами. Время идёт только по advance().
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeClock } from "../../host/stand/clock.ts";
import { ALONE, kit } from "./harness.mjs";
import { parse } from "./turn.mjs";

const turnOf = () => new Promise((r) => setImmediate(r));

/** Поддельный флот: одна машина m1; сессия отвечает на сообщение так, как велит mode:
 *  instant — ход проходит целиком внутри запроса message: «занята» и «свободна» приходят раньше ответа на запрос;
 *  never — сессия берёт ход и не кончает его; сценарий с шагом Bash держит ход, пока на машине не появится его файл. */
function fleet({ mode = "instant" } = {}) {
  const calls = [], sessions = {}, history = {}, files = new Set(), held = [];
  let onFrame = () => {}, rev = 0, n = 0, closed = false;
  const push = (cs, row) => {
    if (row === null) delete sessions[cs];
    else sessions[cs] = { ...sessions[cs], ...row };
    onFrame({ type: "roster.delta", rev: ++rev, sessions: [{ callsign: cs, row: row === null ? null : sessions[cs] }] });
  };
  const end = (cs, k) => {
    history[cs].push({ type: "assistant", uuid: "a" + k, message: { content: [{ type: "text", text: "ответ " + k }] } }, { type: "result", uuid: "r" + k });
    push(cs, { state: "idle" });
  };
  const on = {
    "shell.run"(f) {
      const made = /writeFileSync\("([^"]+)"/.exec(f.script)?.[1];
      if (made) {
        files.add(made);
        for (const h of held.splice(0)) if (files.has(h.gate)) end(h.cs, h.k); else held.push(h);
      }
      return { run: "run" + ++n, state: "done", out: f.script.includes("tmpdir") ? "/tmp" : "" };
    },
    "session.open"(f) {
      const cs = `${f.spec.name}@${f.to.slice(1)}`;
      history[cs] = [];
      push(cs, { callsign: cs, state: "idle", spec: f.spec });
      return { callsign: cs };
    },
    message(f) {
      const k = ++n, cs = f.to;
      history[cs].push({ type: "user", uuid: "u" + k });
      push(cs, { state: "busy" });
      const gate = /\[ -f '([^']+)' \]/.exec(parse(f.text)?.[0]?.fields?.command ?? "")?.[1];
      if (gate) {
        history[cs].push({ type: "assistant", uuid: "t" + k, message: { content: [{ type: "tool_use", name: "Bash", input: { command: parse(f.text)[0].fields.command } }] } });
        held.push({ cs, k, gate });
      } else if (mode === "instant") end(cs, k);
      return { uuid: "u" + k };
    },
    "session.history": (f) => ({ events: history[f.to].slice(-(f.limit ?? 50)), more: false, seq: 0 }),
    "session.remove": (f) => (push(f.to, null), {}),
    "project.set": () => ({}),
  };
  const transport = {
    async call(f) {
      calls.push(f);
      return on[f.type] ? { type: "reply", id: f.id, ok: true, result: on[f.type](f) } : { type: "reply", id: f.id, ok: false, error: "unknown_type", why: f.type };
    },
    open(_role, opts) {
      onFrame = opts.onFrame;
      queueMicrotask(() => onFrame({ type: "roster", rev: ++rev, you: { addr: "cli~t@box.test", person: "t@box.test", admin: true }, machines: [{ name: "m1", online: true }], sessions: Object.values(sessions) }));
      return { send() {}, close: () => (closed = true) };
    },
  };
  return { transport, calls, sessions, history, push, sent: (type) => calls.filter((c) => c.type === type), closed: () => closed };
}

/** Обвязка на поддельном флоте: строки вывода и строки журнала — в массивы. */
function stand(o = {}) {
  const f = fleet(o), clock = new FakeClock(), out = [], lines = [];
  const t = kit({ title: "эталон", slug: "et", transport: f.transport, clock, tag: "abc123", machine: "m1", seat: { key: "box", model: "box-1" }, budgetMs: 5000, out: (l) => out.push(l), journal: (l) => lines.push(l), ...o.kit });
  /** Довести прогон до конца: часы идут по секунде, пока прогон не кончился; ms — сколько времени дать. */
  const finish = async (running, ms = 0) => {
    let done = false, code;
    running.then((c) => ((done = true), (code = c)));
    for (let spent = 0; ; spent += 1000) {
      for (let i = 0; i < 20 && !done; i++) await turnOf();
      if (done) return code;
      if (spent >= ms) throw new Error("прогон не кончился за отведённое время: " + out.join(" | "));
      clock.advance(1000);
    }
  };
  return { ...f, t, clock, out, lines, finish };
}

// чьё: факт — в коробке модель отвечает мгновенно, короткий ход проскакивает между опросами (дизайн, эталон «Ход короче опроса»)
test("ход короче опроса: ход прошёл раньше ответа на запрос — ожидание возвращает итог именно этого хода, часы не двигались", async () => {
  const s = stand();
  let first, second;
  const code = await s.finish(s.t.run(async (t) => {
    const x = await t.session({ name: "rw" });
    await t.step("два хода подряд", async () => {
      first = await x.turn("раз");
      second = await x.turn("два");
    });
  }));
  assert.equal(code, 0);
  assert.equal(first.text, "ответ 2");
  assert.equal(second.text, "ответ 3"); // не итог прошлого хода: он в истории стоит раньше своего сообщения
  assert.equal(second.events.at(-1).type, "result");
  assert.equal(s.clock.now(), new FakeClock().now()); // ни одного ожидания по времени
});

// чьё: слово пользователя 2 нояб. — у всех операций предел и штатная остановка (эталон «Бюджет вышел»)
test("бюджет вышел: одна красная строка с «ждал» и «видел», уборка сделана, код выхода 1", async () => {
  const s = stand({ mode: "never" });
  const code = await s.finish(s.t.run(async (t) => {
    const x = await t.session({ name: "rw" });
    await t.step("ход записал файл", () => x.turn("пиши"));
    await t.step("до этого шага проверка не доходит", async () => {});
  }), 5000);
  assert.equal(code, 1);
  assert.deepEqual(s.out, ["✗ ход записал файл · ждал: итог хода rw-abc123@m1 · видел: строка сессии — busy · бюджет 5 с вышел"]);
  assert.deepEqual(s.sent("session.remove").map((c) => c.to), ["rw-abc123@m1"]);
  assert.equal(s.closed(), true);
  assert.equal(Object.keys(s.sessions).length, 0);
});

// чьё: факт истории — на Windows 47 красных шагов от 22 причин (эталон «Первый красный останавливает»)
test("первый красный останавливает: из пяти шагов второй падает — красная строка одна, шаги 3–5 не идут, сессии сняты", async () => {
  const s = stand();
  const ran = [];
  const code = await s.finish(s.t.run(async (t) => {
    await t.session({ name: "rw" });
    for (const n of [1, 2, 3, 4, 5]) await t.step("шаг " + n, async () => {
      ran.push(n);
      if (n === 2) throw new Error("файл пуст\n    at стек не печатается");
    });
  }));
  assert.equal(code, 1);
  assert.deepEqual(ran, [1, 2]);
  assert.deepEqual(s.out, ["✓ шаг 1 · 0 мс", "✗ шаг 2 · файл пуст"]);
  assert.equal(s.sent("session.remove").length, 1);
});

// чьё: факт кода — смена состава проекта рвёт соединения страниц соседних проверок (эталон «Общее — только по объявлению»)
test("общее — только по объявлению: тихая проверка запрос о составе проекта не отправляет; с дорожкой «одна» он уходит", async () => {
  const quiet = stand();
  assert.equal(await quiet.finish(quiet.t.run((t) => t.step("завести проект", () => t.must("project.set", { name: "tk" })))), 1);
  assert.equal(quiet.sent("project.set").length, 0);
  assert.match(quiet.out[0], /^✗ завести проект · запрос project\.set трясёт флот: объявите проверке дорожку «одна»/);
  const alone = stand({ kit: { lane: ALONE } });
  assert.equal(await alone.finish(alone.t.run((t) => t.step("завести проект", () => t.must("project.set", { name: "tk" })))), 0);
  assert.equal(alone.sent("project.set").length, 1);
});

// чьё: устав — проверка, которая не может упасть, проверкой не считается (эталон «Проверка не запустилась»)
test("проверка не запустилась: до первого шага нет нужного — красный с названием недостающего, код 1; отказ флота — словом", async () => {
  const s = stand();
  const code = await s.finish(s.t.run(async () => {
    throw new Error("на машине m1 нет сведённого кусочка с памятью");
  }));
  assert.equal(code, 1);
  assert.deepEqual(s.out, ["✗ проверка не запустилась · на машине m1 нет сведённого кусочка с памятью"]);
  const refused = stand();
  await refused.finish(refused.t.run((t) => t.must("keys.models", { name: "нет" })));
  assert.deepEqual(refused.out, ["✗ проверка не запустилась · keys.models: unknown_type keys.models"]);
});

// чьё: слово пользователя 15 нояб. — наблюдаемость первой (эталон «Строка шага»)
test("строка шага: три шага, последний красный — три строки журнала общей формы: проверка, шаг, исход, время", async () => {
  const s = stand();
  await s.finish(s.t.run(async (t) => {
    await t.step("первый", async () => "заметка");
    await t.step("второй", async () => {});
    await t.step("третий", async () => {
      throw new Error("не сошлось");
    });
  }));
  assert.deepEqual(s.lines.map(({ t, ...l }) => l), [
    { level: "info", part: "check", module: "эталон", msg: "первый", ok: true, ms: 0 },
    { level: "info", part: "check", module: "эталон", msg: "второй", ok: true, ms: 0 },
    { level: "error", part: "check", module: "эталон", msg: "третий", ok: false, why: "не сошлось" },
  ]);
  assert.deepEqual(s.out, ["✓ первый · заметка · 0 мс", "✓ второй · 0 мс", "✗ третий · не сошлось"]);
});

// чьё: факт истории — «молния прерывает ход» красная в 9 прогонах живого флота из 55 (эталон «Посреди хода держится»)
test("«посреди хода» держится: ход стоит на шаге сценария, пока проверка не отпустит; после отпускания — итог этого хода", async () => {
  const s = stand();
  let during, reply;
  const code = await s.finish(s.t.run(async (t) => {
    const x = await t.session({ name: "talk" });
    await t.step("сообщение во время хода", async () => {
      const hold = await x.hold();
      during = (await x.row()).state;
      // сколько бы проверка ни работала внутри бюджета, ход стоит: окно — её вход, а не гонка
      s.clock.advance(3000);
      assert.equal((await x.row()).state, "busy");
      reply = await hold.release();
    });
  }));
  assert.equal(code, 0);
  assert.equal(during, "busy");
  assert.equal(reply.events.at(-1).type, "result");
  assert.equal((await s.t.picture).sessions?.["talk-abc123@m1"], undefined); // сессия убрана
});

// чьё: код — человеку проверки нельзя быть на связи (переписка с человеком): соединения картины нет, строка сессии читается запросом
test("человек не на связи: без соединения картины проверка идёт перечитыванием — тот же вход, тот же итог", async () => {
  const s = stand({ kit: { away: true } });
  let opened = false;
  const open = s.transport.open;
  s.transport.open = (...a) => ((opened = true), open(...a));
  s.transport.call = ((call) => async (f) => (f.type === "fleet.list" ? { ok: true, result: { machines: [], sessions: Object.values(s.sessions), people: [] } } : call(f)))(s.transport.call);
  let reply;
  const code = await s.finish(s.t.run(async (t) => {
    const x = await t.session({ name: "room" });
    await t.step("ход", async () => void (reply = await x.turn("раз")));
  }));
  assert.equal(code, 0);
  assert.equal(opened, false);
  assert.equal(reply.text, "ответ 2");
});
