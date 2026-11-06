// Снимки экранов настоящего кода: npm run shots [часть имени]; SHOTS_DOM=<файл> — ещё и деревья DOM. Замечания — выход за край и ошибки страницы.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { snap, treeOf } from "./kit.mjs";
import { launch, OUT as ROOT, prepare, url } from "./stand.mjs";

const OUT = path.join(ROOT, "shots");
const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 780 };
const filter = process.argv[2] ?? "";

const click = (sel) => (p) => p.click(sel);
const steps = (...all) => async (p) => {
  for (const step of all) {
    await step(p);
    await p.waitForTimeout(200);
  }
};
const row = click(".bd-row");
const place = click(".pj-add");
const path_ = (p) => p.fill('[data-f="addr"]', "~/projects/new/deep");

/** Снимок: имя, адрес, что сделать; only — только на этом флоте. */
const OPEN = [
  ["new", "#sessions", steps(click("[data-new]"))],
  ["new-place", "#sessions", steps(place)],
  ["new-pair", "#sessions", steps(click("[data-new]"), click('button[data-pair]'))],
];
const ACCOUNTS = (prefix) => [
  [`${prefix}accounts`, "#accounts"],
  [`${prefix}accounts-login`, "#accounts", steps(click("[data-login-start]"))],
  [`${prefix}accounts-entry`, "#accounts", steps(click('[data-entry$=":night@x.io"]'))],
  [`${prefix}accounts-diff`, "#accounts", steps(click(".ac-warn"))],
  [`${prefix}accounts-machine`, "#accounts", steps(click(".ac-mname"))],
  [`${prefix}accounts-keys`, "#accounts", steps(click('[data-tab="keys"]'))],
  [`${prefix}accounts-key-new`, "#accounts", steps(click('[data-tab="keys"]'), click('[data-act="key-new"]'))],
  [`${prefix}profiles`, "#profiles"],
  [`${prefix}profiles-prompt`, "#profiles", steps(click('[data-piece="team/profiles/dev"]'), click('[data-tab="prompt"]'))],
  [`${prefix}profiles-skills`, "#profiles", steps(click('[data-piece="team/profiles/dev"]'), click('[data-tab="skills"]'))],
  [`${prefix}profiles-memory`, "#profiles", steps(click('[data-piece="team/profiles/dev"]'), click('[data-tab="mem"]'))],
  [`${prefix}profiles-settings`, "#profiles", steps(click('[data-piece="team/profiles/dev"]'), click('[data-tab="set"]'))],
];
const BOTH = [
  ["work", "#sessions"],
  ["view", "#sessions", steps(click(".fc.vw"))],
  ["filter-new", "#sessions", steps(click(".fc.add"))],
];
const PULT_SCREENS = [
  ...BOTH,
  ["work-card", "#sessions", steps(row)],
  ...OPEN,
  ["new-path", "#sessions", steps(place, path_)],
  ...ACCOUNTS(""),
  ["names", "#sessions", steps(row, click('[data-act="names"]')), "small"],
  ["card-settings", "#sessions", steps(row, click('[data-tab="set"]')), "small"],
  ["card-log", "#sessions", steps(row, click('[data-tab="log"]')), "small"],
  ["card-info", "#sessions", steps(row, click('[data-tab="info"]')), "small"],
  ["inbox", "#inbox", null, "small"],
  ["incidents", "#incidents", null, "small"],
  ["journal", "#journal", null, "small"],
  ["points", "#points", null, "small"],
  ["settings", "#settings", null, "small"],
  ["settings-passes", "#settings", steps(click('[data-tab="passes"]')), "small"],
  ["settings-general", "#settings", steps(click('[data-tab="general"]')), "small"],
];
const PHONE_SCREENS = [
  ...BOTH,
  ["find", "#sessions", steps(click(".sb-find"))],
  ...OPEN,
  ["new-machines", "#sessions", steps(click("[data-new]"), click('[data-act="pick-machine"]'))],
  ["new-path-m", "#sessions", steps(place, path_)],
  ...ACCOUNTS("fleet-"),
  ["card", "#sessions", steps(row), "small"],
  ["card-more", "#sessions", steps(row, click('[data-tab="info"]')), "small"],
  ["ask", `#ask?callsign=${encodeURIComponent("migrate@win")}`, null, "small"],
  ["names", "#sessions", steps(row, click('[data-tab="info"]'), click('[data-act="names"]')), "small"],
  ["inbox", "#inbox", null, "small"],
  ["fleet-incidents", "#incidents", null, "small"],
  ["fleet-settings", "#settings", null, "small"],
];

mkdirSync(OUT, { recursive: true });
await prepare();
const browser = await launch();
const notes = [];
const trees = {};

async function shot(app, kind, scheme, [name, hash, act, only]) {
  const id = `${app}-${kind}-${scheme}-${name}`;
  if ((only && only !== kind) || !id.includes(filter)) return;
  const open = async (p) => {
    await p.goto(url(app, kind, "#sessions"));
    await p.waitForSelector(".bd-list");
    await p.waitForFunction(() => window.delivered);
    await p.evaluate((h) => (location.hash = h), hash);
    await p.waitForTimeout(400);
    await act?.(p);
    await p.waitForTimeout(150);
  };
  const after = async (p) => void (trees[id] = await treeOf(p));
  await snap(browser, { id, app, viewport: app === "pult" ? WIDE : NARROW, scheme, dir: OUT, scope: "#app *", allowed: ".fscroll, .op-pre, .sb-navrow, .cw-tabs", open, after }, notes);
}

for (const [app, screens] of [["pult", PULT_SCREENS], ["phone", PHONE_SCREENS]]) {
  for (const [kind, scheme] of [["small", "light"], ["small", "dark"], ["big", "light"]]) {
    for (const screen of screens) await shot(app, kind, scheme, screen);
  }
}
await browser.close();
if (process.env.SHOTS_DOM) writeFileSync(process.env.SHOTS_DOM, JSON.stringify(trees));
console.log(notes.length ? notes.join("\n") : `без замечаний · снимки в ${OUT}`);
process.exit(notes.length ? 1 : 0);
