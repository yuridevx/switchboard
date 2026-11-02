// Ядро веб-приложения: гейт набора, пропуск, связь с машинами флота клиентом fleet, маршрут кадров модулям,
// экраны и навигация, хранилище, штатный уход с экрана. Ни одной функции приложения само не знает.
import { fleet, PROTO, type FleetClient, type Frame, type Roster, type WsCtor } from "@switchboard/relay";
import { serviceAddress } from "@switchboard/protocol";
import { BASE_CSS } from "./css.ts";
import { appGate, nameOf, ownerOf } from "./gate.ts";
import { idbStore } from "./store.ts";
import { h, hhmm, plural } from "./ui.ts";
import type {
  App,
  AppModule,
  ConnState,
  Ctx,
  Manifest,
  Params,
  Platform,
  Result,
  Running,
  Screen,
  ScreenHandle,
  StartOptions,
} from "./types.ts";

type Mod = { m: Manifest; mod: AppModule; app: App; failed: string | null };
type Mount = { owner: Mod; name: string; def: Screen; el: HTMLElement; handle: ScreenHandle; page: boolean; master?: boolean };

/** Приглашение в адресе страницы: #invite=<номер>.<секрет>; его же принимает поле ввода. */
const INVITE_RE = /^[a-z0-9]{4}\.[A-Za-z0-9_-]{43}$/;
/** Предел приёма приглашения у gate. */
const REDEEM_MS = 30_000;
/** Причины своих закрытий link — не отказ relay. */
const OWN = new Set(["closing", "hidden", "now"]);
const MAX_PAUSE = 60_000;

/** Номер пропуска для экрана: client.phone.k2a9.<секрет> → client.phone.k2a9. */
export const keyId = (key: string) => key.split(".").slice(0, 3).join(".");

/** Платформа по navigator: iPhone/iPad и запущено ли с экрана «Домой». */
export function detectPlatform(win: Window): Platform {
  const nav = win.navigator as Navigator & { standalone?: boolean };
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent);
  const standalone = nav.standalone === true || !!win.matchMedia?.("(display-mode: standalone)").matches;
  return { ios, standalone };
}

/** Запустить приложение: гейт → ключ → модули → связь. */
export function startApp(o: StartOptions): Running {
  const win = o.window ?? window;
  const doc = win.document;
  const store = o.store ?? idbStore();
  const platform = o.platform ?? detectPlatform(win);
  const firstPause = o.pauseMs ?? 1_000;
  const wide = !!o.wide;
  /** Как получить пропуск: приглашение выдаёт агент инструментом keys.invite. */
  const invite = (n: string) => `keys.invite client ${n} <почта>`;

  const mods: Mod[] = [];
  const frameOwner = new Map<string, Mod>();
  const screenOwner = new Map<string, { owner: Mod; def: Screen }>();
  const markOwner = new Map<string, Mod>();
  const mounts: Mount[] = [];
  const pending = new Set<Promise<unknown>>();

  let stopped: string | null = null;
  let key = "";
  let name = "";
  let lk: FleetClient | null = null;
  let conn: ConnState = "connecting";
  let roster: Roster | null = null;
  let rosterAt = 0;
  let pause = firstPause;
  let retryAt = 0;
  let fresh = false;
  let hidden = false;
  let routed = "";
  let current: { screen: string; params: Params } | null = null;
  let depth = 0;
  let life: Promise<void> = Promise.resolve();
  let tick: ReturnType<typeof setInterval> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  // ───── каркас страницы ─────
  const style = h("style", null, BASE_CSS + o.parts.map((p) => p.module.css ?? "").join("\n"));
  const navcol = h("nav", { class: "sb-navcol", hidden: !wide });
  const bar = h("header", { class: "sb-bar" });
  const navrow = h("nav", { class: "sb-navrow", hidden: true });
  const off = h("div", { class: "sb-off", role: "status", hidden: true });
  const top = h("div", { class: "sb-top" });
  const view = h("div", { class: "sb-view" });
  const toastEl = h("div", { class: "sb-toast", role: "alert", hidden: true });
  const main = h("main", { class: "sb-main" }, bar, navrow, off, top, view, toastEl);
  o.root.textContent = "";
  o.root.append(style, h("div", { class: "sb-app" + (wide ? " wide" : "") }, navcol, main));

  /** Полноэкранное состояние вместо всего приложения: отказ, стоп, установка. */
  function full(...kids: Array<Node | null>) {
    bar.hidden = navrow.hidden = off.hidden = top.hidden = true;
    navcol.hidden = true;
    view.textContent = "";
    view.append(h("div", { class: "sb-full" }, ...kids));
  }

  function stopWith(why: string, ...kids: Array<Node | null>) {
    stopped = why;
    console.error(`switchboard: ${why}`);
    clearInterval(tick);
    full(...kids);
  }

  // ───── модули ─────
  function failMod(x: Mod, where: string, e: unknown) {
    if (x.failed) return;
    x.failed = `Модуль ${x.m.name} упал на ${where}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    console.error(x.failed, e);
    for (const mt of mounts) if (mt.owner === x) drawFailed(mt.el, mt.def, x.failed);
    refreshAll();
  }

  function call<R>(x: Mod, where: string, fn: () => R): R | undefined {
    if (x.failed) return undefined;
    try {
      return fn();
    } catch (e) {
      failMod(x, where, e);
      return undefined;
    }
  }

  async function callAsync(x: Mod, where: string, fn: () => unknown) {
    if (x.failed) return;
    try {
      await fn();
    } catch (e) {
      failMod(x, where, e);
    }
  }

  function drawFailed(el: HTMLElement, def: Screen, why: string) {
    el.textContent = "";
    el.append(
      h(
        "div",
        { class: "sb-pad" },
        h("div", { class: "sb-badc" }, h("b", null, `${def.label ?? "Экран"} выключен${def.label?.endsWith("а") ? "а" : ""}`), h("code", null, why), h("span", null, "Остальные экраны работают. Этот вернётся после перезапуска приложения.")),
        h("button", { class: "sb-cta", onclick: () => win.location.reload() }, "Перезапустить приложение"),
      ),
    );
  }

  function usesRef(x: Mod, n: string): string | undefined {
    return Object.keys(x.m.uses).find((r) => nameOf(r) === n);
  }

  function provides(machine: string): Record<string, number> | null {
    const m = roster?.machines.find((x) => x.machine === machine);
    return m ? (m.contract ?? {}) : null;
  }

  async function request(x: Mod, n: string, body: Record<string, unknown> = {}): Promise<Result> {
    const ref = usesRef(x, n);
    if (!ref) {
      failMod(x, `запросе ${n}`, new Error(`${n} нет в uses`));
      return { ok: false, error: "module_error" };
    }
    const owner = ownerOf(ref);
    // версия — названная в вызове как есть, иначе из uses: одно правило с ядром Host
    const f: Frame = { ...body, type: n, v: (body.v as number | undefined) ?? x.m.uses[ref] };
    // Worker — .имя, POST по адресу из сборки; имя и версию проверяет получатель и отвечает словом
    if (Object.hasOwn(o.workers, owner)) f.to = serviceAddress(owner);
    if (!lk || conn !== "open") return { ok: false, error: "disconnected" };
    const p = lk.request(f);
    pending.add(p);
    const r = await p;
    pending.delete(p);
    return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
  }

  function deliver(f: Frame, ctx: Ctx = { open: false }) {
    const x = frameOwner.get(f.type);
    if (x) {
      call(x, `кадре ${f.type}`, () => x.mod.frames![f.type](f, ctx));
      return;
    }
    if (typeof f.id === "string" && f.type !== "reply") {
      // запрос к приложению: клиент запросов не обслуживает
      lk?.send({ type: "reply", id: f.id, ok: false, error: "unknown_request", to: f.from });
      return;
    }
    console.warn(`switchboard: кадр ${f.type} — владельца в приложении нет`);
  }

  function appFor(x: Mod): App {
    return {
      get name() {
        return name;
      },
      wide,
      request: ((n: string, body?: Record<string, unknown>) => request(x, n, body)) as App["request"],
      open: (screen, params = {}, place) => {
        const own = x.mod.screens?.[screen] !== undefined;
        if (!own && !usesRef(x, screen)) {
          failMod(x, `открытии ${screen}`, new Error(`экрана ${screen} нет в uses`));
          return undefined;
        }
        if (place) return mountIn(screen, params, place);
        go(screen, params);
        return undefined;
      },
      back,
      provides,
      roster: () => roster,
      current: () => (current ? { screen: current.screen, params: { ...current.params } } : null),
      link: () => conn,
      mark: (n, ...args) => {
        if (!usesRef(x, n) && !x.mod.marks?.[n]) {
          failMod(x, `метке ${n}`, new Error(`метки ${n} нет в uses`));
          return undefined;
        }
        const ow = markOwner.get(n);
        return ow ? call(ow, `метке ${n}`, () => ow.mod.marks![n](...args)) : undefined;
      },
      store: <T>(section: string) => {
        if (!x.mod.store?.includes(section)) throw new Error(`раздела ${section} нет в store модуля ${x.m.name}`);
        return {
          get: () => store.get<T>(section),
          set: (v: T) => store.set(section, v),
          update: (fn: (old: T | undefined) => T) => store.update<T>(section, fn),
        };
      },
      deliver,
      changed: () => refreshAll(),
      toast,
    };
  }

  // ───── экраны и адрес ─────
  function parseHash(): { screen: string; params: Params } {
    const raw = win.location.hash.replace(/^#/, "");
    const [path, q = ""] = raw.split("?");
    for (const [n, s] of screenOwner) {
      if ((s.def.path ?? n) === path && !s.def.slot) return { screen: n, params: Object.fromEntries(new URLSearchParams(q)) };
    }
    return { screen: home(), params: {} };
  }

  function home(): string {
    for (const [n, s] of screenOwner) if (s.def.nav) return n;
    return [...screenOwner.keys()][0] ?? "";
  }

  function hashOf(screen: string, params: Params): string {
    const s = screenOwner.get(screen);
    const q = new URLSearchParams(params).toString();
    return "#" + (s?.def.path ?? screen) + (q ? "?" + q : "");
  }

  function go(screen: string, params: Params) {
    const hs = hashOf(screen, params);
    if (hs === win.location.hash) return;
    depth++;
    win.history.pushState({ depth }, "", hs);
    route();
  }

  function back() {
    if (depth > 0) {
      depth--;
      win.history.back();
      return;
    }
    const hs = hashOf(home(), {});
    win.history.replaceState(null, "", hs);
    route();
  }

  function mount(screen: string, params: Params, el: HTMLElement, page: boolean): Mount | null {
    const s = screenOwner.get(screen);
    if (!s) return null;
    const mt: Mount = { owner: s.owner, name: screen, def: s.def, el, handle: {}, page };
    mounts.push(mt);
    if (s.owner.failed) drawFailed(el, s.def, s.owner.failed);
    else mt.handle = call(s.owner, `экране ${screen}`, () => s.def.mount(el, params)) || {};
    return mt;
  }

  function unmount(mt: Mount) {
    // вложенные экраны (в местах этого) уходят вместе с ним
    for (const inner of mounts.filter((x) => x !== mt && mt.el.contains(x.el))) unmount(inner);
    const i = mounts.indexOf(mt);
    if (i < 0) return;
    mounts.splice(i, 1);
    if (mt.handle.close) call(mt.owner, `экране ${mt.name}`, () => mt.handle.close!());
  }

  function mountIn(screen: string, params: Params, place: HTMLElement): ScreenHandle {
    const mt = mount(screen, params, place, false);
    if (!mt) return {};
    return {
      refresh: () => mt.handle.refresh && call(mt.owner, `экране ${screen}`, () => mt.handle.refresh!()),
      close: () => unmount(mt),
    };
  }

  function route() {
    if (stopped || !roster) return;
    const { screen, params } = parseHash();
    routed = win.location.hash;
    current = { screen, params };
    const el = h("div", { class: "sb-screen", "data-screen": screen, style: "display:flex;flex-direction:column;flex:1;min-height:0" });
    // широкий вид: экран рядом со списком — список слева остаётся, меняется только правая часть
    const masterName = wide ? o.beside?.[screen] : undefined;
    const old = mounts.find((x) => x.master);
    if (masterName && screenOwner.has(masterName)) {
      for (const mt of mounts.filter((x) => x.page)) unmount(mt);
      let right = view.querySelector<HTMLElement>(":scope > .sb-split > .sb-detail");
      if (!old || old.name !== masterName || !right) {
        if (old) unmount(old);
        view.textContent = "";
        const left = h("div", { class: "sb-master", "data-screen": masterName });
        right = h("div", { class: "sb-detail" });
        view.append(h("div", { class: "sb-split" }, left, right));
        const mt = mount(masterName, {}, left, false);
        if (mt) mt.master = true;
      }
      right.textContent = "";
      right.append(el);
    } else {
      for (const mt of mounts.filter((x) => x.page || x.master)) unmount(mt);
      view.textContent = "";
      view.append(el);
    }
    mount(screen, params, el, true);
    top.hidden = !screenOwner.get(screen)?.def.nav && !masterName;
    drawChrome();
  }

  function refreshAll() {
    for (const mt of [...mounts]) if (mt.handle.refresh) call(mt.owner, `экране ${mt.name}`, () => mt.handle.refresh!());
    drawChrome();
  }

  // ───── шапка, разделы, полоса связи ─────
  function drawChrome() {
    if (stopped || !roster) return;
    const page = mounts.find((x) => x.page);
    const master = mounts.find((x) => x.master);
    const def = page?.def;
    const hd = (page && page.handle.head && call(page.owner, `экране ${page.name}`, () => page.handle.head!())) || { title: def?.nav ?? def?.label ?? "" };
    let pill = hd.pill ?? (def?.nav ? { text: "на связи", tone: "ok" as const } : undefined);
    let sub = hd.sub;
    if (conn !== "open") {
      pill = conn === "closed" ? { text: "нет связи", tone: "bad" } : { text: "подключаюсь", tone: "wait" };
      if (conn === "closed" && rosterAt) sub = `данные на ${hhmm(rosterAt)}`;
    }
    bar.hidden = false;
    bar.textContent = "";
    bar.append(
      ...[
      def?.nav ? h("div", { class: "sb-logo", "aria-hidden": "true" }, "S") : h("button", { class: "sb-back", "aria-label": "Назад", onclick: back }, "‹"),
      h("div", { class: "sb-bt" }, h("b", { class: hd.mono ? "m" : null }, hd.title), sub ? h("span", null, sub) : null),
      pill ? h("span", { class: `sb-pill ${pill.tone ?? ""}${conn !== "open" || def?.nav ? " conn" : ""}` }, pill.text) : null,
      ].filter((x): x is HTMLElement => x !== null),
    );
    // разделы: в широком виде — колонка, в узком — строка, если их больше одного
    const navs = [...screenOwner].filter(([, s]) => s.def.nav && !s.def.slot);
    const items = navs.map(([n, s]) => {
      const count = s.def.mark && !s.owner.failed ? call(s.owner, `метке ${s.def.mark}`, () => s.owner.mod.marks![s.def.mark!]()) : undefined;
      return h(
        "button",
        { "aria-current": page?.name === n || master?.name === n ? "page" : null, "data-screen": n, onclick: () => (page?.name === n ? null : go(n, {})) },
        s.def.nav!,
        typeof count === "number" && count > 0 ? h("span", { class: "sb-badge wait" }, count) : null,
      );
    });
    navcol.textContent = "";
    navrow.textContent = "";
    if (wide) {
      // колонка разделов: имя приложения и связь, разделы, машины на связи, имя этого устройства
      const cp = conn === "open" ? { text: "на связи", tone: "ok" } : conn === "closed" ? { text: "нет связи", tone: "bad" } : { text: "подключаюсь", tone: "wait" };
      navcol.append(
        h("div", { class: "sb-brand" }, h("div", { class: "sb-logo" }, "S"), h("b", null, o.brand ?? "Switchboard"), h("span", { class: `sb-pill conn ${cp.tone}`, title: cp.text, "aria-label": cp.text })),
        ...items,
        h("div", { class: "sb-ncap" }, "машины"),
        ...(roster?.machines ?? []).map((m) => h("div", { class: "sb-nm", "data-nm": m.machine }, h("span", { class: "sb-dot idle" }), m.machine)),
        h("div", { class: "sb-me" }, keyId(key).split(".").slice(1).join(" · ")),
      );
    }
    else if (items.length > 1) navrow.append(...items);
    navrow.hidden = wide || items.length < 2;
    drawOff();
  }

  function drawOff() {
    off.hidden = conn === "open" || retryAt === 0 || stopped !== null;
    if (off.hidden) return;
    const s = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    off.textContent = "";
    off.append(
      h("span", null, `Нет связи с relay${wide && rosterAt ? ` · данные на ${hhmm(rosterAt)}` : ""}${s > 0 ? ` · снова через ${s} с` : " · подключаюсь"}`),
      h("button", { onclick: reconnectNow }, "Сейчас"),
    );
  }

  function toast(text: string, tone: "ok" | "bad" = "bad") {
    clearTimeout(toastTimer);
    toastEl.className = "sb-toast " + tone;
    toastEl.textContent = text;
    toastEl.hidden = false;
    toastTimer = setTimeout(() => (toastEl.hidden = true), 6_000);
  }

  function connectingScreen() {
    bar.hidden = top.hidden = true;
    view.textContent = "";
    view.append(
      h(
        "div",
        { class: "sb-full" },
        h("div", { class: "sb-logo xl" }, "S"),
        fresh ? h("div", { class: "sb-big" }, "Ключ сохранён") : null,
        h("span", { class: "sb-k" }, keyId(key)),
        h("p", null, "подключаюсь · hello"),
      ),
    );
  }

  // ───── связь ─────
  function connect() {
    pause = firstPause;
    lk = fleet({
      relay: o.relayUrl,
      gate: o.workers.gate ?? "",
      workers: o.workers,
      key,
      pauseMs: firstPause,
      maxPauseMs: MAX_PAUSE,
      WebSocket: o.WebSocket as WsCtor | undefined,
      fetch: o.fetch,
      // отказ пропуску на любой машине или у gate — остановка; иначе состояние флота: открыт, если открыта хоть одна машина;
      // модули узнают о смене состояния флота, а не каждого соединения
      onState: (_m, s, why) => {
        if (s === "stopped" && why !== undefined && !OWN.has(why)) return onState("stopped", why);
        const now = lk?.state ?? s;
        if (now !== conn) onState(now, why);
      },
      onFrame: (f) => onFrame(f),
    });
  }

  function reconnectNow() {
    lk?.close(1000, "now");
    connect();
  }

  function setConn(s: ConnState) {
    conn = s;
    for (const x of mods) if (x.mod.on?.link) call(x, "смене связи", () => x.mod.on!.link!(s));
  }

  function onState(s: string, why?: string) {
    if (s === "stopped") {
      if (why !== undefined && OWN.has(why)) return;
      clearInterval(tick);
      setConn("stopped");
      return refused(why ?? "");
    }
    if (s === "open") {
      clearInterval(tick);
      pause = firstPause;
      retryAt = 0;
      setConn("open");
      refreshAll();
      return;
    }
    if (s === "closed") {
      // та же пауза, что у link: растёт вдвое до потолка, сбрасывается на принятом hello
      retryAt = Date.now() + pause;
      pause = Math.min(pause * 2, MAX_PAUSE);
      console.warn(`switchboard: связь с relay оборвалась (${why}) · снова через ${Math.round((retryAt - Date.now()) / 1000)} с`);
      setConn("closed");
      clearInterval(tick);
      tick = setInterval(drawOff, 1_000);
      refreshAll();
      if (!roster) drawOff();
      return;
    }
    setConn("connecting");
    drawChrome();
  }

  function onFrame(f: Frame) {
    if (f.type === "roster") {
      const first = !roster;
      // roster флота — объединение roster объектов машин
      roster = lk?.roster ?? (f as unknown as Roster);
      rosterAt = Date.now();
      for (const x of mods) {
        if (x.mod.on?.roster && x.m.uses["roster@relay"] !== undefined) call(x, "кадре roster", () => x.mod.on!.roster!(roster!));
      }
      if (first) {
        bar.hidden = false;
        route();
        if (fresh) {
          const ms = roster.machines.map((m) => m.machine);
          const n = roster.sessions.length;
          toast(`Вы во флоте: ${ms.join(" и ") || "машин нет"} на связи, ${n} ${plural(n, "сессия", "сессии", "сессий")}.`, "ok");
        }
      } else refreshAll();
      return;
    }
    deliver(f);
  }

  function refused(why: string) {
    const kid = keyId(key);
    const cmd = h("code", { class: "sb-cmd" }, invite(name));
    if (why === "revoked" || why === "bad_key") {
      return stopWith(
        why,
        h("div", { class: "sb-ring bad" }, "×"),
        h("div", { class: "sb-big" }, why === "revoked" ? "Пропуск отозван" : "Пропуск не принят"),
        h("p", null, `${kid} ${why === "revoked" ? "больше не принимают" : "не принят флотом"}. Новый пропуск — приглашением от агента флота:`),
        cmd,
        h("p", null, "Откройте ссылку-приглашение в этом приложении. Само приложение больше не подключается."),
      );
    }
    if (why === "contract_mismatch") {
      return stopWith(
        why,
        h("div", { class: "sb-ring wait" }, "↻"),
        h("div", { class: "sb-big" }, "Приложение устарело"),
        h("p", null, `У приложения proto ${PROTO}; relay эту версию не принял — его обновили, пока приложение было открыто.`),
        h("button", { class: "sb-cta", onclick: () => win.location.reload() }, "Перезагрузить"),
      );
    }
    return stopWith(
      why,
      h("div", { class: "sb-ring bad" }, "×"),
      h("div", { class: "sb-big" }, "Связь остановлена"),
      h("p", null, `relay закрыл соединение: ${why || "без причины"}.`),
      h("button", { class: "sb-cta", onclick: () => win.location.reload() }, "Перезагрузить"),
    );
  }

  /** Приём приглашения: POST gate.redeem → пропуск или слово отказа. */
  async function redeem(inv: string): Promise<{ key: string } | { error: string }> {
    try {
      const res = await (o.fetch ?? fetch)(o.workers.gate ?? "", { method: "POST", body: JSON.stringify({ type: "gate.redeem", id: "redeem", v: 1, invite: inv }), signal: AbortSignal.timeout(REDEEM_MS) });
      const r = (await res.json()) as { ok: boolean; result?: { key: string }; error?: string };
      return r.ok && r.result ? { key: r.result.key } : { error: r.error ?? "bad_invite" };
    } catch {
      return { error: "gate_unavailable" };
    }
  }

  function refusedInvite(word: string) {
    return stopWith(
      word,
      h("div", { class: "sb-ring bad" }, "×"),
      h("div", { class: "sb-big" }, "Приглашение не принято"),
      h("p", null, word === "bad_invite" ? "Оно уже принято, отозвано или набрано с ошибкой. Попросите агента выдать новое." : `gate не ответил: ${word}. Откройте ссылку ещё раз позже.`),
    );
  }

  // ───── уход с экрана и возвращение ─────
  function hide(): Promise<void> {
    life = life.then(async () => {
      if (hidden || stopped) return;
      hidden = true;
      // начатые доводятся до reply, модули дописывают своё (и снимают подписки), затем close(1000)
      await Promise.all([...pending]);
      for (const x of [...mods].reverse()) if (x.mod.stop) await callAsync(x, "остановке", () => x.mod.stop!());
      await Promise.all([...pending]);
      clearInterval(tick);
      lk?.close(1000, "hidden");
      lk = null;
      conn = "connecting";
      retryAt = 0;
    });
    return life;
  }

  function show(): Promise<void> {
    life = life.then(async () => {
      if (!hidden || stopped) return;
      hidden = false;
      for (const x of mods) if (x.mod.start) await callAsync(x, "старте", () => x.mod.start!(x.app));
      connect();
    });
    return life;
  }

  // ───── старт ─────
  async function boot() {
    const errors = appGate(o.parts);
    if (errors.length) {
      return stopWith(
        "gate",
        h("div", { class: "sb-ring bad" }, "×"),
        h("div", { class: "sb-big" }, "Приложение не стартует"),
        h("ul", { class: "sb-errs" }, errors.map((e) => h("li", null, e))),
      );
    }
    for (const p of o.parts) {
      const x: Mod = { m: p.manifest, mod: p.module, app: null as unknown as App, failed: null };
      x.app = appFor(x);
      mods.push(x);
      for (const t of Object.keys(p.module.frames ?? {})) frameOwner.set(t, x);
      for (const [n, def] of Object.entries(p.module.screens ?? {})) screenOwner.set(n, { owner: x, def });
      for (const n of Object.keys(p.module.marks ?? {})) markOwner.set(n, x);
    }

    const raw = decodeURIComponent(win.location.hash.replace(/^#/, ""));
    const fromHash = raw.startsWith("invite=") && INVITE_RE.test(raw.slice(7)) ? raw.slice(7) : null;
    if (fromHash && platform.ios && !platform.standalone) {
      // iPhone: пуши — только у приложения с экрана «Домой», хранилище у него своё — приглашение ждёт в адресе, не погашено
      stopped = "install";
      return full(
        h("div", { class: "sb-logo xl" }, "S"),
        h("div", { class: "sb-big" }, "Добавьте Switchboard на экран «Домой»"),
        h("p", null, "На iPhone уведомления приходят только приложению с экрана «Домой»."),
        h(
          "ol",
          { class: "sb-ol" },
          h("li", null, "Нажмите «Поделиться» внизу"),
          h("li", null, "«На экран „Домой“»"),
          h("li", null, "Откройте Switchboard с экрана «Домой»"),
        ),
        h("p", null, `Приглашение ${fromHash.split(".")[0]} ждёт в адресе страницы до установки.`),
      );
    }
    if (fromHash) {
      // приглашение — у gate: секрет пропуска рождается там и приходит один раз; адрес очищен в любом исходе
      win.history.replaceState(null, "", win.location.pathname + win.location.search);
      const r = await redeem(fromHash);
      if ("error" in r) return refusedInvite(r.error);
      await store.set("key", r.key);
      fresh = true;
    }
    key = (await store.get<string>("key")) ?? "";
    if (!key) {
      // приглашение не доехало (iPhone: адрес не дошёл до экрана «Домой») — вставить вручную
      const input = h("input", { class: "sb-keyin", type: "text", placeholder: "приглашение или ссылка с #invite=", "aria-label": "Приглашение" }) as HTMLInputElement;
      const why = h("p", { role: "alert" });
      const save = async () => {
        const v = decodeURIComponent(input.value.trim().replace(/^.*#(invite=)?/, ""));
        if (!INVITE_RE.test(v)) return void (why.textContent = "Это не приглашение: нужен <номер>.<секрет> или ссылка с #invite=.");
        const r = await redeem(v);
        if ("error" in r) return void (why.textContent = `Приглашение не принято: ${r.error}.`);
        await store.set("key", r.key);
        win.location.reload();
      };
      return stopWith(
        "no_key",
        h("div", { class: "sb-logo xl" }, "S"),
        h("div", { class: "sb-big" }, "Нужен пропуск флота"),
        h("p", null, "Вход — только пропуском. Попросите агента флота выдать приглашение и откройте ссылку в этом приложении:"),
        h("code", { class: "sb-cmd" }, invite(wide ? "<имя>" : "phone")),
        h("p", null, "Или вставьте приглашение:"),
        input,
        h("button", { class: "sb-cta", onclick: () => void save() }, "Принять приглашение"),
        why,
      );
    }
    name = key.split(".")[1];

    for (const x of mods) if (x.mod.start) await callAsync(x, "старте", () => x.mod.start!(x.app));
    for (const [n, s] of screenOwner) if (s.def.slot === "top") mount(n, {}, top.appendChild(h("div")), false);
    connectingScreen();
    win.addEventListener("popstate", () => {
      depth = (win.history.state as { depth?: number } | null)?.depth ?? 0;
      route();
    });
    win.addEventListener("hashchange", () => {
      if (win.location.hash !== routed) route();
    });
    doc.addEventListener("visibilitychange", () => (doc.visibilityState === "hidden" ? hide() : show()));
    win.addEventListener("pagehide", () => hide());
    if (doc.visibilityState === "hidden") hidden = true;
    else connect();
  }

  const ready = boot();
  return {
    ready,
    get stopped() {
      return stopped;
    },
    get failed() {
      return Object.fromEntries(mods.filter((x) => x.failed).map((x) => [x.m.name, x.failed!]));
    },
    hide,
    show,
  };
}
