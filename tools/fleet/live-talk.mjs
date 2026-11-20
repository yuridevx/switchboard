// Живая проверка разговора на выложенной странице: node tools/fleet/live-talk.mjs [флот] [устройство] [машина]
// Страница в браузере и своя сессия на ключе флота: откат в том же окне (разговор и файлы), очистка, кольцо контекста, вопрос и ответ карточками ленты,
// «Идут сейчас» со временем от начала работы после перезагрузки, перетаскивание границы списка, разговоры папки в «Новой сессии».
// Части (SB2_PART): turn — ходы сессии со страницы (очередь, молния, файл, откат); live — живое в ленте (вопрос, фоновая команда, кольцо контекста,
// ряд значков); screen — экран (очистка, границы, разрешение, пара, списки). Снимки шагов — dist/live/talk.
import path from "node:path";
import { check } from "./harness.mjs";
import { say as answer, tool, turn } from "./turn.mjs";

await check(async (t) => {
  const s = await t.session({ name: "talk" });
  const cs = s.callsign;
  const page = await t.page();
  const stepTurn = t.only("turn"), stepLive = t.only("live"), stepScreen = t.only("screen");
  const shot = (name) => page.screenshot({ path: path.join(t.shots(), name + ".png") });
  const box = page.getByRole("textbox", { name: "Сообщение сессии" });
  const opts = page.locator(".composer-opts");
  /** Последняя строка сценария: по ней история узнаёт сообщение, которое отправила страница. */
  const last = (text) => text.split("\n").at(-1);
  /** Ход со страницы: текст в поле, Enter — и итог именно этого хода. */
  const say = async (text) => {
    await box.fill(text);
    await box.press("Enter");
    return s.after(last(text));
  };
  /** Ждать, пока read даст число около want: страница перерисовывает ширину вслед за жестом. */
  const near = (what, read, want, slack) => {
    let got;
    return t.wait(what, async () => ((got = await read()), Math.abs(got - want) <= slack && got), () => `${got}, ждали ${want} ± ${slack}`);
  };

  await page.goto(`${t.base}/#/work/${cs}`);
  await box.waitFor();

  await stepTurn("панель сессии после загрузки закрыта: кнопка открывает её и закрывает", async () => {
    const panel = page.locator('aside.insp[aria-label="Инспектор"]');
    if (await panel.count()) throw new Error("панель справа открыта сама");
    const button = opts.getByRole("button", { name: "Инспектор", exact: true });
    await button.click();
    await panel.waitFor();
    await button.click();
    await panel.waitFor({ state: "detached" });
  });

  await stepTurn("Enter во время хода ставит сообщение в очередь: пометка «в очереди» и «Отменить», слов «после хода» нет", async () => {
    // ход стоит на шаге сценария, пока его не отпустят: «во время хода» — вход проверки, а не гонка с моделью. Отпускать его не придётся:
    // следующий шаг прерывает ход молнией
    await s.hold();
    for (const name of ["Отправить следующим", "Отправить сейчас", "Прервать ход"]) await page.getByRole("button", { name, exact: true }).waitFor();
    if (await page.getByLabel("Когда взять сообщение").count()) throw new Error("меню срочности осталось");
    await box.fill(turn(answer("очередь")));
    await box.press("Enter");
    const note = page.locator(".me-note").filter({ hasText: "в очереди" }).last();
    await note.waitFor();
    await note.getByRole("button", { name: "Отменить" }).waitFor();
    if (/после хода/.test(await note.innerText())) throw new Error("в пометке осталось «после хода»");
    await shot("queued");
  });

  await stepTurn("молния прерывает ход: в ленте «прервано», сообщение взято сразу", async () => {
    const now = turn(answer("стоп"));
    await box.fill(now);
    await page.getByRole("button", { name: "Отправить сейчас", exact: true }).click();
    await page.getByText(/^прервано/).last().waitFor();
    await shot("now");
    // после прерывания сессия берёт оба сообщения по очереди: очередь на странице пустеет, у каждого сообщения в истории — итог его хода
    await page.locator(".me-note").filter({ hasText: "в очереди" }).first().waitFor({ state: "detached" });
    await s.after(last(now));
    await s.after(last(turn(answer("очередь"))));
  });

  await stepTurn("ход со страницы: сессия записала файл", async () => {
    await say(turn(tool("Write", { file_path: `${s.cwd}/page.txt`, content: "первый\n" }), answer("записан первый")));
    await say(turn(tool("Write", { file_path: `${s.cwd}/page.txt`, content: "второй\n" }), answer("записан второй")));
    const text = (await s.file("page.txt")).trim();
    if (!/второй/.test(text)) throw new Error("файл: " + JSON.stringify(text));
    return "файл: " + text;
  });

  await stepTurn("откат «разговор и файлы» в том же окне: адрес тот же, лента обрезана, след отката, текст в поле ввода, файл вернулся", async () => {
    const url = page.url();
    await page.getByRole("button", { name: "Откатить сюда" }).last().click();
    const stepPage = page.locator('[data-step="rewind"]');
    await stepPage.getByText(/Из разговора уйдёт записей/).waitFor();
    await page.getByText("Разговор и файлы", { exact: true }).click();
    await stepPage.locator(".line").getByText("page.txt").first().waitFor();
    await shot("rewind-step");
    await page.getByRole("button", { name: "Откатить", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("[data-step]"));
    await page.getByText(/Откат к «.+» · файлы возвращены: 1/).first().waitFor();
    if (page.url() !== url) throw new Error(`адрес сменился: ${page.url()}`);
    // текст откаченного сообщения страница возвращает в поле ввода вслед за откатом
    let typed = "";
    await t.wait("текст откаченного сообщения в поле ввода", async () => /второй/.test((typed = await box.inputValue())), () => "в поле ввода: " + JSON.stringify(typed.slice(0, 60)));
    // после отката страница перечитывает разговор: ушедшее сообщение уходит из ленты, когда перечитка легла
    await page.locator(".feed-in .me").getByText("записан второй").first().waitFor({ state: "detached" });
    await s.idle();
    const file = (await s.file("page.txt")).trim();
    if (!/первый/.test(file) || /второй/.test(file)) throw new Error("файл на диске: " + JSON.stringify(file));
    await box.fill("");
    await shot("rewound");
    return "файл: " + file;
  });

  await stepTurn("перезагрузка страницы: лента та же обрезанная, след отката на месте", async () => {
    await page.reload();
    await box.waitFor();
    // след отката — запись того же разговора: он на месте — значит, разговор прочитан, и откаченного сообщения в нём нет
    await page.getByText(/Откат к «.+»/).first().waitFor();
    await page.locator(".feed-in .me").getByText("записан второй").first().waitFor({ state: "detached" });
  });

  await stepLive("вопрос сессии — карточкой ленты; ответ остаётся карточкой с выбранным вариантом", async () => {
    const asked = turn(tool("AskUserQuestion", { questions: [{ question: "Какой цвет?", header: "Цвет", multiSelect: false, options: [{ label: "Красный", description: "красный цвет" }, { label: "Синий", description: "синий цвет" }] }] }), answer("выбрано: {итог 1}"));
    await box.fill(asked);
    await box.press("Enter");
    const card = page.locator(".feed-in .askcard[data-open]");
    await card.first().waitFor();
    if (await page.locator(".dock .askcard").count()) throw new Error("вопрос стоит над полем ввода");
    await shot("ask");
    await card.getByRole("button", { name: "Синий", exact: true }).click();
    // у вопроса с одним выбором ответ уходит сразу; иначе его шлёт кнопка «Ответить» — что из двух, показывает сама карточка
    const send = card.getByRole("button", { name: "Ответить", exact: true });
    const done = page.locator(".feed-in .askcard.answered");
    await send.or(done).first().waitFor();
    if (await send.isVisible()) await send.click();
    await done.first().waitFor();
    await done.locator('.asked-opt[aria-current="true"]').getByText("Синий").first().waitFor();
    await done.getByText(/ответил/).first().waitFor();
    await s.after(last(asked));
    await shot("answered");
  });

  await stepLive("«Идут сейчас»: фоновая команда строкой; время — от начала работы и после перезагрузки страницы", async () => {
    // фоновая команда идёт, пока на машине нет её файла: сколько строке стоять, решает проверка, а не срок сна. Файл не появляется:
    // команда уходит вместе с сессией
    await say(turn(tool("Bash", { command: `until [ -f '${s.cwd}/run-gate' ]; do sleep 0.2; done`, run_in_background: true }), answer("запущено")));
    const time = page.getByRole("group", { name: "Идут сейчас" }).locator(".run-row .time").first();
    await time.waitFor();
    /** Время строки в секундах и возраст страницы в секундах — одним чтением. */
    const read = () => time.evaluate((el) => {
      const m = /(?:(\d+)\s*мин)?\s*(?:(\d+)\s*с)?/.exec(el.textContent ?? "");
      return { secs: Number(m?.[1] ?? 0) * 60 + Number(m?.[2] ?? 0), age: performance.now() / 1000 };
    });
    // время идёт: показанное число растёт
    const first = await read();
    let now = first;
    const before = await t.wait("время строки растёт", async () => ((now = await read()), now.secs > first.secs && now.secs >= 2 && now), () => `${now.secs} с, сначала было ${first.secs} с`);
    await page.reload();
    await time.waitFor();
    // после перезагрузки время — от начала работы на машине, а не от загрузки страницы: оно больше возраста страницы на всё, что работа шла до перезагрузки
    const after = await t.wait("время строки — от начала работы", async () => ((now = await read()), now.secs - now.age >= before.secs - 1 && now), () => `${now.secs} с при возрасте страницы ${Math.round(now.age)} с; до перезагрузки было ${before.secs} с`);
    await shot("runs");
    return `${before.secs} с → после перезагрузки ${after.secs} с`;
  });

  await stepLive("кольцо контекста: процент виден, нажатие сжимает", async () => {
    await s.idle();
    const ring = opts.getByRole("button", { name: /^Контекст \d+% · сжать$/ });
    await ring.waitFor();
    const word = await ring.getAttribute("aria-label");
    await ring.click();
    // сжатие прошло — в ленте встала его строка; отказ пришёл бы уведомлением, и строки бы не было
    await page.locator(".feed-in").getByText(/контекст сжат/).first().waitFor();
    await s.idle();
    return word;
  });

  await stepLive("ряд под полем: значки действий на месте, «/ команды» нет; шапка без кнопок действий", async () => {
    for (const name of ["Фокус", "Инспектор", "Ещё", "Очистить"]) await opts.getByRole("button", { name, exact: true }).waitFor();
    if (await opts.getByText("/ команды").count()) throw new Error("кнопка «/ команды» осталась");
    if (await page.locator(".conv-head").getByRole("button", { name: /Ещё|Инспектор/ }).count()) throw new Error("кнопки действий остались в шапке");
  });

  await stepScreen("очистка страницей подтверждения: в ленте «Разговор очищен», адрес тот же", async () => {
    const url = page.url();
    await opts.getByRole("button", { name: "Очистить" }).click();
    // подтверждает кнопка страницы шага: у значка под полем то же имя, и до появления страницы шага нажатие досталось бы ему
    await page.locator("[data-step]").getByRole("button", { name: "Очистить", exact: true }).click();
    await page.getByText("Разговор очищен").first().waitFor();
    if (page.url().replace(/\?do=.*$/, "") !== url) throw new Error("адрес сменился: " + page.url());
    await shot("cleared");
  });

  // граница списка: ширину списка называет сама граница (aria-valuenow), пока её тянут — у раскладки класс pulling
  const edge = page.getByRole("separator", { name: "Ширина списка" });
  const width = async () => Math.round((await page.locator(".pane.list").boundingBox()).width);
  const pulled = async () => Number(await edge.getAttribute("aria-valuenow"));
  const pulling = page.locator(".panes.pulling");

  await stepScreen("граница списка тянется мышью; ширину помнит устройство", async () => {
    const w0 = await width(), v0 = await pulled();
    const b = await edge.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 200);
    await page.mouse.down();
    await pulling.waitFor();
    await page.mouse.move(b.x + b.width / 2 + 90, b.y + 200, { steps: 6 });
    // страница нарисовала сдвиг — отпускание запоминает нарисованное
    await near("граница пошла за мышью на 90", pulled, v0 + 90, 12);
    await page.mouse.up();
    const w1 = await near("список шире на 90 после жеста мышью", width, w0 + 90, 12);
    await page.reload();
    await page.locator(".pane.list .row").first().waitFor();
    const w2 = await near("после перезагрузки ширина списка прежняя", width, w1, 2);
    await edge.dblclick();
    await near("двойное нажатие вернуло ширину списка", width, w0, 2);
    return `${w0} → ${w1}, после перезагрузки ${w2}`;
  });

  await stepScreen("карточка разрешения: причина вопроса и строка правила «Разрешать всегда»; «Разрешить» продолжает ход", async () => {
    await page.goto(`${t.base}/#/work/${cs}`);
    await box.waitFor();
    /** Режим в документе сессии встал, сессия свободна. */
    const mode = async (want) => {
      await t.must("session.update", { to: cs, patch: { mode: want } });
      let row;
      await t.wait(`режим «${want}» в строке сессии`, async () => ((row = await s.row()), row?.spec?.mode === want && row.state === "idle"), () => `режим ${row?.spec?.mode ?? "не назван"}, сессия ${row?.state ?? "нет"}`);
    };
    await mode("ask");
    // файл вне папки сессии: Claude называет причину вопроса и правило с этой папкой (отдельного поля пути SDK для Write не даёт — факт прогона 10 нояб.)
    const asked = turn(tool("Write", { file_path: `${s.cwd}-out.txt`, content: "ok" }), answer("записан"));
    await box.fill(asked);
    await box.press("Enter");
    const card = page.locator(".feed-in .askcard[data-open]");
    await card.first().waitFor();
    await card.getByText(/запишет правило/).first().waitFor();
    await card.getByText(/outside allowed working directories/).first().waitFor();
    await shot("permission");
    await card.getByRole("button", { name: "Разрешить", exact: true }).click();
    await s.after(last(asked));
    if ((await s.file(`../${path.posix.basename(s.cwd)}-out.txt`)) !== "ok") throw new Error("файл не создан после разрешения");
    // следующие шаги идут в прежнем режиме; файл лежит в своей папке проверки — её убирает обвязка
    await mode("all");
  });

  await stepScreen("граница списка тянется пальцем", async () => {
    await s.idle();
    const w0 = await width(), v0 = await pulled();
    const b = await edge.boundingBox();
    // настоящее касание через протокол браузера: события указателя вида touch рождает сам Chrome
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    const x0 = Math.round(b.x + b.width / 2), y = Math.round(b.y + 200);
    const touch = (type, x) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    try {
      await touch("touchStart", x0);
      await pulling.waitFor();
      for (const dx of [20, 40, 60]) await touch("touchMove", x0 + dx);
      // страница нарисовала сдвиг — отпускание запоминает нарисованное
      await near("граница пошла за пальцем на 60", pulled, v0 + 60, 12);
      await touch("touchEnd", x0 + 60);
    } finally {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
    const w1 = await near("список шире на 60 после жеста пальцем", width, w0 + 60, 12);
    await edge.dblclick();
    await near("двойное нажатие вернуло ширину списка", width, w0, 2);
    return `${w0} → ${w1}`;
  });

  await stepScreen("пара: шапка с двумя участниками, выбор стороны, «обе» и инспектор у стороны ведомого", async () => {
    // ведомого заводит сама сессия — он тоже свой: уборка — обвязки
    const wing = t.own((await t.must("session.update", { to: cs, patch: {}, pair: true })).wing, s.cwd);
    await wing.idle();
    await page.goto(`${t.base}/#/work/${cs}`);
    const bar = page.getByRole("group", { name: "Пара" });
    await bar.locator(".pm-who").nth(1).waitFor();
    if ((await bar.locator(".pm-who").count()) !== 2) throw new Error("в шапке пары не два участника");
    const who = bar.locator(`.pm-who[aria-label$="${wing.callsign}"]`);
    // выбрать ведомого: показана его сторона, адрес — его
    await who.click();
    await page.waitForFunction((w) => location.hash.includes(w), wing.callsign);
    await bar.locator(`.pm-who[aria-pressed="true"][aria-label$="${wing.callsign}"]`).waitFor();
    await bar.locator('.pm-who[aria-pressed="false"]').waitFor();
    // повторное нажатие на показанную сторону — обе рядом
    await who.click();
    await page.locator(".talk.pair .conv").nth(1).waitFor();
    if ((await page.locator(".talk.pair .conv").count()) !== 2) throw new Error("при «обе» не два разговора");
    // инспектор стороны ведомого: его разговор и инспектор, ведущая остаётся участником шапки
    await page.locator(".talk.pair .conv").nth(1).locator(".composer-opts").getByRole("button", { name: "Инспектор" }).click();
    await page.locator('aside.insp[aria-label="Инспектор"]').waitFor();
    await page.locator(".talk.with-insp").waitFor();
    if ((await page.locator(".talk .conv").count()) !== 1) throw new Error("с инспектором показаны оба разговора");
    if ((await bar.locator(".pm-who").count()) !== 2) throw new Error("вторая сторона пропала из шапки");
    await shot("pair-inspector");
    // закрытие инспектора возвращает обе стороны
    await page.locator(".composer-opts").getByRole("button", { name: "Инспектор" }).first().click();
    await page.locator(".talk.pair").waitFor();
    // следующие шаги идут без пары
    await t.must("session.update", { to: cs, patch: { wing: null } });
  });

  await stepScreen("«Работа» открывает последнюю сессию; раздела «Вам» нет", async () => {
    // последняя — та, что человек открывал последней
    await page.goto(`${t.base}/#/work/${cs}`);
    await box.first().waitFor();
    await page.goto(`${t.base}/#/fleet/machines`);
    await page.waitForFunction(() => location.hash.startsWith("#/fleet"));
    await page.goto(`${t.base}/#/work`);
    await page.waitForFunction((c) => location.hash.includes(c), cs);
    if (await page.locator("nav.rail").getByText("Вам", { exact: true }).count()) throw new Error("пункт «Вам» остался");
  });

  await stepScreen("«Новая сессия»: разговоры папки списком; занятый — только копией; продолжение открывает сессию", async () => {
    await page.goto(`${t.base}/#/new?machine=${s.machine}&cwd=${encodeURIComponent(s.cwd)}`);
    const list = page.getByRole("listbox", { name: "Разговоры папки" });
    await list.getByRole("option").first().waitFor();
    const n = await list.getByRole("option").count();
    await list.getByRole("option").filter({ hasText: /занят/ }).first().click();
    await t.wait("занятый разговор стал копией", () => page.getByLabel("Копией").isChecked());
    await shot("conversations");
    // копию открывает страница — сессия всё равно своя: уборка — обвязки
    t.own(`talkcopy-${t.tag}@${s.machine}`, s.cwd);
    await page.getByRole("textbox", { name: "Имя" }).fill("talkcopy-" + t.tag);
    await page.getByRole("button", { name: "Продолжить разговор" }).click();
    await page.waitForFunction((tag) => location.hash.includes("talkcopy-" + tag), t.tag);
    return `разговоров в папке ${n}`;
  });
});
