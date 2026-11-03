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
    check("закреплённые сверху", before[0] === "switchboard" && before[1] === "pfarm", before.slice(0, 3).join(", "));
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
    // повели вверх, к закреплённым
    const y0 = g.y + 21;
    for (let i = 1; i <= 16; i++) {
      await p.mouse.move(g.x + 11, y0 + ((await rect(p, '.grip[data-proj="switchboard"]')).y + 60 - y0) * (i / 16));
      await p.waitForTimeout(16);
    }
    await p.waitForTimeout(260);
    await p.screenshot({ path: path.join(OUT, "project-pin.png") });
    const pinZone = await p.evaluate(() => document.querySelector(".dnd-card").classList.contains("dnd-pin"));
    check("зона закрепления подсвечена", pinZone);
    await p.mouse.up();
    await p.waitForTimeout(320);
    const after = await projects(p);
    const top = (await values(p))["web-board.top"];
    check("проект закреплён на месте броска", after.indexOf(t) < 3 && top.includes(t), `${after.slice(0, 4).join(", ")} · top ${JSON.stringify(top)}`);
    check("класс снят и карточки нет", await p.evaluate(() => !document.querySelector(".dnd-card") && !document.querySelector(".reordering")));

    // открепить: бросить ниже черты
    const g2 = await rect(p, `.grip[data-proj="${t}"]`);
    await p.mouse.move(g2.x + 11, g2.y + 14);
    await p.mouse.down();
    await p.mouse.move(g2.x + 11, g2.y + 30, { steps: 3 });
    await p.mouse.move(g2.x + 11, g2.y + 500, { steps: 16 });
    await p.waitForTimeout(240);
    await p.screenshot({ path: path.join(OUT, "project-unpin.png") });
    await p.mouse.up();
    await p.waitForTimeout(320);
    check("брошен ниже черты — откреплён", !(await values(p))["web-board.top"].includes(t));

    // автопрокрутка у нижнего края
    const sc0 = await p.evaluate(() => document.querySelector(".bd-body").scrollTop);
    const g3 = await rect(p, '.grip[data-proj="switchboard"]');
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
    check("Escape — порядок прежний", (await projects(p))[0] === "switchboard");
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
    await p.keyboard.press("ArrowUp");
    await p.waitForTimeout(280);
    check("стрелка вверх на ручке", (await projects(p))[0] === "pfarm");
    check("фокус на ручке", await p.evaluate(() => document.activeElement?.dataset?.proj === "pfarm"));
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
    check("палец: проект закреплён", after.indexOf(t) < 2 && (await values(p))["web-board.top"].includes(t), after.slice(0, 3).join(", "));

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
