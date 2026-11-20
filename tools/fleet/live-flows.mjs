// Живая проверка флоу без окон: node tools/fleet/live-flows.mjs <флот> <устройство> [машина]
// В браузере на 1440 и 390: шаги открываются страницами с адресом, «Назад» браузера возвращает на экран, окон поверх экрана нет.
// Части (SB2_PART): rest — флоу; people — галочка проекта в «Людях»: смена состава проекта рвёт соединения всех страниц человека, поэтому идёт одна.
import path from "node:path";
import { check } from "./harness.mjs";

// окно — видимое; скрытый список выпадающего поля окном не считается
const overlays = '[role="dialog"]:visible, .mantine-Modal-root:visible, .mantine-Drawer-root:visible, .mantine-Popover-dropdown:not(.mantine-Select-dropdown):visible';

await check(async (t) => {
  const stepRest = t.only("rest"), stepPeople = t.only("people");
  // шаги с открытым разговором идут на своей сессии: чужая может уйти посреди шага; заводится первым шагом, которому нужна
  let session;
  const own = async () => (session ??= await t.session({ name: "flow" })).callsign;
  // галочка — в своём проекте: состав чужого проверка не трогает; проект уходит с уборкой
  let project;
  const ownProject = async () => {
    if (project) return project;
    const id = "flow" + t.tag;
    await t.must("project.set", { project: id, name: id });
    t.defer(`проект ${id}`, (go) => go("project.remove", { project: id }));
    const me = await t.must("whoami", {});
    const row = (await t.must("people.list", {})).people.find((p) => p.person === me.person);
    return (project = { id, label: `${row?.name ?? me.person} в проекте ${id}` });
  };

  for (const [w, h] of [[1440, 900], [390, 844]]) {
    let page;
    /** Причина красного шага: первая строка, журнал действия браузера (чего ждал и что не пустило) и где страница стояла. */
    const why = async (e) => {
      const lines = String(e?.message ?? e).split("\n");
      const log = [...new Set(lines.slice(2).map((l) => l.replace(/^\s*(\d+ × )?-?\s*/, "")).filter((l) => l && !/^retrying|^waiting \d+ms|^attempting|^scrolling|^done scrolling/.test(l)))].slice(0, 5).join(" → ");
      const where = !page ? "страница не открылась" : await page.evaluate(() => `${location.hash} · «${document.querySelector("h1")?.textContent ?? ""}»`).catch(() => "страница не ответила");
      return `${lines[0]}${log ? " · " + log.slice(0, 500) : ""} · адрес ${where}`;
    };
    /** Шаг этой ширины: своя страница (устройство по приглашению), после шага окон поверх экрана нет. */
    const on = (step) => (label, fn) => step(`${w} · ${label}`, async () => {
      try {
        page ??= await t.page({ width: w, height: h });
        await fn();
      } catch (e) {
        // ожидание обвязки называет себя само; у ожидания страницы причина — в журнале действия браузера
        if (!String(e?.message ?? "").includes("\n")) throw e;
        throw new Error(await why(e));
      }
      const over = await page.locator(overlays).count();
      if (over) throw new Error(`окон поверх экрана: ${over} · ${await page.locator(overlays).first().evaluate((e) => e.outerHTML.slice(0, 240))}`);
    });
    const rest = on(stepRest), people = on(stepPeople);
    const shot = (name) => page.screenshot({ path: path.join(t.shots(), `${w}-${name}.png`) });
    const at = (re) => page.waitForFunction((s) => new RegExp(s).test(location.hash), re.source);
    const heading = (name) => page.getByRole("heading", { name }).first();
    const title = (name) => heading(name).waitFor();
    // страница шага закрыта: адрес от неё очищен и её самой нет
    const closed = () => page.waitForFunction(() => !/do=/.test(location.hash) && !document.querySelector("[data-step]"));
    /** Переход на экран: новый экран встал (его элемент на месте) и его чтения ответили — знак aria-busy="false" у области экрана.
     *  reload — экран с загрузки страницы: без прочитанного раньше. */
    const open = async (hash, ready, reload = false) => {
      await page.goto(`${t.base}/#${hash}`);
      if (reload) await page.reload();
      await ready.waitFor();
      await page.locator('.screen[aria-busy="false"]').waitFor({ state: "attached" });
    };

    await rest("новая сессия — страница", async () => {
      await page.getByRole("button", { name: "Новая сессия" }).first().click();
      await at(/^#\/new/); await title("Новая сессия"); await shot("new");
      await page.goBack(); await page.waitForFunction(() => !location.hash.startsWith("#/new"));
    });
    await rest("найти — страница", async () => {
      await open("/find", heading("Найти"));
      await page.getByRole("textbox", { name: "Найти" }).fill("машин");
      await page.getByRole("option").first().waitFor(); await shot("find");
    });
    await rest("добавить машину — шаг и назад", async () => {
      const add = page.getByRole("button", { name: /Добавить машину/ });
      await open("/fleet/machines", add);
      await add.click();
      await at(/do=add/); await title("Добавить машину"); await shot("add-machine");
      await page.goBack(); await closed();
    });
    await rest("аккаунты и провайдеры — формы на месте: токен аккаунта и ключ провайдера; очередей нет", async () => {
      await open("/fleet/accounts", page.locator("[data-card=claude]"));
      // форма — страница шага со своим адресом: на экран с кнопками возвращает «Назад» браузера
      await page.getByRole("button", { name: "Добавить аккаунт" }).first().click();
      await at(/do=account/); await page.getByLabel("Почта аккаунта").waitFor(); await page.getByLabel("Токен", { exact: true }).waitFor(); await shot("account-new");
      await page.goBack(); await closed();
      await page.getByRole("button", { name: "Добавить провайдера" }).first().click();
      await at(/do=key/); await page.getByLabel("Протокол").first().waitFor(); await shot("provider-new");
      await page.goBack(); await closed();
      if (await page.getByRole("button", { name: "+ очередь" }).count()) throw new Error("на экране осталась кнопка очереди");
      if (!page.url().endsWith("#/fleet/accounts")) throw new Error("адрес экрана: " + page.url());
    });
    await rest("пригласить устройство — форма, затем ссылка", async () => {
      const name = `flowtest${w}${t.tag}`;
      // приглашение, выданное страницей, уходит с уборкой: его номер знает только список пропусков
      t.defer(`приглашение ${name}`, async (go) => {
        const r = await go("passes", { kind: "device" });
        const kid = r.ok && r.result.passes.find((p) => p.addr.startsWith(name + "~"))?.kid;
        return kid ? go("revoke", { kid }) : r;
      });
      const give = page.getByRole("button", { name: "Выдать приглашение" });
      await open("/settings/passes", give);
      await page.getByRole("textbox", { name: "Имя устройства" }).fill(name);
      await give.click();
      await at(/do=link/); await shot("invite-link");
      // «Готово» закрывает страницу шага возвратом по истории: шаг кончен, когда и адрес от него очищен — иначе возврат догонит следующий переход
      await page.getByRole("button", { name: "Готово" }).click();
      await closed();
    });
    await rest("удалить сессию — страница подтверждения, отмена", async () => {
      const more = page.locator(".composer-opts").getByRole("button", { name: "Ещё" }).first();
      await open("/work/" + (await own()), more);
      await more.click();
      await page.getByRole("menuitem", { name: "Убрать сессию" }).click();
      await at(/do=confirm/); await shot("confirm");
      await page.getByRole("button", { name: "Отмена" }).click();
      await closed();
    });
    if (w < 861) await rest("сведения о сессии — страница", async () => {
      const inspector = page.getByRole("button", { name: "Инспектор" });
      await open("/work/" + (await own()), inspector);
      await inspector.click();
      await at(/do=info/); await shot("info");
      await page.goBack(); await closed();
    });
    if (w < 861) await rest("ещё — страница", async () => {
      await open("/inbox", page.locator('section[aria-label="Работа"]'));
      await page.locator("nav.tabbar").getByText("Ещё").click();
      await at(/^#\/more/); await title("Ещё"); await shot("more");
    });
    await rest("новая сессия — один уровень, кусочки показывают свои поля", async () => {
      // своя машина и своя папка, которой ещё нет: соседей в ней нет, и форма сама ничего не отмечает. Без них форма берёт последнее место
      // человека или последнюю папку машины — папку соседней проверки, — и выбор кусочков идёт за её сессией, пока та живёт
      const cwd = `${await t.tmp()}/new-${t.tag}`;
      await open(`/new?machine=${t.machine}&cwd=${encodeURIComponent(cwd)}`, page.getByLabel("Размышлять перед ответом"));
      if (await page.getByRole("button", { name: /Скрыть настройки|Модель, аккаунт/ }).count()) throw new Error("настройки спрятаны");
      // кусочки машины берут из репозитория на GitHub
      if (!t.lacks("github")) {
        if (await page.getByLabel("reviewer", { exact: true }).isChecked()) throw new Error("в своей папке без соседей кусочек reviewer отмечен до нажатия");
        await page.getByText("reviewer", { exact: true }).click();
        await page.locator('[aria-label="Что ставят кусочки"]').getByText("claude-opus-5-5").waitFor();
      }
      await shot("new-flat");
    });
    await people("галочка проекта в «Людях» — без полосы «нет связи»", async () => {
      const { label } = await ownProject();
      const box = page.getByRole("checkbox", { name: label, exact: true });
      // список людей страница уже прочла до своего проекта и держит в кэше: экран — с загрузки страницы, иначе галочки нет до следующего опроса
      await open("/settings/people", box, true);
      // полоса «нет связи» за всё время шага: страница сама отмечает, показывалась ли она
      await page.evaluate(() => {
        const seen = () => [...document.querySelectorAll(".main > .banner")].some((b) => b.textContent.includes("Нет связи с флотом"));
        window.__offline = seen();
        new MutationObserver(() => (window.__offline ||= seen())).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      for (const want of [true, false]) {
        // смена состава закрывает соединения страниц человека: барьер — страница открыла новое соединение картины и получила его первый кадр
        const fresh = { done: false };
        const met = (ws) => {
          if (!new URL(ws.url()).pathname.startsWith("/f/")) return;
          page.off("websocket", met);
          ws.once("framereceived", () => (fresh.done = true));
        };
        page.on("websocket", met);
        await box.click();
        await t.wait("страница снова на связи с новой картиной", () => fresh.done);
        await t.wait(`галочка ${want ? "стоит" : "снята"}`, async () => (await box.isChecked()) === want);
      }
      if (await page.evaluate(() => window.__offline)) throw new Error("полоса «нет связи» показалась");
    });
    if (!t.lacks("clickhouse")) await rest("ClickHouse — состояние в «Наблюдении»", async () => {
      await open("/observe/analytics", page.getByText(/^отвечает · /));
      await page.getByText("точек архива ждут долива").waitFor(); await shot("clickhouse");
    });
    await rest("чипы документа — под полем ввода", async () => {
      await open("/work/" + (await own()), page.locator(".composer-opts").getByRole("button", { name: "Режим" }));
      if (await page.locator(".conv-head").getByRole("button", { name: "Модель" }).count()) throw new Error("чипы остались в шапке");
      await shot("chips");
    });
    if (w > 860) await rest("вид списка — окошко, список меняется сразу", async () => {
      const look = page.getByRole("button", { name: "Вид списка" });
      await open("/work", look);
      await look.click();
      await page.getByLabel("Время").waitFor();
      if (/do=look/.test(page.url())) throw new Error("вид списка открылся страницей");
      await shot("look"); await look.click(); await page.getByLabel("Время").waitFor({ state: "hidden" });
    });
    await rest("клавиши — страница", async () => open("/keys", heading("Клавиши")));
  }
});
