// Обвязка живых проверок: вход check — шаг, ожидание, свои сессии и бюджет.
//   await check(async (t) => {
//     const s = await t.session({ name: "rw" });                    // своя сессия: метка проверки в имени, уборка — обвязки
//     await t.step("ход записал файл", async () => {
//       await s.turn(script(tool("Write", { … }), say("готово")));  // ждёт итог именно этого хода
//       await t.wait("файл на диске", async () => (await t.node(t.machine, "…")) === "три");
//     });
//   });
// У проверки три входа: код, её собственный зафиксированный вход и сигналы системы. Времени, соседей и внешнего мира среди них нет:
//   — ожидание кончается по сигналу: кадр картины флота (соединение page общего клиента) или перечитанный факт; пауз и своих пределов у шага нет;
//   — предел один — бюджет проверки: вышел — обвязка сама печатает красный шаг («ждал», «видел»), убирает своё и выходит;
//   — сессии, папки и устройства выдаёт обвязка и убирает их при любом исходе; запрос, задевающий общее, проходит только по объявленной дорожке;
//   — первый красный шаг останавливает проверку: следующие шаги стоят на том, что создал упавший.
// Название, дорожку и метку проверке даёт список (live.mjs) при запуске; одна своя проверка запускается через него же, по названию.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyFrame, emptyPicture, httpTransport, newId } from "@sb/protocol";
import { dev, fleetEnv } from "../dev.mjs";
import { appendSteps } from "./steps.mjs";
import { say, tool, turn as script } from "./turn.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright-core");

/** Браузер живых сценариев — одна точка запуска. На Windows это свой chrome-headless-shell из Playwright: настоящий Chrome на свежем профиле
 *  проверяет, не пуст ли пароль Windows, входом с пустым паролем; каждый запуск — отказ входа, десять отказов за десять минут блокируют учётную запись. */
export const launchBrowser = () => chromium.launch({ channel: process.platform === "win32" ? undefined : "chrome" });

/** Флот в коробке: его адрес — этот компьютер. Проверка, которая меняет сам флот (несёт на него сборку), идёт только на таком. */
export const local = () => /^http:\/\/127\.0\.0\.1[:/]/.test(fleetEnv.SB2_BASE ?? "");

/** Метка проверки для имён её сессий, папок и устройств. Случайная: проверки списка стартуют разом, метка из часов у них совпадала. */
export const newTag = () => crypto.randomBytes(3).toString("hex");

/** Чего у флота нет — список в SB2_WITHOUT через пробел. Флот в коробке (tools/box/box.mjs) называет им то, чего на одном компьютере не бывает:
 *  mind — модель, которая понимает прочитанное; claude — аккаунты Claude; clickhouse — история флота; r2 — подписанные ссылки хранилища;
 *  push — уведомления браузера; github — репозитории кусочков и проектов; keeper — служба машины со сборками Host.
 *  Шаг или проверка, которым это нужно, на таком флоте не идут. */
export const lacks = (what) => (process.env.SB2_WITHOUT ?? "").split(" ").includes(what);

/* ===== Вход обвязки ===== */

/** Бюджет проверки, мс — единственный предел ожидания в проверке. Он короче жёсткого выхода списка (LIMIT_MS в live.mjs) на время уборки:
 *  вышел бюджет — обвязка успевает напечатать красный шаг и убрать своё, пока список не снял процесс. */
export const BUDGET_MS = 210_000;
/** Шаг перечитывания факта, о котором флот кадров не шлёт: файл на диске машины, запись истории, строка архива. */
const REREAD_MS = 1000;
/** Страница сдаётся на секунду раньше бюджета: красный шаг называет элемент, которого она ждала, а не один только бюджет. */
const PAGE_EDGE_MS = 1000;

export const QUIET = "тихая", NOISY = "шумная", ALONE = "одна";
/** Запросы, которые задевают общее. fleet — общее для флота: такой проверке нужна дорожка «одна»; machine — программу машины: «шумная» или «одна». */
const SHAKES = {
  "project.set": "fleet", "project.remove": "fleet", "people.set": "fleet", "people.remove": "fleet", "keys.set": "fleet", "keys.remove": "fleet",
  "github.setup": "fleet", "reach.bot": "fleet", "builds.deploy": "fleet", "host.restart": "machine",
};

/** Отказ флота: слово и причина — как в ответе. */
export class Refused extends Error {
  constructor(type, word, why) {
    super(`${type}: ${word}${why ? " " + why : ""}`);
    this.type = type;
    this.word = word;
    this.why = why;
  }
}
/** Ожидание упёрлось в бюджет: чего ждали и что видели последним. */
export class Waited extends Error {
  constructor(what, seen) {
    super(`ждал: ${what} · видел: ${seen ?? "ничего"}`);
    this.what = what;
    this.seen = seen;
  }
}
const STOP = Symbol("первый красный шаг останавливает проверку");
const OVER = Symbol("бюджет вышел");
const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
const short = (v) => (v === undefined || v === null || v === false ? "ещё нет" : typeof v === "string" ? v : JSON.stringify(v)).slice(0, 160);
/** Текст записи человека: строкой или блоками текста. */
const saidBy = (e) => (typeof e.message?.content === "string" ? e.message.content : Array.isArray(e.message?.content) ? e.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "");
const textOf = (events) => events.filter((e) => e.type === "assistant").flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : [])).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** Обвязка одной проверки. o: title — название; transport — провод общего клиента; clock — часы; budgetMs; lane — дорожка; part — часть (SB2_PART);
 *  tag — метка; machine, second — машины; base и key — адрес флота и пропуск устройства (серверу инструментов, странице); seat — { key, model } пробных сессий; away — человек проверки не на связи: без соединения картины;
 *  out — куда печатать строки; journal — куда отдать строку шага. */
export function kit(o) {
  const clock = o.clock ?? realClock;
  const out = o.out ?? ((l) => console.log(l));
  const journal = o.journal ?? (() => {});
  const tag = o.tag ?? newTag();
  const lane = o.lane ?? QUIET;
  const budgetMs = o.budgetMs ?? BUDGET_MS;
  const deadline = clock.now() + budgetMs;
  const slug = String(o.slug ?? "check").replace(/[^a-z0-9-]/gi, "").slice(0, 12) || "check";
  let picture = emptyPicture, link = null, linkWhy = null, frames = 0;
  let ok = 0, bad = 0, current = null, over = false, stopped = false;
  const waiters = new Set();
  const cleanups = [];
  let outside; // бюджет вышел, когда проверка стояла не в ожидании обвязки
  const budget = new Promise((_, rej) => (outside = rej));
  budget.catch(() => {});

  /* --- бюджет: один таймер на проверку --- */
  const asked = []; // ожидания, которые идут сейчас: чего ждут и что видели последним
  const timer = clock.setTimeout(() => {
    over = true;
    // проверка стоит не в ожидании обвязки (читает своё, ждёт страницу): красный называет её последнее ожидание или шаг
    if (!waiters.size) outside(asked.length ? new Waited(asked.at(-1).what, asked.at(-1).last) : new Waited(current ? `шаг «${current}»` : "конец проверки", "проверка стояла вне ожиданий обвязки"));
    for (const w of [...waiters]) w.rej(OVER);
  }, budgetMs);
  /** Следующий сигнал: кадр картины или срок перечитывания — что раньше. */
  const signal = () => new Promise((res, rej) => {
    const done = (fn) => (v) => (waiters.delete(w), clock.clearTimeout(tick), fn(v));
    const w = { res: done(res), rej: done(rej) };
    const tick = clock.setTimeout(w.res, REREAD_MS);
    waiters.add(w);
  });
  /** Чужое ожидание (запрос флоту) — не дольше остатка бюджета. */
  const within = (promise, what) => new Promise((res, rej) => {
    if (over) return rej(new Waited(what, "ответа нет"));
    const w = { res() {}, rej: () => (waiters.delete(w), rej(new Waited(what, "ответа нет"))) };
    waiters.add(w);
    promise.then((v) => (waiters.delete(w), res(v)), (e) => (waiters.delete(w), rej(e)));
  });

  /* --- запросы флоту --- */
  const raw = async (type, fields = {}) => o.transport.call({ ...fields, type, id: newId("r"), trace: newId("t") });
  /** Запрос флоту: ответ целиком. Запрос, задевающий общее, проходит только по объявленной дорожке. */
  async function call(type, fields) {
    // имя запроса — словом или определением договора (@sb/protocol)
    if (typeof type !== "string") type = type.name;
    const shakes = SHAKES[type];
    if (shakes === "fleet" && lane !== ALONE) throw new Error(`запрос ${type} трясёт флот: объявите проверке дорожку «${ALONE}» в списке`);
    if (shakes === "machine" && lane === QUIET) throw new Error(`запрос ${type} трясёт машину: объявите проверке дорожку «${NOISY}» в списке`);
    return within(raw(type, fields), `ответ на ${type}`);
  }
  /** Запрос флоту: результат или отказ словом. */
  async function must(type, fields) {
    const r = await call(type, fields);
    if (!r.ok) throw new Refused(typeof type === "string" ? type : type.name, r.error, r.why);
    return r.result;
  }

  /** Запрос мимо флота (сервер инструментов, хранилище по ссылке, двойник службы): тот же fetch, предел — остаток бюджета. */
  const get = (url, init) => within((o.fetch ?? fetch)(url, init), `ответ ${String(url).split("?")[0]}`);
  /** Файл в хранилище флота по хэшу содержимого: запись { name, hash, size } для поля files сообщения. */
  async function put(name, bytes) {
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const link = (await must("files.put", { files: [{ hash, size: bytes.length }] })).upload[hash];
    // ссылки нет — такое содержимое в хранилище уже лежит
    if (link) {
      const r = await get(link, { method: "PUT", body: bytes });
      if (!r.ok) throw new Error(`загрузка ${name}: HTTP ${r.status}`);
    }
    return { name, hash, size: bytes.length };
  }

  /* --- ожидание --- */
  /** Ждать, пока read вернёт значение. Перечитывается на каждом кадре картины и по сроку перечитывания; предел — бюджет проверки.
   *  read бросил — это отказ, а не «ещё нет»: шаг красный сразу. seen — что сказать в «видел». */
  async function wait(what, read, seen) {
    const me = { what, last: undefined };
    asked.push(me);
    try {
      for (;;) {
        if (over) throw new Waited(what, me.last);
        const at = frames;
        const v = await read();
        if (v) return v;
        me.last = seen ? seen() : short(v);
        // кадр пришёл, пока читали: прочитанное уже старое — перечитать сразу, а не ждать следующего сигнала
        if (frames !== at) continue;
        try {
          await signal();
        } catch (e) {
          throw e === OVER ? new Waited(what, me.last) : e;
        }
      }
    } finally {
      asked.splice(asked.indexOf(me), 1);
    }
  }

  /* --- шаг --- */
  const words = (e) => (e instanceof Waited ? `${e.message} · бюджет ${Math.round(budgetMs / 1000)} с вышел` : String(e?.message ?? e).split("\n")[0]);
  const red = (label, e) => {
    if (stopped) return;
    stopped = true;
    bad++;
    const why = words(e);
    out(`✗ ${label} · ${why}`);
    journal({ t: clock.now(), level: "error", part: "check", module: o.title, msg: label, ok: false, why: why.slice(0, 300) });
  };
  /** Шаг: зелёный — строка ✓ с заметкой и временем; красный — строка ✗ с причиной, и проверка дальше не идёт. */
  async function step(label, fn) {
    if (stopped) throw STOP;
    if (over) throw new Waited(`шаг «${label}»`, "бюджет вышел до шага");
    const t0 = clock.now();
    current = label;
    // ожидания страницы — без своих чисел: предел каждого — остаток бюджета на начало шага; предел стоит на всём окне: его наследуют и вкладки, открытые проверкой
    for (const p of pages) (p.context().setDefaultTimeout(left()), p.context().setDefaultNavigationTimeout(left()));
    try {
      const note = await fn();
      // бюджет вышел, пока шаг стоял вне ожиданий обвязки: его красная строка уже напечатана
      if (stopped) throw STOP;
      const ms = clock.now() - t0;
      ok++;
      out(`✓ ${label}${note ? ` · ${note}` : ""} · ${ms} мс`);
      journal({ t: clock.now(), level: "info", part: "check", module: o.title, msg: label, ok: true, ms });
    } catch (e) {
      if (e === STOP) throw e;
      // красный шаг со страницей — снимок каждой страницы рядом со снимками проверки
      if (!stopped) for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(shots(), `fail-${i + 1}.png`) }).catch(() => {});
      red(label, e);
      throw STOP;
    } finally {
      current = null;
    }
  }
  const skip = async () => {};
  /** Шаги одной части проверки: идут, когда часть не названа или названа эта. */
  const only = (part) => (!o.part || o.part === part ? step : skip);

  /* --- свои ресурсы --- */
  /** Убрать за собой при любом исходе: fn(raw) зовёт флот мимо бюджета — он к уборке уже мог выйти. */
  const defer = (what, fn) => cleanups.push({ what, fn });
  /** Запуск скрипта на машине до его конца: fields — поля shell.run (script, shell, cwd…). Запуск дольше ответа — дожидается; ответ — запись запуска. */
  async function shell(machine, fields) {
    let r = await must("shell.run", { to: "@" + machine, wait: 30, ...fields });
    while (r.state === "running") r = await must("shell.wait", { to: "@" + machine, run: r.run, wait: 30 });
    return r;
  }
  /** Скрипт node на машине: что напечатал. */
  async function node(machine, code) {
    const r = await shell(machine, { shell: "node", script: `import fs from "node:fs";import os from "node:os";${code}` });
    if (r.state !== "done") throw new Error(`скрипт на ${machine}: ${r.state} ${String(r.stderr ?? r.out ?? "").slice(0, 200)}`);
    return String(r.out ?? r.stdout ?? "");
  }
  /** Ворота: команда сценария стоит, пока проверка их не откроет. command(word) — текст команды Bash: ждёт ворота и печатает слово;
   *  ею проверка держит и ход (hold), и фоновую команду, и ход чужой задачи. dir — папка на машине, где встанет файл ворот. */
  function gate(machine, dir) {
    const id = newId("g"), file = `${dir}/gate-${id}`;
    return { id, command: (word = "отпущено") => `until [ -f '${file}' ]; do sleep 0.2; done; echo ${word}`, open: () => node(machine, `fs.writeFileSync(${JSON.stringify(file)}, "")`) };
  }
  const dirs = new Map();
  /** Своя папка на машине — во временной папке машины под её настоящим именем (на Windows os.tmpdir() бывает коротким: RUNNER~1). */
  async function tmp(machine = o.machine) {
    if (!dirs.has(machine)) {
      const dir = `${(await node(machine, "process.stdout.write(fs.realpathSync.native(os.tmpdir()))")).trim().replaceAll("\\", "/")}/sb2-${slug}-${tag}`;
      dirs.set(machine, dir);
    }
    return dirs.get(machine);
  }
  let seat = o.seat;
  /** Провайдер и модель пробных сессий: SB2_KEY и SB2_MODEL; модель не названа — первая из каталога провайдера. */
  async function doc() {
    if (!seat?.model) {
      const key = seat?.key ?? "muse";
      seat = { key, model: (await must("keys.models", { name: key })).models[0].id };
    }
    return seat;
  }
  const rowOf = async (cs) => {
    if (link) return picture.sessions[cs];
    // человек проверки не на связи: картины нет — строка читается запросом
    return (await must("fleet.list", { machine: cs.slice(cs.indexOf("@") + 1), full: true })).sessions.find((s) => s.callsign === cs);
  };

  /** Своя сессия: имя с меткой проверки, папка — своя; уборка — обвязки. spec — поля документа сессии и:
   *  machine; prompt — первая задача; pair — открыть пару: ведомый — в поле wing; resume и fork — продолжить разговор с диска машины. */
  async function session(spec = {}) {
    const { machine = o.machine, name = slug, cwd: given, prompt, pair, resume, fork, ...extra } = spec;
    const full = `${name}-${tag}`;
    const cwd = given ?? `${await tmp(machine)}/${full}`;
    const more = { ...(prompt ? { prompt } : {}), ...(pair ? { pair } : {}), ...(resume ? { resume } : {}), ...(fork ? { fork } : {}) };
    const seated = extra.key && extra.model ? {} : await doc();
    const r = await must("session.open", { to: "@" + machine, spec: { name: full, cwd, ...seated, ...extra }, mkdir: true, ...more });
    const s = own(r.callsign, cwd);
    // ведомый уходит вместе с ведущей: своей уборки у него нет
    if (r.wing) s.wing = handle(r.wing, cwd);
    // сессия готова: свободна; с первой задачей — кончился её первый ход, его итог — в first
    if (prompt) s.first = await s.ended();
    else await s.idle();
    if (s.wing) await s.wing.idle();
    return s;
  }
  /** Сессия, которую проверка завела не запросом session.open (копия из архива, дочь своей сессии), — тоже своя: уборка — обвязки. */
  function own(cs, cwd) {
    defer(`сессия ${cs}`, (go) => go("session.remove", { to: cs }));
    return handle(cs, cwd);
  }
  function handle(cs, cwd) {
    const machine = cs.slice(cs.indexOf("@") + 1);
    let seen = "строки сессии нет";
    const row = async () => {
      const x = await rowOf(cs);
      if (x?.state === "failed") throw new Error(`${cs}: сессия упала — ${x.error ?? "причина не названа"}`);
      return x;
    };
    /** Итог хода за своим сообщением: записи хода и текст ответа. find — где в истории это сообщение; нет find — первый итог в разговоре. */
    const endOf = (find) => wait(`итог хода ${cs}`, async () => {
      const x = await row();
      seen = `строка сессии — ${x?.state ?? "нет"}${x?.wait ? `, годных аккаунтов Claude нет до ${new Date(x.wait).toISOString()}` : ""}`;
      // ход идёт: итога в истории ещё нет — историю не спрашиваем
      if (x?.state === "busy" || x?.state === "starting") return undefined;
      const { events } = await must("session.history", { to: cs, limit: 200 });
      const at = find ? find(events) : -1;
      if (find && at < 0) return void (seen += ", сообщения в истории ещё нет");
      const after = events.slice(at + 1);
      const end = after.findIndex((e) => e.type === "result");
      if (end < 0) return void (seen += `, последняя запись — ${after.at(-1)?.type ?? "своё сообщение"}`);
      return { events: after.slice(0, end + 1), text: textOf(after.slice(0, end)) };
    }, () => seen);
    /** Итог хода за сообщением с номером uuid (без uuid — первый итог в разговоре). */
    const ended = (uuid) => endOf(uuid ? (events) => events.findIndex((e) => e.uuid === uuid) : undefined);
    /** Итог хода за сообщением, которое ушло не через обвязку (его отправила страница): последняя запись человека с этим текстом. */
    const after = (text) => endOf((events) => events.findLastIndex((e) => e.type === "user" && saidBy(e).includes(text)));
    const send = async (text, more) => {
      const sent = await must("message", { to: cs, text, ...more });
      if (!sent.uuid) throw new Error(`message: номера сообщения нет — ${JSON.stringify(sent).slice(0, 120)}`);
      return sent.uuid;
    };
    const s = {
      callsign: cs, machine, cwd, row,
      /** Сессия свободна. */
      idle: () => wait(`${cs} свободна`, async () => (await row())?.state === "idle", () => seen),
      /** Записи разговора — последние 200. */
      history: async () => (await must("session.history", { to: cs, limit: 200 })).events,
      /** Содержимое файла папки сессии глазами машины; файла нет — пустая строка. */
      file: (name) => node(machine, `const p=${JSON.stringify(cwd + "/" + name)};process.stdout.write(fs.existsSync(p)?fs.readFileSync(p,"utf8"):"")`),
      /** Сообщение без ожидания: номер сообщения. */
      send,
      /** Ход: сообщение и итог именно этого хода. */
      turn: async (text, more) => ended(await send(text, more)),
      ended, after,
      /** «Посреди хода»: ход стоит на первом шаге сценария, пока проверка его не отпустит; then — шаги после (по умолчанию ответ «готово»).
       *  Ответ — release(): отпустить и дождаться итога хода. */
      async hold(...then) {
        const g = gate(machine, cwd);
        const uuid = await send(script(tool("Bash", { command: g.command() }), ...(then.length ? then : [say("готово")])));
        await wait(`${cs} стоит на шаге сценария`, async () => {
          const x = await row();
          seen = `строка сессии — ${x?.state ?? "нет"}`;
          const { events } = await must("session.history", { to: cs, limit: 200 });
          const at = events.findIndex((e) => e.uuid === uuid);
          return at >= 0 && JSON.stringify(events.slice(at + 1).filter((e) => e.type === "assistant")).includes(g.id);
        }, () => seen);
        return { uuid, release: async () => (await g.open(), ended(uuid)) };
      },
    };
    return s;
  }

  /* --- страница --- */
  const pages = [], pageErrors = [], profiles = [];
  let browser = null, shotDir = null;
  const left = () => Math.max(1, deadline - clock.now() - PAGE_EDGE_MS);
  /** Папка снимков проверки. */
  const shots = () => (shotDir ??= (fs.mkdirSync(path.join(root, "dist", "live", slug), { recursive: true }), path.join(root, "dist", "live", slug)));
  /** Страница флота в браузере: своё устройство по приглашению, вход принят. У ожиданий страницы своих чисел нет: предел — остаток бюджета.
   *  Ошибка страницы — красный в конце проверки; console: true — ошибкой считается и строка error консоли.
   *  profile: true — свой браузер настоящего Chrome с профилем на диске: подписка на уведомления живёт только в таком —
   *  у окна без профиля службы пушей нет, у сборки Chromium нет её ключей. Профиль — временная папка Playwright, она уходит с закрытием.
   *  На Windows настоящий Chrome на свежем профиле — отказ входа в систему (см. launchBrowser).
   *  Остальные поля — поля окна браузера (colorScheme, permissions, acceptDownloads…). */
  async function page({ width = 1440, height = 900, console: logs = false, profile = false, ...context } = {}) {
    const me = await must("whoami", {});
    const inv = await must("invite", { addr: `${slug.replaceAll("-", "")}${tag}${pages.length || ""}${me.person}` });
    defer(`приглашение ${inv.kid}`, (go) => go("revoke", { kid: inv.kid }));
    let ctx;
    if (profile) {
      ctx = await chromium.launchPersistentContext("", { channel: "chrome", viewport: { width, height }, ...context });
      profiles.push(ctx);
    } else {
      browser ??= await (o.launch ?? launchBrowser)();
      ctx = await browser.newContext({ viewport: { width, height }, ...context });
    }
    ctx.setDefaultTimeout(left());
    ctx.setDefaultNavigationTimeout(left());
    const p = ctx.pages()[0] ?? (await ctx.newPage());
    pages.push(p);
    p.on("pageerror", (e) => pageErrors.push(e.message));
    if (logs) p.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));
    await p.goto(`${o.base}/#invite=${encodeURIComponent(inv.invite)}`);
    // вход принят: навигация приложения на месте и адрес от приглашения очищен — переход, начатый раньше, страница перебила бы своим
    await p.locator("nav a").first().waitFor();
    await p.waitForFunction(() => !location.hash.includes("invite="));
    return p;
  }

  /* --- начало и конец --- */
  /** Соединение картины: первый кадр — снимок. Человеку проверки нельзя быть на связи (away) — картины нет, строки читаются запросом. */
  async function ready() {
    if (o.away) return;
    const wake = () => (frames++, [...waiters].forEach((w) => w.res()));
    link = o.transport.open("page", { onFrame: (f) => ((picture = applyFrame(picture, f)), wake()), onState: (s, why) => s === "stopped" && ((linkWhy = why ?? "stopped"), wake()) });
    await wait("картина флота", () => {
      if (linkWhy) throw new Error(`соединение картины закрыто: ${linkWhy}`);
      return picture.you !== null;
    }, () => "кадра картины нет");
  }
  /** Уборка: сначала сессии и прочее своё, потом папки — процессы сессий к тому времени папки отпустили. */
  async function cleanup() {
    clock.clearTimeout(timer);
    // окна со своим профилем — каждое свой браузер: закрытие уносит и его временный профиль
    for (const ctx of profiles.splice(0)) await ctx.close().catch(() => {});
    await browser?.close().catch(() => {});
    // KEEP=1 — оставить своё для разбора: что осталось, названо строкой
    if (o.keep) return void (out(`оставлено для разбора: ${cleanups.map((c) => c.what).join(", ") || "ничего"}`), link?.close());
    const done = await Promise.allSettled(cleanups.splice(0).reverse().map(async (c) => {
      const r = await c.fn(raw);
      if (r && r.ok === false && r.error !== "not_found") throw new Error(`${c.what} — ${r.error} ${r.why ?? ""}`);
    }));
    for (const d of done) if (d.status === "rejected") out(`уборка не прошла: ${String(d.reason?.message ?? d.reason).split("\n")[0]}`);
    for (const [machine, dir] of dirs) {
      const r = await raw("shell.run", { to: "@" + machine, shell: "node", wait: 30, script: `import fs from "node:fs";fs.rmSync(${JSON.stringify(dir)}, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })` });
      if (!r.ok || r.result?.state !== "done") out(`уборка не прошла: папка ${dir} на ${machine} — ${r.error ?? r.result?.state ?? ""} ${String(r.why ?? r.result?.stderr ?? "").slice(0, 120)}`);
    }
    link?.close();
  }

  const t = {
    title: o.title, tag, lane, fleet: o.fleet, device: o.device, machine: o.machine, second: o.second,
    base: o.base, key: o.key,
    call, must, fetch: get, put, wait, step, only, defer, shell, node, tmp, gate, session, own, page, shots, lacks: o.lacks ?? lacks,
    /** Картина флота на сейчас. */
    get picture() { return picture; },
  };
  /** Прогнать проверку: код выхода 0 — все шаги зелёные. */
  t.run = async (body) => {
    try {
      await Promise.race([(async () => (await ready(), await body(t)))(), budget]);
    } catch (e) {
      // красный мимо шагов: до первого шага — проверка не запустилась; бюджет вышел посреди шага — красный этот шаг
      if (e !== STOP) red(current ?? (ok + bad ? "проверка дошла до конца" : "проверка не запустилась"), e);
    }
    // страница, которая бросила ошибку, — красный, даже когда все шаги зелёные
    if (pageErrors.length) red("страница без ошибок", new Error([...new Set(pageErrors)].slice(0, 3).join(" | ").slice(0, 400)));
    stopped = true;
    await cleanup();
    return bad ? 1 : 0;
  };
  return t;
}

/** Вход проверки: node tools/fleet/live-x.mjs <флот> <устройство> <машина> [вторая машина].
 *  Название, дорожку, метку и файл журнала шагов называет список (live.mjs): SB2_CHECK, SB2_LANE, SB2_TAG, SB2_STEPS. */
export async function check(body, more = {}) {
  const [fleet = "test", device = "cli", machine = "devbox", second = ""] = process.argv.slice(2);
  const key = fs.readFileSync(path.join(dev, `v2-${fleet}-${device}.pass`), "utf8").trim();
  const file = path.basename(process.argv[1] ?? "check").replace(/^live-|\.(mjs|ts)$/g, "");
  const steps = process.env.SB2_STEPS;
  const t = kit({
    title: process.env.SB2_CHECK ?? file, slug: file, transport: httpTransport({ base: fleetEnv.SB2_BASE, key }), base: fleetEnv.SB2_BASE, key, fleet, device, machine, second,
    lane: process.env.SB2_LANE, part: process.env.SB2_PART, tag: process.env.SB2_TAG, away: process.env.SB2_AWAY === "1", keep: process.env.KEEP === "1",
    seat: { key: process.env.SB2_KEY, model: process.env.SB2_MODEL }, journal: steps ? (line) => appendSteps(steps, [line]) : undefined, ...more,
  });
  process.exit(await t.run(body));
}

/* ===== Прежние помощники: уходят, когда проверки переведены на вход check ===== */

/** Временная папка машины глазами самой машины, под настоящим именем (на Windows os.tmpdir() бывает коротким именем — RUNNER~1): проверка идёт с любого компьютера, в том числе с раннера CI. */
export function machineTmp(fleet, device, machine) {
  const run = fleetCall(fleet, device).must("shell.run", { to: "@" + machine, shell: "node", script: 'import fs from "node:fs";import os from "node:os";process.stdout.write(fs.realpathSync.native(os.tmpdir()))', wait: 30 });
  return String(run.out).trim().replaceAll("\\", "/");
}

/** Файл в хранилище флота по хэшу содержимого. Ответ — запись {name, hash, size} для поля files сообщения. */
export async function putFile(fleet, device, name, bytes) {
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const link = fleetCall(fleet, device).must("files.put", { files: [{ hash, size: bytes.length }] }).upload[hash];
  // ссылки нет — такое содержимое в хранилище уже лежит
  if (link) {
    const put = await fetch(link, { method: "PUT", body: bytes, signal: AbortSignal.timeout(60_000) });
    if (!put.ok) throw new Error(`загрузка ${name}: HTTP ${put.status}`);
  }
  return { name, hash, size: bytes.length };
}

/** Запросы флоту от устройства: call — ответ целиком; must — результат или ошибка со словом отказа.
 *  Сеть машины разработки моргает: запрос, не дошедший до флота (offline), повторяется до пяти раз. */
export function fleetCall(fleet, device) {
  const call = (type, fields = {}) => {
    for (let i = 0; ; i++) {
      let r;
      try {
        r = JSON.parse(execFileSync(process.execPath, [path.join(root, "tools/fleet/call.ts"), fleet, device, type, JSON.stringify(fields)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString());
      } catch (e) {
        r = JSON.parse(e.stdout.toString());
      }
      if (r.ok || r.error !== "offline" || i >= 4) return r;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    }
  };
  const must = (type, fields) => {
    const r = call(type, fields);
    if (!r.ok) throw new Error(`${type}: ${r.error} ${r.why ?? ""}`);
    return r.result;
  };
  return { call, must };
}
