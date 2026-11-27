// Панель сайта флота. Сервер добавляет этот скрипт в каждую страницу сайта и ставит перед ним window.sbSite — настройки сайта.
// Всегда: sb.db(sql, ...params) — запрос к базе своего сайта. Если включено: комментарии к элементам страницы (клавиша C),
// «просмотрено» у блоков (клавиша A) и отправка всех комментариев одним тикетом. Комментарии и метки — строки той же базы.
(() => {
  const SB = window.sbSite ?? { name: "", comments: false, marks: false };
  const post = async (path, body) => {
    const r = await fetch(path, { method: "POST", body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) throw new Error(j.why ?? j.error);
    return j;
  };
  /** Запрос SQL к базе сайта; ответ — строки. */
  const db = async (sql, ...params) => (await post("/_sb/db", { sql, params })).rows;
  window.sb = { db, site: SB };
  if (!SB.comments && !SB.marks) return;

  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  const style = el("style");
  style.textContent = `
:root { --sb-bg: #fff; --sb-fg: #1c211f; --sb-line: #d9d8d0; --sb-soft: #eceae3; --sb-muted: #66706b; --sb-new: #fff3b0; --sb-pin: #f2b705; --sb-go: #1f7a63; }
@media (prefers-color-scheme: dark) { :root { --sb-bg: #1d2320; --sb-fg: #e8ece9; --sb-line: #343c38; --sb-soft: #252c28; --sb-muted: #98a39d; --sb-new: #4a4318; --sb-go: #5fc3a6; } }
[data-block].sb-new { background-color: var(--sb-new) !important; }
[data-block] [data-chg], [data-block][data-chg]:not(.sb-new) { background-color: transparent !important; }
body.sb-c, body.sb-c * { cursor: crosshair !important; }
.sb-hot { outline: 2px solid var(--sb-pin) !important; outline-offset: 2px; }
#sb-kit { position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483000; font: 14px/1.4 system-ui, sans-serif; color: var(--sb-fg); }
#sb-kit button { font: inherit; cursor: pointer; }
.sb-pin { position: absolute; width: 28px; height: 28px; transform: translate(-8px, calc(-100% + 8px)); border-radius: 50% 50% 50% 3px; border: 2px solid var(--sb-bg); background: var(--sb-pin); color: #1c211f; font-weight: 600; font-size: 13px; padding: 0; box-shadow: 0 1px 4px rgb(0 0 0 / .3); }
.sb-pin.sb-sent { background: var(--sb-muted); color: var(--sb-bg); }
.sb-pop { position: absolute; width: min(300px, calc(100vw - 16px)); box-sizing: border-box; background: var(--sb-bg); border: 1px solid var(--sb-line); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; gap: 6px; box-shadow: 0 6px 24px rgb(0 0 0 / .25); }
.sb-pop p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.sb-pop .sb-dim { color: var(--sb-muted); font-size: 12.5px; }
.sb-pop textarea { width: 100%; box-sizing: border-box; min-height: 64px; font: inherit; color: var(--sb-fg); background: var(--sb-bg); border: 1.5px solid var(--sb-go); border-radius: 9px; padding: 8px 10px; resize: vertical; }
.sb-pop button { align-self: flex-start; color: var(--sb-fg); background: var(--sb-soft); border: none; border-radius: 8px; padding: 5px 10px; }
.sb-bar { position: fixed; right: max(12px, env(safe-area-inset-right, 0px)); bottom: calc(12px + env(safe-area-inset-bottom, 0px)); display: flex; gap: 6px; align-items: center; background: var(--sb-bg); border: 1px solid var(--sb-line); border-radius: 12px; padding: 6px; box-shadow: 0 4px 16px rgb(0 0 0 / .2); max-width: calc(100vw - 24px); flex-wrap: wrap; }
.sb-bar button { color: var(--sb-fg); background: var(--sb-soft); border: 1.5px solid transparent; border-radius: 9px; padding: 6px 10px; }
.sb-bar button.sb-on { border-color: var(--sb-go); color: var(--sb-go); }
.sb-bar button.sb-go { background: var(--sb-go); color: var(--sb-bg); }
.sb-bar .sb-dim { color: var(--sb-muted); font: 12px ui-monospace, monospace; padding: 0 4px; }
.sb-bar .sb-err { color: #cf3a34; font-size: 12.5px; max-width: 260px; }`;
  document.head.append(style);

  // блок — элемент с data-block и своим id; на странице без таких блок один — вся страница
  const marked = [...document.querySelectorAll("[data-block][id]")];
  const blocks = marked.length ? marked : [document.body];
  const idOf = (b) => (b === document.body ? "" : b.id);
  const blockOf = (id) => blocks.find((b) => idOf(b) === id);
  const kit = el("div"); kit.id = "sb-kit";
  const inKit = (t) => !!t.closest("#sb-kit");
  /** Правки блока: элементы с data-chg. Блок просмотрен, пока в нём нет правки, которой человек ещё не видел. */
  const chgOf = (b) => [...(b.matches("[data-chg]") ? [b] : []), ...b.querySelectorAll("[data-chg]")].filter((e) => !inKit(e)).map((e) => e.dataset.chg);
  // якорь комментария — элемент: его id либо путь от блока по номерам детей
  const pick = (t) => (t.closest("svg") && !t.matches("svg") ? t.closest("g") ?? t.closest("svg") : t);
  const pathOf = (b, e) => { if (e === b) return ""; if (e.id) return "#" + e.id; const p = []; for (let x = e; x && x !== b; x = x.parentElement) p.unshift([...x.parentElement.children].indexOf(x)); return p.join("/"); };
  const find = (b, path) => { if (!path) return b; if (path[0] === "#") return document.getElementById(path.slice(1)) ?? b; let x = b; for (const i of path.split("/")) x = x?.children[+i]; return x ?? b; };
  const nameOf = (e) => (e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || e.tagName.toLowerCase();

  let seen = new Map(), notes = [], over = null, mode = null, hot = null, error = "";
  const viewed = (b) => seen.has(idOf(b)) && chgOf(b).every((c) => seen.get(idOf(b)).includes(c));
  const pop = el("div", "sb-pop"), bar = el("div", "sb-bar"), pins = el("div");
  const bC = el("button", "", "💬"), bA = el("button", "", "✓"), bGo = el("button", "sb-go"), commit = el("span", "sb-dim"), err = el("span", "sb-err");
  bC.type = bA.type = bGo.type = "button";
  bC.title = "Комментарий к элементу — клавиша C"; bA.title = "Просмотрено — клавиша A";
  if (SB.commit) commit.textContent = SB.dirty ? "не в коммите" : SB.commit;
  bar.append(...(SB.comments ? [bC] : []), ...(SB.marks ? [bA] : []), ...(SB.commit ? [commit] : []), ...(SB.comments ? [bGo] : []), err);
  kit.append(pins, bar);

  const light = (e) => { hot?.classList.remove("sb-hot"); hot = e; hot?.classList.add("sb-hot"); };
  const setMode = (m) => { mode = m; document.body.classList.toggle("sb-c", m === "c"); if (!m) light(null); draw(); };
  const closePop = () => { pop.remove(); light(null); };
  /** Место элемента на странице: метка — у правого верхнего угла, пузырь — под элементом. */
  const spot = (e) => { const r = e.getBoundingClientRect(); return { x: r.right + scrollX, top: r.top + scrollY, bottom: r.bottom + scrollY }; };
  const place = (e) => {
    kit.append(pop); light(e);
    const at = spot(e), w = document.documentElement.clientWidth || 600;
    pop.style.left = Math.max(8, Math.min(at.x - 150, w - 308)) + "px";
    pop.style.top = at.bottom + 8 + "px";
  };
  const fail = (e) => { error = e.message; draw(); };
  const ask = (b, e, quote) => {
    const text = el("textarea"); text.setAttribute("aria-label", "Комментарий");
    const keep = async () => {
      const t = text.value.trim();
      closePop();
      if (!t) return;
      await db("INSERT INTO sb_comments (block, el, label, quote, text, at) VALUES (?, ?, ?, ?, ?, ?)", idOf(b), pathOf(b, e), nameOf(e), quote || null, t, Date.now()).catch(fail);
      await load();
    };
    text.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closePop(); if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); void keep(); } });
    pop.replaceChildren(...(quote ? [el("div", "sb-dim", "«" + quote + "»")] : []), text);
    place(e); text.focus();
  };
  const open = (n) => {
    const kids = [...(n.quote ? [el("div", "sb-dim", "«" + n.quote + "»")] : []), el("p", "", n.text)];
    if (n.reply) kids.push(el("p", "sb-dim", "↳ " + n.reply));
    if (n.ticket) kids.push(el("div", "sb-dim", n.ticket));
    else { const b = el("button", "", "Удалить"); b.type = "button"; b.onclick = async () => { closePop(); await db("DELETE FROM sb_comments WHERE id = ? AND ticket IS NULL", n.id).catch(fail); await load(); }; kids.push(b); }
    pop.replaceChildren(...kids);
    place(find(blockOf(n.block) ?? document.body, n.el));
  };

  const draw = () => {
    if (SB.marks) for (const b of marked) b.classList.toggle("sb-new", !viewed(b));
    pins.replaceChildren(...notes.map((n, i) => {
      const at = spot(find(blockOf(n.block) ?? document.body, n.el));
      const p = el("button", "sb-pin" + (n.ticket ? " sb-sent" : ""), String(i + 1)); p.type = "button";
      p.style.left = at.x + "px"; p.style.top = at.top + "px";
      p.onclick = () => open(n);
      return p;
    }));
    const drafts = notes.filter((n) => !n.ticket).length;
    bGo.hidden = !drafts; bGo.textContent = "Отправить · " + drafts;
    bC.classList.toggle("sb-on", mode === "c");
    bA.classList.toggle("sb-on", mode === "a" || (!marked.length && viewed(document.body)));
    err.textContent = error;
  };
  const load = async () => {
    try {
      if (SB.marks) seen = new Map((await db("SELECT block, seen FROM sb_marks")).map((r) => [r.block, JSON.parse(r.seen)]));
      if (SB.comments) notes = await db("SELECT id, block, el, label, quote, text, ticket, reply FROM sb_comments ORDER BY id");
    } catch (e) { error = e.message; }
    draw();
  };
  const mark = async (b) => {
    if (!SB.marks) return;
    await (viewed(b) ? db("DELETE FROM sb_marks WHERE block = ?", idOf(b)) : db("INSERT INTO sb_marks (block, seen) VALUES (?, ?) ON CONFLICT (block) DO UPDATE SET seen = excluded.seen", idOf(b), JSON.stringify(chgOf(b)))).catch(fail);
    await load();
  };
  const send = async () => {
    error = ""; closePop();
    await post("/_sb/submit", {}).catch(fail);
    await load();
  };

  for (const b of blocks) b.addEventListener("mouseenter", () => (over = b));
  if (!marked.length) over = document.body;
  // в режиме комментария элемент под курсором обведён
  document.addEventListener("mouseover", (e) => { const t = e.target; if (mode === "c" && t instanceof Element && !inKit(t)) light(pick(t)); });
  // нажатие в режиме выбирает элемент и до страницы не доходит; режим «просмотрено» с панели — для телефона
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element) || inKit(t)) return;
    if (!mode) return closePop();
    const b = t.closest("[data-block][id]") ?? (marked.length ? null : document.body);
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const m = mode; setMode(null);
    if (m === "a") void mark(b); else ask(b, pick(t), "");
  }, true);
  bC.onclick = () => setMode(mode === "c" ? null : "c");
  bA.onclick = () => (marked.length ? setMode(mode === "a" ? null : "a") : void mark(document.body));
  bGo.onclick = () => void send();
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.ctrlKey || e.metaKey || e.altKey || (t instanceof Element && t.matches("input, textarea, select, [contenteditable]"))) return;
    if (e.key === "Escape") { setMode(null); return closePop(); }
    // клавиша узнаётся по месту на клавиатуре (code), а не по букве: раскладка любая
    if (e.code === "KeyA" && SB.marks && over) void mark(over);
    else if (e.code === "KeyC" && SB.comments) {
      e.preventDefault();
      // выделен текст — комментарий сразу к его элементу; иначе режим: следующее нажатие выбирает элемент
      const sel = getSelection(), quote = String(sel ?? "").trim().slice(0, 200);
      const node = quote && sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
      const at = node && (node.nodeType === 1 ? node : node.parentElement);
      const b = at && !inKit(at) ? at.closest("[data-block][id]") ?? (marked.length ? null : document.body) : null;
      if (b) ask(b, pick(at), quote); else setMode(mode === "c" ? null : "c");
    }
  });
  addEventListener("resize", draw);
  addEventListener("load", draw);
  document.body.append(kit);
  void load();
})();
