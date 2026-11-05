// Страница стенда без настоящего флота: наложение комментариев над простым экраном. Для STAND_CHECK=fake npm run stand:check и тестов: наложение о странице не знает.
import { startComments } from "./comments.ts";

const app = new URLSearchParams(location.search).get("app") === "phone" ? "phone" : "pult";
const root = document.getElementById("app")!;
const events = new EventSource("/events");
events.addEventListener("reload", () => location.reload());

const pass = () => localStorage.getItem("stand-pass");

function draw() {
  const invite = /^#invite=(.+)$/.exec(location.hash);
  if (invite) {
    localStorage.setItem("stand-pass", invite[1]);
    history.replaceState(null, "", location.pathname + location.search + "#sessions");
  }
  if (!pass()) {
    root.innerHTML = '<p>Нужен пропуск</p><input class="sb-keyin">';
    return;
  }
  const screen = location.hash.startsWith("#machines") ? "machines" : location.hash.startsWith("#card") ? "card" : "board";
  root.innerHTML =
    screen === "board"
      ? '<div data-screen="board" data-module="web-board"><a class="bd-row" data-callsign="a@pc" style="display:block;padding:12px">a@pc</a><a class="bd-row" data-callsign="b@pc" style="display:block;padding:12px">b@pc</a></div>'
      : `<div data-screen="${screen}" data-module="pult-${screen}"><h2>${screen}</h2></div>`;
  for (const row of root.querySelectorAll<HTMLElement>(".bd-row")) row.onclick = () => (location.hash = `#card?callsign=${encodeURIComponent(row.dataset.callsign!)}`);
}

addEventListener("hashchange", draw);
// как поиск настоящей страницы: Ctrl K открывает поле, Esc закрывает
addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "k") {
    e.preventDefault();
    const q = document.createElement("input");
    q.className = "sb-palin";
    root.append(q);
    q.focus();
  }
  if (e.key === "Escape") root.querySelector(".sb-palin")?.remove();
});

void (async () => {
  const f = (await (await fetch("/fleet.json")).json()) as { fleet: string };
  draw();
  startComments({ app, kind: f.fleet, events });
})();
