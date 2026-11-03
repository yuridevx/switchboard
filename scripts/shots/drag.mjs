// Жесты настоящего кода в браузере: перестановка проектов и чипов мышью, пальцем и с клавиатуры, числа и снимки посреди жеста. npm run drag
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launch, OUT as ROOT, prepare, url } from "./stand.mjs";

const OUT = path.join(ROOT, "drag");
mkdirSync(OUT, { recursive: true });
await prepare();

let bad = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra !== "" ? " · " + extra : ""}`);
  if (!ok) bad++;
};
const rect = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }, sel);
const projects = (p) => p.evaluate(() => [...document.querySelectorAll(".lst > .pjs")].map((x) => x.dataset.proj));
const chips = (p) => p.evaluate(() => [...document.querySelectorAll(".fscroll > .fc")].map((x) => x.dataset.fid));
const values = (p) => p.evaluate(() => window.relay.values);
const record = (p) => p.evaluate(() => window.relay.scoped.global["fleet.projects"]);
const rowsOf = (p, id) => p.evaluate((x) => [...document.querySelectorAll(`.pjs[data-proj="${x}"] > .bd-row`)].map((r) => r.dataset.callsign), id);

  const b = await launch();

  // ───── проекты мышью, большой флот ─────
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(url("pult", "big", "#sessions"));
    await p.waitForSelector(".lst > .pjs");
    await p.waitForTimeout(300);
    const before = await projects(p);
    check("начальный порядок записи", before[0] === "switchboard" && before[1] === "pfarm", before.slice(0, 3).join(", "));
    const t = before[2];
    const g = await rect(p, `.grip[data-proj="${t}"]`);
    const hdr0 = await rect(p, `.pjs[data-proj="${t}"] > .pj .pj-t`);
    await p.mouse.move(g.x + 11, g.y + 14);
    await p.mouse.down();
    await p.mouse.move(g.x + 11, g.y + 15);
    await p.waitForTimeout(40);
    check("до порога жест не начат", !(await p.$(".dnd-card")));
    await p.mouse.move(g.x + 11, g.y + 21);
    await p.waitForTimeout(30);
    const card = await rect(p, ".dnd-card .pj-t");
    check("карточка — где схватили, от сдвига пальца", !!card && Math.abs(card.y - (hdr0.y + 7)) < 1, card ? `${(card.y - hdr0.y).toFixed(1)} px при сдвиге 7` : "нет");
    check("класс перестановки на корне", await p.evaluate(() => document.querySelector(".bd-list").classList.contains("reordering")));
    // перерисовка roster не ломает жест
    const lst0 = await p.evaluateHandle(() => document.querySelector(".lst"));
    await p.evaluate(() => window.relay.setRoster({ ...window.relay.roster }));
    await p.waitForTimeout(80);
    check("roster посреди жеста: список тот же", await p.evaluate((l) => l === document.querySelector(".lst"), lst0));
    // повели вверх, на самый верх
    const y0 = g.y + 21;
    for (let i = 1; i <= 16; i++) {
      await p.mouse.move(g.x + 11, y0 + ((await rect(p, '.pjs[data-proj="switchboard"] .pj')).y - 20 - y0) * (i / 16));
      await p.waitForTimeout(16);
    }
    await p.waitForTimeout(260);
    await p.screenshot({ path: path.join(OUT, "project-move.png") });
    await p.mouse.up();
    await p.waitForTimeout(320);
    const after = await projects(p);
    const saved = (await record(p)).map((r) => r.id);
    check("проект на месте броска, порядок в записи", after[0] === t && saved[0] === t, after.slice(0, 3).join(", "));
    check("класс снят и карточки нет", await p.evaluate(() => !document.querySelector(".dnd-card") && !document.querySelector(".reordering")));

    // нажатие без сдвига — меню проекта
    const gm = await rect(p, `.grip[data-proj="${t}"]`);
    await p.mouse.click(gm.x + 11, gm.y + 14);
    await p.waitForTimeout(120);
    check("нажатие на ⠿ — меню: имя и удаление", !!(await p.$(`[data-menu="${t}"] [data-f="project-name"]`)) && !!(await p.$('[data-act="project-remove"]')));
    await p.screenshot({ path: path.join(OUT, "project-menu.png") });
    await p.keyboard.press("Escape");
    await p.waitForTimeout(100);

    // автопрокрутка у нижнего края
    const sc0 = await p.evaluate(() => document.querySelector(".bd-body").scrollTop);
    const order0 = await projects(p);
    const g3 = await rect(p, `.grip[data-proj="${order0[0]}"]`);
    const body = await rect(p, ".bd-body");
    await p.mouse.move(g3.x + 11, g3.y + 14);
    await p.mouse.down();
    await p.mouse.move(g3.x + 11, g3.y + 30, { steps: 3 });
    await p.mouse.move(g3.x + 11, body.y + body.h - 10, { steps: 10 });
    await p.waitForTimeout(700);
    const sc1 = await p.evaluate(() => document.querySelector(".bd-body").scrollTop);
    check("у края список едет", sc1 > sc0 + 100, `${sc0} → ${Math.round(sc1)} px`);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(320);
    check("Escape — порядок прежний", JSON.stringify(await projects(p)) === JSON.stringify(order0));
    await p.mouse.up();

    // заголовки липнут только внутри своего раздела
    for (const y of [240, 600, 1100]) {
      await p.evaluate((v) => (document.querySelector(".bd-body").scrollTop = v), y);
      await p.waitForTimeout(60);
      const stuck = await p.evaluate(() => {
        const top = document.querySelector(".bd-body").getBoundingClientRect().top;
        return [...document.querySelectorAll(".pj")].filter((h) => Math.abs(h.getBoundingClientRect().top - top) < 3).length;
      });
      check(`прокрутка ${y}: у верхнего края не больше одного заголовка`, stuck <= 1, stuck);
    }
    // стрелки на ручке и видимый фокус
    await p.evaluate(() => document.querySelector(".bd-body").scrollTo(0, 0));
    await p.focus('.grip[data-proj="pfarm"]');
    const i0 = (await projects(p)).indexOf("pfarm");
    await p.keyboard.press("ArrowUp");
    await p.waitForTimeout(280);
    check("стрелка вверх на ручке", (await projects(p)).indexOf("pfarm") === i0 - 1);
    check("фокус на ручке", await p.evaluate(() => document.activeElement?.dataset?.proj === "pfarm"));
    check("ошибок страницы нет", errs.length === 0, errs.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ───── строки мышью ─────
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(url("pult", "small", "#sessions"));
    await p.waitForSelector(".bd-row");
    await p.waitForTimeout(300);
    const dragRow = async (from, toY, mid) => {
      const r = await rect(p, `[data-callsign="${from}"]`);
      await p.mouse.move(r.x + 60, r.y + r.h / 2);
      await p.mouse.down();
      await p.mouse.move(r.x + 60, r.y + r.h / 2 + 8, { steps: 2 });
      await p.mouse.move(r.x + 60, toY, { steps: 12 });
      await p.waitForTimeout(60);
      if (mid) await mid();
      await p.mouse.up();
      await p.waitForTimeout(150);
    };
    const hash0 = await p.evaluate(() => location.hash);
    const before = await rowsOf(p, "pfarm");
    const top = await rect(p, `[data-callsign="${before[0]}"]`);
    await dragRow(before[2], top.y + 4, async () => {
      check("строка поднята, линия показывает место", !!(await p.$(".dnd-row-card")) && !!(await p.$(".dnd-row-line")));
      await p.screenshot({ path: path.join(OUT, "row-move.png") });
    });
    check("строка выше соседа: на месте броска", (await rowsOf(p, "pfarm"))[0] === before[2], (await rowsOf(p, "pfarm")).join(", "));
    check("порядок в записи", (await record(p)).find((x) => x.id === "pfarm").sessions[0] === before[2]);
    check("клик после жеста сессию не открывает", (await p.evaluate(() => location.hash)) === hash0);
    check("следов жеста нет", await p.evaluate(() => !document.querySelector(".dnd-row-card, .dnd-row-line, .dnd-row-out, .reordering")));

    // смена состояния ничего не двигает
    const r0 = await rowsOf(p, "pfarm");
    await p.evaluate((cs) => window.relay.setRoster({ ...window.relay.roster, sessions: window.relay.roster.sessions.map((x) => (x.callsign === cs ? { ...x, state: "waiting" } : x)) }), r0[2]);
    await p.waitForTimeout(100);
    check("смена состояния: порядок тот же", JSON.stringify(await rowsOf(p, "pfarm")) === JSON.stringify(r0));

    // родитель едет блоком в другой проект
    const dest = await rect(p, `[data-callsign="${r0[1]}"]`);
    await dragRow("refactor@win", dest.y + 4);
    const pf = await rowsOf(p, "pfarm");
    check("родитель в другом проекте, дочерние под ним", pf.indexOf("refactor@win") >= 0 && pf[pf.indexOf("refactor@win") + 1] === "review@wsl" && pf[pf.indexOf("refactor@win") + 2] === "tests@wsl", pf.join(", "));

    // на свёрнутый проект: в его конец
    const none = await rect(p, '.pjs[data-proj="~"] > .pj');
    await dragRow(pf[0], none.y + 10);
    const rec = await record(p);
    check("брошена на свёрнутый проект — в его записи", rec.find((x) => x.id === "~")?.sessions.includes(pf[0]) && !rec.find((x) => x.id === "pfarm").sessions.includes(pf[0]));

    // Escape: всё на месте
    const r2 = await rowsOf(p, "pfarm");
    const rr = await rect(p, `[data-callsign="${r2[1]}"]`);
    await p.mouse.move(rr.x + 60, rr.y + 10);
    await p.mouse.down();
    await p.mouse.move(rr.x + 60, rr.y + 60, { steps: 5 });
    await p.keyboard.press("Escape");
    await p.mouse.up();
    await p.waitForTimeout(100);
    check("Escape: порядок строк прежний", JSON.stringify(await rowsOf(p, "pfarm")) === JSON.stringify(r2));

    // обычный клик открывает
    await p.click(`[data-callsign="${r2[0]}"]`);
    await p.waitForTimeout(100);
    check("обычный клик открывает сессию", (await p.evaluate(() => location.hash)).startsWith("#card"));
    check("ошибок страницы нет", errs.length === 0, errs.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ───── чипы мышью ─────
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(url("pult", "big", "#sessions"));
    await p.waitForSelector(".fscroll .fc");
    await p.waitForTimeout(300);
    const r0 = await chips(p);
    const c = await rect(p, '.fc[data-fid="all"]');
    const m = await rect(p, '.fc[data-fid="mine"]');
    await p.mouse.move(c.x + c.w / 2, c.y + c.h / 2);
    await p.mouse.down();
    await p.mouse.move(c.x + c.w / 2 - 10, c.y + c.h / 2, { steps: 2 });
    await p.waitForTimeout(40);
    const gh = await rect(p, ".fc-ghost");
    check("призрак поднят от пальца", !!gh);
    await p.mouse.move(m.x + 8, c.y + c.h / 2, { steps: 8 });
    await p.waitForTimeout(240);
    await p.screenshot({ path: path.join(OUT, "chip-drag.png") });
    await p.mouse.up();
    await p.waitForTimeout(280);
    const r1 = await chips(p);
    check("чип встал на новое место", r1[0] === "all" && r1[1] === "mine", r1.join(", "));
    check("выбранный не сменился", await p.evaluate(() => document.querySelector('.fc[aria-selected="true"]').dataset.fid === "mine"));
    check("порядок у почты", JSON.stringify((await values(p))["web-board.row"]) === JSON.stringify(r1));
    check("призрака нет", !(await p.$(".fc-ghost")));
    // обычный клик выбирает
    await p.click('.fc[data-fid="all"]');
    await p.waitForTimeout(80);
    check("клик по чипу выбирает", await p.evaluate(() => document.querySelector('.fc[aria-selected="true"]').dataset.fid === "all"));
    // Escape
    const c2 = await rect(p, '.fc[data-fid="mine"]');
    await p.mouse.move(c2.x + c2.w / 2, c2.y + c2.h / 2);
    await p.mouse.down();
    await p.mouse.move(c2.x - 40, c2.y + c2.h / 2, { steps: 5 });
    await p.keyboard.press("Escape");
    await p.waitForTimeout(280);
    await p.mouse.up();
    await p.waitForTimeout(60);
    check("Escape: порядок и выбор прежние", JSON.stringify(await chips(p)) === JSON.stringify(r1) && (await p.evaluate(() => document.querySelector('.fc[aria-selected="true"]').dataset.fid === "all")));
    // Alt+стрелка
    await p.focus('.fc[data-fid="all"]');
    await p.keyboard.press("Alt+ArrowRight");
    await p.waitForTimeout(240);
    check("Alt+стрелка", (await chips(p))[1] === "all", (await chips(p)).join(", "));
    check("ошибок страницы нет", errs.length === 0, errs.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ───── палец: телефон ─────
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(url("phone", "big", "#sessions"));
    await p.waitForSelector(".lst > .pjs");
    await p.waitForTimeout(300);
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const before = await projects(p);
    const t = before[2];
    const g = await rect(p, `.grip[data-proj="${t}"]`);
    await touch("touchStart", g.x + 11, g.y + 14);
    await p.waitForTimeout(30);
    for (let i = 1; i <= 12; i++) {
      await touch("touchMove", g.x + 11, g.y + 14 - (g.y - 150) * (i / 12));
      await p.waitForTimeout(16);
    }
    await p.waitForTimeout(260);
    await p.screenshot({ path: path.join(OUT, "phone-project.png") });
    check("палец тянет ручку", !!(await p.$(".dnd-card")));
    await touch("touchEnd");
    await p.waitForTimeout(320);
    const after = await projects(p);
    check("палец: проект переставлен", after.indexOf(t) < before.indexOf(t) && (await record(p)).findIndex((x) => x.id === t) < before.indexOf(t), after.slice(0, 3).join(", "));

    // строка: удержание поднимает, ведение раньше — прокрутка
    await p.evaluate(() => document.querySelector(".bd-body").scrollTo(0, 0));
    const open = await p.evaluate(() => {
      const h = [...document.querySelectorAll(".pjs")].find((x) => x.querySelectorAll(":scope > .bd-row").length >= 2);
      return h ? h.dataset.proj : null;
    });
    if (!open) await p.click(".pj-t");
    await p.waitForTimeout(100);
    const fid = open ?? (await p.evaluate(() => document.querySelector(".pjs:has(> .bd-row)").dataset.proj));
    const rr0 = await rowsOf(p, fid);
    const r1 = await rect(p, `[data-callsign="${rr0[1]}"]`);
    await touch("touchStart", r1.x + 60, r1.y + 12);
    for (let i = 1; i <= 4; i++) {
      await touch("touchMove", r1.x + 60, r1.y + 12 - i * 8);
      await p.waitForTimeout(16);
    }
    check("палец повёл сразу — строка не поднята", !(await p.$(".dnd-row-card")));
    await touch("touchEnd");
    await p.waitForTimeout(100);
    await p.evaluate(() => document.querySelector(".bd-body").scrollTo(0, 0));
    const r1b = await rect(p, `[data-callsign="${rr0[1]}"]`);
    const r0b = await rect(p, `[data-callsign="${rr0[0]}"]`);
    const hashR = await p.evaluate(() => location.hash);
    await touch("touchStart", r1b.x + 60, r1b.y + 12);
    await p.waitForTimeout(360);
    check("палец: удержание поднимает строку", !!(await p.$(".dnd-row-card")));
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", r1b.x + 60, r1b.y + 12 + ((r0b.y + 4 - (r1b.y + 12)) * i) / 8);
      await p.waitForTimeout(16);
    }
    await p.screenshot({ path: path.join(OUT, "phone-row.png") });
    await touch("touchEnd");
    await p.waitForTimeout(200);
    check("палец: строка на месте броска", (await rowsOf(p, fid))[0] === rr0[1], (await rowsOf(p, fid)).slice(0, 3).join(", "));
    check("палец: сессия не открылась", (await p.evaluate(() => location.hash)) === hashR);

    // чип: ведение — прокрутка ряда, чип не тронут
    const r0 = await chips(p);
    const c = await rect(p, '.fc[data-fid="f1"]');
    await touch("touchStart", c.x + c.w / 2, c.y + c.h / 2);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", c.x + c.w / 2 - i * 12, c.y + c.h / 2);
      await p.waitForTimeout(16);
    }
    await touch("touchEnd");
    await p.waitForTimeout(300);
    check("палец повёл — ряд прокрутился, порядок прежний", JSON.stringify(await chips(p)) === JSON.stringify(r0), `прокрутка ${await p.evaluate(() => document.querySelector(".fscroll").scrollLeft)} px`);
    await p.evaluate(() => (document.querySelector(".fscroll").scrollLeft = 0));

    // удержание 300 мс — поднят, потом ведётся
    const c2 = await rect(p, '.fc[data-fid="all"]');
    const m2 = await rect(p, '.fc[data-fid="mine"]');
    await touch("touchStart", c2.x + c2.w / 2, c2.y + c2.h / 2);
    await p.waitForTimeout(360);
    check("удержание поднимает чип", !!(await p.$(".fc-ghost")));
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", c2.x + c2.w / 2 + ((m2.x + 8 - (c2.x + c2.w / 2)) * i) / 8, c2.y + c2.h / 2);
      await p.waitForTimeout(16);
    }
    await p.waitForTimeout(240);
    await p.screenshot({ path: path.join(OUT, "phone-chip.png") });
    await touch("touchEnd");
    await p.waitForTimeout(280);
    check("палец: чип переставлен", (await chips(p))[0] === "all", (await chips(p)).join(", "));
    check("ошибок страницы нет", errs.length === 0, errs.slice(0, 2).join(" | "));
    await ctx.close();
  }
  await b.close();
  console.log(bad ? `не прошло: ${bad}` : "всё прошло");
  process.exit(bad ? 1 : 0);
