// Обход экранов настоящего кода снимками: пульт и телефон, светлая и тёмная; замечания — выход за край и ошибки страницы. npm run shots [часть имени снимка]; снимки смотрит глазами тот, кто запустил.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launch, OUT as ROOT, prepare, url } from "./stand.mjs";

const OUT = path.join(ROOT, "shots");
mkdirSync(OUT, { recursive: true });
await prepare();

const filter = process.argv[2] || "";

const pause = (p, ms = 200) => p.waitForTimeout(ms);
async function go(p, hash) {
  await p.evaluate((h) => (location.hash = h), hash);
  await pause(p);
}

const PULT = [
  ["work", async () => {}],
  ["work-card", async (p) => { await p.click('.bd-row[data-callsign]'); await pause(p); }],
  ["view", async (p) => { await p.click(".fc.vw"); await pause(p); }],
  ["filter-new", async (p) => { await p.click(".fc.add"); await pause(p); }],
  ["names", async (p) => { await p.click(".bd-row[data-callsign]"); await pause(p); await p.click('[data-act="names"]'); await pause(p); }],
  ["card-settings", async (p) => { await p.click(".bd-row[data-callsign]"); await pause(p); await p.click('.cw-tabs [data-tab="set"]'); await pause(p); }],
  ["card-log", async (p) => { await p.click(".bd-row[data-callsign]"); await pause(p); await p.click('.cw-tabs [data-tab="log"]'); await pause(p); }],
  ["new", async (p) => { await p.click("[data-new]"); await pause(p); }],
  ["new-place", async (p) => { await p.click(".pj-add"); await pause(p, 300); }],
  ["new-prof", async (p) => { await p.click(".pj-add"); await pause(p, 300); await p.click('[data-pop="prof"]'); await pause(p); }],
  ["new-model", async (p) => { await p.click(".pj-add"); await pause(p, 300); await p.click('[data-pop="model"]'); await pause(p); }],
  ["new-path", async (p) => { await p.click(".pj-add"); await pause(p, 300); await p.fill('[data-f="addr"]', "~/projects/new/deep"); await pause(p, 300); }],
  ["inbox", async (p) => { await go(p, "#inbox"); }],
  ["incidents", async (p) => { await go(p, "#incidents"); }],
  ["machines", async (p) => { await go(p, "#machines"); await pause(p, 300); }],
  ["machines-open", async (p) => { await go(p, "#machines"); await pause(p, 300); await p.click("[data-row] .mc-head"); await pause(p); }],
  ["accounts", async (p) => { await go(p, "#accounts"); await pause(p, 300); }],
  ["profiles", async (p) => { await go(p, "#profiles"); await pause(p, 400); }],
  ["profiles-open", async (p) => { await go(p, "#profiles"); await pause(p, 400); await p.click(".pf-w.cf .pf-r"); await pause(p); }],
  ["journal", async (p) => { await go(p, "#journal"); await pause(p, 300); }],
  ["points", async (p) => { await go(p, "#points"); await pause(p, 300); }],
  ["settings", async (p) => { await go(p, "#settings"); await pause(p, 300); }],
  ["settings-passes", async (p) => { await go(p, "#settings?tab=passes"); await pause(p, 300); }],
  ["settings-general", async (p) => { await go(p, "#settings?tab=general"); await pause(p, 300); }],
];
const PHONE = [
  ["work", async (p) => { await go(p, "#sessions"); }],
  ["card", async (p) => { await go(p, "#sessions"); await p.click(".bd-row:not(:has(.sb-badge.wait))"); await pause(p); }],
  ["card-more", async (p) => { await go(p, "#sessions"); await p.click(".bd-row:not(:has(.sb-badge.wait))"); await pause(p); await p.click('[data-tab="info"]'); await pause(p); }],
  ["ask", async (p) => { await go(p, "#sessions"); await p.click(".bd-row:has(.sb-badge.wait)"); await pause(p, 300); }],
  ["view", async (p) => { await go(p, "#sessions"); await p.click(".fc.vw"); await pause(p); }],
  ["filter-new", async (p) => { await go(p, "#sessions"); await p.click(".fc.add"); await pause(p); }],
  ["find", async (p) => { await go(p, "#sessions"); await p.click("[data-find]"); await pause(p); }],
  ["names", async (p) => { await go(p, "#sessions"); await p.click(".bd-row:not(:has(.sb-badge.wait))"); await pause(p); await p.click('[data-tab="info"]'); await pause(p); await p.click('[data-act="names"]'); await pause(p); }],
  ["new", async (p) => { await go(p, "#sessions"); await p.click("[data-new]"); await pause(p); }],
  ["new-place", async (p) => { await go(p, "#sessions"); await p.click(".pj-add"); await pause(p, 300); }],
  ["new-prof", async (p) => { await go(p, "#sessions"); await p.click(".pj-add"); await pause(p, 300); await p.click('[data-pop="prof"]'); await pause(p); }],
  ["new-model", async (p) => { await go(p, "#sessions"); await p.click(".pj-add"); await pause(p, 300); await p.click('[data-pop="model"]'); await pause(p); }],
  ["new-machines", async (p) => { await go(p, "#sessions"); await p.click("[data-new]"); await pause(p); await p.click('[data-act="pick-machine"]'); await pause(p, 300); }],
  ["new-path-m", async (p) => { await go(p, "#sessions"); await p.click(".pj-add"); await pause(p, 300); await p.fill('[data-f="addr"]', "~/projects/new/deep"); await pause(p, 300); }],
  ["inbox", async (p) => { await go(p, "#inbox"); }],
  ["fleet-machines", async (p) => { await go(p, "#machines"); await pause(p, 300); }],
  ["fleet-accounts", async (p) => { await go(p, "#accounts"); await pause(p, 300); }],
  ["fleet-profiles", async (p) => { await go(p, "#profiles"); await pause(p, 400); }],
  ["fleet-profiles-open", async (p) => { await go(p, "#profiles"); await pause(p, 400); await p.click(".pf-w.cf .pf-r"); await pause(p); }],
  ["fleet-incidents", async (p) => { await go(p, "#incidents"); }],
  ["fleet-settings", async (p) => { await go(p, "#settings"); await pause(p, 300); }],
];

  const b = await launch();
  const fails = [];
  for (const [app, list, viewport] of [["pult", PULT, { width: 1280, height: 800 }], ["phone", PHONE, { width: 390, height: 780 }]]) {
    for (const kind of ["small", "big"]) {
      for (const scheme of ["light", "dark"]) {
        // тёмная — только малый флот: цвета те же
        if (scheme === "dark" && kind === "big") continue;
        for (const [name, act] of list) {
          const id = `${app}-${kind}-${scheme}-${name}`;
          if (filter && !id.includes(filter)) continue;
          // большой флот — только там, где длина важна
          if (kind === "big" && !/^(work|view|filter-new|new|profiles|fleet-profiles|find|machines|fleet-machines)/.test(name)) continue;
          const ctx = await b.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: app === "phone" ? 2 : 1, hasTouch: app === "phone", isMobile: app === "phone" });
          const p = await ctx.newPage();
          const errs = [];
          p.on("pageerror", (e) => errs.push(e.message));
          p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
          try {
            await p.goto(url(app, kind, app === "pult" ? "#sessions" : "#sessions"));
            await p.waitForSelector(".bd-list .fbar .fc", { timeout: 4000 });
            await pause(p, 250);
            await act(p);
            await p.screenshot({ path: path.join(OUT, id + ".png") });
            const over = await p.evaluate(() => {
              const de = document.documentElement;
              const x = de.scrollWidth - de.clientWidth;
              const bad = [...document.querySelectorAll("body *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && getComputedStyle(e).position !== "fixed" && !e.closest(".fscroll, .op-pre, .sb-navrow, .cw-tabs"); }).slice(0, 4).map((e) => e.className || e.tagName);
              return { x, bad };
            });
            if (over.x > 0 || over.bad.length) fails.push(`${id}: выход за край ${over.x}px ${over.bad.join(" | ")}`);
          } catch (e) {
            fails.push(`${id}: ${e.message.split("\n")[0]}`);
          }
          if (errs.length) fails.push(`${id}: ошибки ${errs.slice(0, 2).join(" | ").slice(0, 200)}`);
          await ctx.close();
        }
      }
    }
  }
  await b.close();
  console.log(fails.length ? fails.join("\n") : `без замечаний · снимки в ${OUT}`);
  process.exit(fails.length ? 1 : 0);
