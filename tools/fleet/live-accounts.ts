// Живая проверка аккаунтов и моделей: node tools/fleet/live-accounts.ts [флот] [устройство] [машина]
// Нужен хотя бы один аккаунт Claude — ключ флота с протоколом claude. Модель сессий — SB2_CLAUDE_MODEL или самая дешёвая из каталога (Haiku).
// Шаги: каталог Claude; ход без входа и час кэша; строки журнала вызова — на машине и в ClickHouse; негодный токен — аккаунт выбыл, сессии идут на годные;
// «/model слова» сообщением; модель провайдера из каталога. Свой негодный аккаунт проверка заводит, обвязка убирает.
// Части (SB2_PART): token — негодный аккаунт и рычаг аккаунта: «первым» и «выключен» (меняет общее для флота: идёт одна); rest — остальное;
// provider — ключ провайдера: в список выпуска не входит — выпуск не зависит от чужого ключа и его предела трат. Запуск руками:
// SB2_PART=provider [SB2_PROVIDER_KEY=имя] node tools/fleet/live-accounts.ts [флот] [устройство] [машина]
import { CLAUDE } from "@sb/protocol";
import { check } from "./harness.mjs";
import { say, tool, turn } from "./turn.mjs";

const PROMPT = "Ответь одним словом: ok";

await check(async (t: any) => {
  const stepRest = t.only("rest");
  const stepToken = t.only("token");
  const stepProvider = t.only("provider");
  /** Свой негодный аккаунт проверки: токен не настоящий. */
  const BOGUS = `bogus-${t.tag}@example.com`;
  const machine = "@" + t.machine;
  /** Строки журнала машины о своей сессии. */
  const journal = async (msg: string, session: string): Promise<Array<Record<string, any>>> => (await t.must("machine.journal", { to: machine, session, limit: 200 })).lines.filter((l: any) => l.msg === msg);
  /** Своя сессия на Claude с первой задачей: обвязка ждёт итог её первого хода. */
  const open = (name: string, doc: { key: string; model: string }, prompt = PROMPT) => t.session({ name, ...doc, prompt });
  /** Строка сессии, догнавшая ход: в ней ответ, аккаунт и то, что назовёт want. Упавшая сессия — отказ сразу. */
  const settled = (s: any, what: string, want: (r: any) => unknown) => {
    let seen = "строки нет";
    return t.wait(`строка ${s.callsign}: ${what}`, async () => {
      const r = await s.row();
      seen = r ? `${r.state}, аккаунт ${r.account ?? "—"}, ответ «${String(r.result ?? "").slice(0, 40)}»` : "строки нет";
      return r?.state === "idle" && r.result && want(r) && r;
    }, () => seen);
  };

  let models: Array<{ id: string; family?: string; window?: number }> = [];
  let cheap = "";
  let real: string[] = [];
  await t.step("каталог Claude по токену аккаунта: модели с семейством и окном", async () => {
    real = (await t.must("keys.list", {})).keys.filter((k: any) => k.protocol === CLAUDE).map((k: any) => k.name);
    if (!real.length) throw new Error("у флота нет аккаунта Claude: keys.set { name: почта, protocol: claude, value: токен }");
    models = (await t.must("keys.models", { name: CLAUDE })).models;
    cheap = process.env.SB2_CLAUDE_MODEL ?? models.find((m) => /haiku/i.test(m.id))?.id ?? "";
    if (!cheap) throw new Error("в каталоге нет Haiku: назовите модель в SB2_CLAUDE_MODEL");
    if (models.some((m) => !m.family || !m.window)) throw new Error("модель без семейства или окна: " + JSON.stringify(models.find((m) => !m.family || !m.window)));
    return `моделей ${models.length}, аккаунтов ${real.length}; сессии сценария — ${cheap}`;
  });

  let first: any;
  await stepRest("ход без входа: сессия ответила на аккаунте, который выбрала машина; кэш разговора часовой", async () => {
    first = await open("acc", { key: CLAUDE, model: cheap });
    const row = await settled(first, "аккаунт и срок кэша", (r) => r.account && r.cache);
    if (!real.includes(row.account)) throw new Error("аккаунт в строке: " + row.account);
    if (row.answers) throw new Error(`ответила ${row.answers}, а в документе ${row.spec.model}`);
    const left = Math.round((row.cache.until - Date.now()) / 60_000);
    if (left < 50 || left > 61) throw new Error(`час кэша: осталось ${left} мин — ждали около 60`);
    const list = (await t.must("account.list", { to: machine })).accounts.find((a: any) => a.name === row.account);
    if (!list?.ok || !list.limits.some((l: any) => l.name === "seven_day")) throw new Error("окна аккаунта из заголовков: " + JSON.stringify(list));
    return `${row.account}: кэш тёплый ещё ${left} мин; неделя ${Math.round(list.limits.find((l: any) => l.name === "seven_day").used * 100)} %`;
  });

  await stepRest("каждый вызов и решение — строка журнала машины; те же строки читаются из ClickHouse", async () => {
    // строки пишет машина в ответ на вызов, до итога хода: читаются сразу
    const calls = await journal("call", first.callsign);
    const ok = calls.filter((l) => l.status === 200 && l.account && l.req);
    if (!ok.length) throw new Error("строк call со статусом 200, аккаунтом и номером запроса нет: " + JSON.stringify(calls.slice(0, 2)));
    if (!(await journal("route", first.callsign)).some((l) => Array.isArray(l.candidates))) throw new Error("строки route с кандидатами нет");
    // истории флота у флота нет (коробка без контейнера ClickHouse) — шаг кончается журналом машины
    if (t.lacks("clickhouse")) return `call на машине ${calls.length}`;
    let seen = 0;
    const stored = await t.wait("строки call сессии в ClickHouse", async () => {
      const r = await t.must("log.query", { msg: "call", session: first.callsign, limit: 50 });
      seen = r.lines.length;
      return r.lines.length >= ok.length && r.lines;
    }, () => `строк ${seen} из ${ok.length}`);
    return `call на машине ${calls.length}, в ClickHouse ${stored.length}`;
  });

  await stepToken("токен аккаунта не годен: вызов ушёл на следующий аккаунт, ход не оборван; аккаунт выбыл с причиной; происшествие", async () => {
    await t.must("keys.set", { name: BOGUS, protocol: CLAUDE, value: `sk-ant-oat01-${t.tag}-not-a-token` });
    t.defer(`аккаунт ${BOGUS}`, (go: any) => go("keys.remove", { name: BOGUS }));
    // список аккаунтов машины пробует новый аккаунт сам: негодный выбывает с причиной
    let seen = "аккаунта в списке нет";
    const out = await t.wait("машина пробовала новый аккаунт и вывела его", async () => {
      const a = (await t.must("account.list", { to: machine })).accounts.find((x: any) => x.name === BOGUS);
      seen = a ? `ok ${a.ok}, причина ${a.why ?? "—"}` : "аккаунта в списке нет";
      return a?.ok === false && a;
    }, () => seen);
    if (!out.why) throw new Error("аккаунт выбыл без причины");
    // своя метка в имени аккаунта: строка о нём — только своя
    const told = (await t.must("machine.journal", { to: machine, level: "error", limit: 200 })).lines.find((l: any) => l.msg === "account.token" && l.account === BOGUS);
    if (told?.word !== "bad_token") throw new Error("строки account.token о негодном аккаунте нет: " + JSON.stringify(told));
    const s = await open("hop", { key: CLAUDE, model: cheap });
    const row = await settled(s, "аккаунт", (r) => r.account);
    if (!real.includes(row.account)) throw new Error("сессия на " + row.account);
    // вызов, который успел уйти на негодный аккаунт до пробы, кончился отказом 401 — и ход дошёл на годном
    const tried = (await journal("call", s.callsign)).filter((l) => l.account === BOGUS);
    if (tried.some((l) => l.status !== 401)) throw new Error("вызов на негодном аккаунте: " + JSON.stringify(tried.map((l) => l.status)));
    return `${BOGUS}: ${out.why}; сессия на ${row.account}${tried.length ? `, после 401 на негодном` : ""}`;
  });

  // Отказ по заказу умеет только двойник Claude (флот в коробке): заказ — сам токен аккаунта. Настоящему аккаунту токен не меняем:
  // шаг идёт, только когда адрес аккаунта — этот компьютер.
  const tame = (name: string, keys: Array<{ name: string; base?: string }>) => /^http:\/\/127\.0\.0\.1[:/]/.test(keys.find((k) => k.name === name)?.base ?? "");
  // Рычаг аккаунта: «первым» и «выключен». Свойству нужны два годных аккаунта с равными окнами — так устроены двойники коробки:
  // тогда без рычага выбор решают тёплые сессии, и шаг может назвать аккаунт, который по счёту проиграл бы.
  /** Кандидат строки выбора, как его записала машина: остаток, часы до сброса, тёплые сессии. */
  type Cand = { account: string; rem: number; hours: number; warm: number; first?: boolean };
  /** Кто выиграл бы без рычага: счёт = остаток ÷ часы ÷ (1 + тёплые); при равном — у кого меньше тёплых, дальше — по имени. */
  const beats = (a: Cand, b: Cand) => {
    const sa = a.rem / a.hours / (1 + a.warm), sb = b.rem / b.hours / (1 + b.warm);
    return Math.abs(sa - sb) > 1e-9 ? sa > sb : a.warm !== b.warm ? a.warm < b.warm : a.account < b.account;
  };
  /** Строка выбора сессии: её последнее решение с кандидатами. */
  const routeOf = async (s: any): Promise<{ account: string; why?: string; candidates: Cand[] }> => {
    const line = (await journal("route", s.callsign)).find((l) => l.account && Array.isArray(l.candidates));
    if (!line) throw new Error(`строки выбора у ${s.callsign} нет`);
    return line as any;
  };
  let lever = "", levered: any;
  if (real.length > 1 && tame(real[0]!, (await t.must("keys.list", {})).keys)) await stepToken("рычаг «первым»: новая сессия идёт на аккаунт «первым», хотя по счёту выиграл бы другой; в строке выбора — пометка", async () => {
    const s = await open("lev", { key: CLAUDE, model: cheap });
    const on = (await settled(s, "аккаунт", (r) => r.account)).account;
    // после этой сессии: кто из двух проиграл бы следующий выбор по счёту — тому и рычаг
    const after = (await routeOf(s)).candidates.map((c) => ({ ...c, warm: c.warm + (c.account === on ? 1 : 0) }));
    if (after.length !== 2) throw new Error("кандидатов в строке выбора не два: " + JSON.stringify(after));
    lever = (beats(after[0]!, after[1]!) ? after[1]! : after[0]!).account;
    await t.must("keys.set", { name: lever, protocol: CLAUDE, use: "first" });
    t.defer(`рычаг ${lever}`, (go: any) => go("keys.set", { name: lever, protocol: CLAUDE, use: "auto" }));
    // машина перечитала аккаунты: её ответ на список аккаунтов ждёт чтения
    await t.must("account.list", { to: machine });
    levered = await open("lev2", { key: CLAUDE, model: cheap });
    const row = await settled(levered, "аккаунт", (r) => r.account);
    if (row.account !== lever) throw new Error(`сессия на ${row.account}, «первым» стоит ${lever}`);
    const route = await routeOf(levered);
    const mine = route.candidates.find((c) => c.account === lever), other = route.candidates.find((c) => c.account !== lever);
    if (!mine?.first) throw new Error("у кандидата «первым» нет пометки: " + JSON.stringify(route.candidates));
    // посылка шага: без рычага выиграл бы сосед — иначе шаг ничего не доказал
    if (!other || !beats(other, mine)) throw new Error("без рычага этот аккаунт выиграл бы и сам: " + JSON.stringify(route.candidates));
    if (!String((route as any).why ?? "").includes("первым")) throw new Error("в причине выбора нет «первым»: " + (route as any).why);
    return `${lever}: тёплых ${mine.warm} против ${other.warm} у ${other.account} — выбран он`;
  });

  if (lever) await stepToken("рычаг «выключен»: следующий вызов сессии идёт другим аккаунтом, причина перехода названа; выключенным вызовов нет; поворот — в истории флота", async () => {
    const spent = (await journal("call", levered.callsign)).filter((l) => l.account === lever).length;
    await t.must("keys.set", { name: lever, protocol: CLAUDE, use: "off" });
    await t.must("account.list", { to: machine });
    const word = `off-${t.tag}`;
    await levered.turn(turn(say(word)));
    const row = await settled(levered, `ответ «${word}» на другом аккаунте`, (r) => String(r.result).includes(word));
    if (row.account === lever || !real.includes(row.account)) throw new Error(`ход кончился на ${row.account}, выключен ${lever}`);
    const calls = (await journal("call", levered.callsign)).filter((l) => l.account === lever).length;
    if (calls !== spent) throw new Error(`выключенным аккаунтом сделано вызовов: ${calls - spent}`);
    const moved = (await journal("account.moved", levered.callsign)).find((l) => l.account === row.account);
    if (!String(moved?.why ?? "").includes("аккаунт выключен")) throw new Error("причины перехода «аккаунт выключен» нет: " + JSON.stringify(moved));
    // рычаг возвращён: следующим шагам нужны оба аккаунта
    await t.must("keys.set", { name: lever, protocol: CLAUDE, use: "auto" });
    await t.must("account.list", { to: machine });
    // истории флота у флота нет (коробка без контейнера ClickHouse) — шаг кончается журналом машины
    if (t.lacks("clickhouse")) return `${lever} → ${row.account}: аккаунт выключен`;
    let seen = "строк нет";
    await t.wait("строки о поворотах рычага в ClickHouse", async () => {
      const kinds = (await t.must("log.query", { msg: "account.use", account: lever, limit: 20 })).lines.map((l: any) => l.kind);
      seen = kinds.join(", ") || "строк нет";
      return kinds.includes("first") && kinds.includes("off");
    }, () => seen);
    return `${lever} → ${row.account}: аккаунт выключен; в истории — ${seen}`;
  });

  if (real.length > 1 && tame(real[0]!, (await t.must("keys.list", {})).keys)) await stepToken("лимит недели кончился посреди хода: ход дошёл на другом аккаунте, сессия отказа не видит", async () => {
    const s = await open("lim", { key: CLAUDE, model: cheap });
    const full = (await settled(s, "аккаунт", (r) => r.account)).account;
    const keys = (await t.must("keys.list", {})).keys;
    if (!tame(full, keys)) throw new Error(`аккаунт ${full} — не двойник: токен не трогаю`);
    const base = keys.find((k: any) => k.name === full).base;
    // лимит кончится, когда в разговоре будет два ответа модели: после вызова команды, до ответа на её итог
    await t.must("keys.set", { name: full, protocol: CLAUDE, base, value: `sk-ant-oat01-${t.tag}-full-after-2` });
    // аккаунту двойника — свежий токен без заказа, и лимиты спрошены заново
    t.defer(`токен ${full}`, async (go: any) => {
      const r = await go("keys.set", { name: full, protocol: CLAUDE, base, value: `sk-ant-oat01-${t.tag}-0000000000000000` });
      await go("account.list", { to: machine, fresh: true });
      return r;
    });
    // машина перечитала токены: её ответ на список аккаунтов ждёт чтения. Без этого ход успевал уйти на другой аккаунт до отказа
    await t.must("account.list", { to: machine });
    const reply = await s.turn(turn(tool("Bash", { command: "echo 77" }), say("число: {итог 1}")));
    if (!reply.text.includes("77")) throw new Error("итог хода: " + reply.text.slice(0, 120));
    const row = await settled(s, "ответ с числом 77", (r) => String(r.result).includes("77"));
    if (row.account === full || !real.includes(row.account)) throw new Error(`ход кончился на аккаунте ${row.account}, лимит был у ${full}`);
    const calls = await journal("call", s.callsign);
    if (!calls.some((l) => l.account === full && l.status === 429)) throw new Error("строки вызова с отказом 429 у аккаунта с лимитом нет: " + JSON.stringify(calls.map((l) => [l.account, l.status])));
    // человеку отказ виден строкой журнала в ленте; в разговоре модели — в репликах — его нет
    const said = JSON.stringify((await s.history()).filter((e: any) => e.type === "assistant" || e.type === "user"));
    const leak = /rate.limit|exceed your account/i.exec(said);
    if (leak) throw new Error("отказ лимита дошёл до разговора сессии: " + said.slice(Math.max(0, leak.index - 80), leak.index + 80));
    return `${full}: 429 посреди хода → ${row.account}; итог: ${reply.text.slice(0, 40)}`;
  });

  await stepRest("«/model слова» сообщением ставит модель, в разговор команда не уходит; несколько подходящих — отказ; у каждого семейства Claude модель ответа совпала с каталогом", async () => {
    const many = await t.call("message", { to: first.callsign, text: "/model claude" });
    if (many.ok || many.error !== "many_models") throw new Error("«/model claude»: " + (many.ok ? "принята" : many.error));
    // по одной модели семейства — первая в каталоге; SB2_FAMILIES=Haiku,Sonnet сужает проверку
    const only = process.env.SB2_FAMILIES?.split(",");
    const firsts = models.filter((m, i) => models.findIndex((x) => x.family === m.family) === i && (!only || only.includes(m.family ?? "")));
    const drift: string[] = [];
    for (const [i, m] of firsts.entries()) {
      const set = await t.must("message", { to: first.callsign, text: `/model ${m.id}` });
      if (!set.model || !set.model.startsWith(m.id)) throw new Error(`модель ${m.id}: ответ ${set.model}`);
      // картина флота догоняет ответ запроса не сразу: документ сессии — когда в нём встала модель
      await t.wait(`модель ${set.model} в документе ${first.callsign}`, async () => (await first.row())?.spec.model === set.model);
      // слово хода своё у каждой модели: строка, в которой оно есть, догнала именно этот ход
      const word = `model${i}-${t.tag}`;
      await first.turn(turn(say(word)));
      const after = await settled(first, `ответ «${word}»`, (r) => String(r.result).includes(word));
      if (after.answers) drift.push(`${after.spec.model} → ${after.answers}`);
    }
    if (drift.length) throw new Error("ответила не названная модель: " + drift.join("; "));
    return `совпали ${firsts.length} из ${firsts.length}: ${firsts.map((m) => m.id).join(", ")}`;
  });

  await stepProvider("модель провайдера из каталога: сессия на ключе флота отвечает моделью, названной в документе", async () => {
    const want = process.env.SB2_PROVIDER_KEY;
    const provider = (await t.must("keys.list", {})).keys.find((k: any) => k.protocol !== CLAUDE && (!want || k.name === want));
    if (!provider) throw new Error(want ? `у флота нет ключа провайдера ${want}` : "у флота нет ключа провайдера");
    const list = (await t.must("keys.models", { name: provider.name })).models;
    if (!list.length) throw new Error(`каталог ${provider.name} пуст`);
    // модель выбирается сама из бесплатных моделей каталога («…-free», с названным видом API): платная тратит дневной предел ключа,
    // а с исчерпанным пределом провайдер не отдаёт и каталог. Бесплатных нет — первая из каталога. SB2_PROVIDER_MODEL — своя.
    const free = list.filter((m: any) => /-free$/.test(m.id) && m.protocol);
    const model = process.env.SB2_PROVIDER_MODEL ?? (free[0] ?? list[0]).id;
    const s = await open("prov", { key: provider.name, model });
    const row = await settled(s, "ответ", () => true);
    if (row.account) throw new Error("у сессии провайдера в строке аккаунт Claude: " + row.account);
    return `${provider.name}/${model}: моделей в каталоге ${list.length}, бесплатных ${free.length}`;
  });
});
