// Проверка страницы дизайна перед публикацией: node docs/designs/account-priority/check.mjs
// Страница поднимается в happy-dom со своими скриптами: id не повторяются, у каждого нажимаемого узла и стрелки есть пояснение,
// исход каждого эталона совпал с объявленным, рычаги и модель на первом рисунке меняют выбор, метка «прочитал» ставится клавишей A.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { Window } = createRequire(path.join(here, "../../../web/package.json"))("happy-dom");
const html = fs.readFileSync(path.join(here, "index.html"), "utf8");
// скрипты страницы happy-dom сам не исполняет: включаем явно
const window = new Window({ url: "https://design.local/", settings: { enableJavaScriptEvaluation: true, suppressCodeGenerationFromStringsWarning: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
const { document } = window;
const errors = [];
window.addEventListener("error", (e) => errors.push(String(e.message ?? e.error)));
document.write(`<!doctype html><html><head></head><body>${html}</body></html>`);
await window.happyDOM.waitUntilComplete();

const bad = [];
const check = (name, ok, more = "") => { console.log(`${ok ? "✓" : "✗"} ${name}${more ? " · " + more : ""}`); if (!ok) bad.push(name); };

const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
check("id не повторяются", !twice.length, twice.length ? twice.join(", ") : `${ids.length} id`);
check("скрипты страницы отработали без ошибок", !errors.length, errors.join(" | "));

const nodes = [...document.querySelectorAll("[data-i]")];
const mute = nodes.filter((el) => {
  const say = el.closest("section").querySelector(".say");
  say.innerHTML = "";
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return !say.textContent.trim();
});
check("у каждого узла, стрелки и рамки есть пояснение", nodes.length > 0 && !mute.length, mute.length ? mute.map((e) => e.getAttribute("data-i")).join(", ") : `${nodes.length} из ${nodes.length}`);

const tiles = [...document.querySelectorAll("#ets .et")];
const wrong = tiles.filter((t) => t.getAttribute("data-ok") !== "true").map((t) => t.querySelector("h3").textContent);
check("исход каждого эталона совпал с объявленным", tiles.length === 11 && !wrong.length, wrong.length ? wrong.join(" | ") : `${tiles.length} из ${tiles.length}`);

const sim = document.getElementById("sim"), simSay = document.getElementById("sim-say");
const press = (sel) => sim.querySelector(sel).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const best = () => sim.querySelector(".acc.best")?.getAttribute("data-sim") ?? null;
const first = best();
press('[data-lever="night:auto"]');
const byScore = best();
press('[data-lever="yuri:off"]');
const afterOff = best();
press('[data-model="true"]');
const fable = best();
for (const a of ["anya", "ops", "yuri", "night", "work"]) press(`[data-lever="${a}:off"]`);
const none = best();
check("рычаги и модель меняют выбор", first === "night" && byScore === "yuri" && afterOff !== "yuri" && afterOff !== null && fable === "anya" && none === null && /ждёт сброса/.test(simSay.textContent), `первым → ${first}; по счёту → ${byScore}; yuri выключен → ${afterOff}; Fable → ${fable}; все выключены → ${none}`);

const block = document.querySelector("[data-block]");
block.dispatchEvent(new window.MouseEvent("mouseenter"));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ф", code: "KeyA" }));
check("метка «прочитал» ставится клавишей A в русской раскладке", block.classList.contains("read"));
check("скрипт меток — последний", /account-priority\.read/.test([...document.querySelectorAll("script")].at(-1).textContent));

await window.happyDOM.close();
console.log(`\n${bad.length ? "не прошло: " + bad.length : "страница готова"}`);
process.exit(bad.length ? 1 : 0);
