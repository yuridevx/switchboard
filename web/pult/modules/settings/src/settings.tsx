// pult-settings — настройки флота вкладками: выпуски по машинам и каталог, пропуска, GitHub и устройство.
// Каждая цифра — ответ владельца: «Выпусков» (stable, планы), keeper машины (что стоит), gate (пропуска), github, профилей.
// Ответы и вид экрана живут в замыкании модуля: изменились — bump, экран перечитывает их выборкой счётчика rev.
import { useEffect, useRef, useState } from "react";
import type { App, AppModule, Roster, ScreenProps } from "@switchboard/web-core";
import type {} from "@switchboard/web-alerts";
import { Btn, Cmd, Dot, In, LinkBtn, M, Meter, Note, Opts, Page, PageHead, Pill, plural, Row, Sec } from "@switchboard/web-ui";
import qrcode from "qrcode-generator";
import css from "./settings.css";

type Entry = { pin?: string; on?: boolean; force?: boolean };
type Listed = {
  parts: Record<string, { where: "machine" | "cloud"; edge: string | null; stable: string | null; versions?: string[] }>;
  machines: Array<{ machine: string; plan: Record<string, Entry> }>;
  rev: number;
  modules?: Record<string, { into: string[]; built: Record<string, string>; edge: string | null }>;
};
type KPart = { part: string; version?: string; state?: string; error?: string };
type KState = { keeper?: string; rev?: number; os?: string; parts?: KPart[] };
type Pass = { id: string; role: "host" | "client"; name: string; person: string | null; addr: string; state: "wait" | "ok"; by: string; at: number };
type Form = { action: string; manifest: Record<string, unknown> };
type Gh = { app: { slug: string } | null; repos?: string[]; install?: string; form?: Form };
type Err = { error: string };
type Cell = { k: "ok" | "upd" | "behind" | "fail" | "off" | "gone"; t: string; pin?: string; why?: string };
type Tab = "releases" | "passes" | "general";
type Tone = "ok" | "bad" | "wait";
type Kind = "device" | "program" | "machine";

/** Слова отказа → строка на экране. */
function say(w: string): string {
  const t: Record<string, string> = {
    check_failed: "проверка флота не прошла",
    no_release: "такой версии нет",
    no_build: "приложение не собирается «Выпусками»",
    no_part: "такой части нет",
    cf_failed: "Cloudflare не принял",
    bad_version: "номер версии не того вида",
    name_taken: "у адреса уже есть живой пропуск — сначала отзовите прежний",
    unknown_key: "такого пропуска нет",
    not_installed: "приложение GitHub не допущено к репозиторию",
    app_exists: "приложение GitHub флота уже есть",
  };
  return t[w] ?? w;
}

/** Сборка «+n»: прежняя — «+n−1»; версия каталога — null. */
/** Порядок номеров: 1.1.10 новее 1.1.9, 1.2.0+10 новее 1.2.0+9. */
export function cmpV(a: string, b: string): number {
  const x = a.split(/[.+]/).map(Number), y = b.split(/[.+]/).map(Number);
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export function prevBuild(v: string | null | undefined): string | null {
  const m = /^(.+)\+(\d+)$/.exec(v ?? "");
  return m && Number(m[2]) > 1 ? `${m[1]}+${Number(m[2]) - 1}` : null;
}
const short = (v: string) => (v.includes("+") ? "+" + v.split("+")[1] : v);

/** QR ссылки: модули qrcode-generator рисунком на белом поле. */
function Qr({ text }: { text: string }) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return (
    <div className="st-qr" role="img" aria-label="QR ссылки для телефона" data-qr={text}>
      <svg viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
        <path d={d} fill="#000" />
      </svg>
    </div>
  );
}

/** Форма manifest уходит в браузере на github.com; GitHub вернёт страницу с ?code=. */
function PostForm({ form, sent }: { form: Form; sent(): void }) {
  const el = useRef<HTMLFormElement>(null);
  useEffect(() => {
    el.current?.submit();
    sent();
  }, []);
  return (
    <form ref={el} method="post" action={form.action} hidden>
      <input type="hidden" name="manifest" value={JSON.stringify(form.manifest)} />
    </form>
  );
}

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createSettings(): AppModule {
  let app: App;
  let list: Listed | Err | null = null;
  const kst = new Map<string, KState | Err>();
  let passes: Pass[] | Err | null = null;
  let gh: Gh | Err | null = null;
  let ghCode = "";
  let posting: Form | null = null;
  // вид экрана: вкладка выпусков, выбранная машина, отмеченные, поиск, форма приглашения, подтверждение отзыва
  let rtab: "machines" | "catalog" = "machines";
  let rm: string | null = null;
  const rsel = new Set<string>();
  let rq = "";
  let gq = "";
  let inviting: { kind: Kind; name: string; person: string } | null = null;
  let invited: { kind: Kind; invite: string; addr: string } | null = null;
  let confirm: string | null = null;
  let busy = "";
  const notes = new Map<string, { text: string; tone?: Tone }>();
  /** открытые вкладки, которым нужны ответы машин: машина пришла в roster — спросить её */
  const open = { releases: 0 };
  /** Счётчик изменений состояния модуля: его читает экран. */
  let rev = 0;
  const bump = () => {
    rev++;
    app.changed();
  };
  const note = (k: string, text: string, tone?: Tone) => {
    notes.set(k, { text, tone });
    bump();
  };
  const machines = () => (app.roster()?.machines ?? []).map((m) => m.machine);

  // ───────── данные ─────────
  async function loadList() {
    if (!app.worker("releases")) return;
    const r = await app.request<Listed>("releases.list");
    list = r.ok ? r.result : { error: r.error };
    bump();
  }
  async function loadKeeper(m: string) {
    // keeper машины отвечает сам, даже когда Host мёртв
    const r = await app.request<KState>("keeper.state", { to: `.keeper@${m}` });
    kst.set(m, r.ok ? r.result : { error: r.error });
    bump();
  }
  async function loadReleases() {
    await Promise.all([loadList(), ...machines().map(loadKeeper)]);
  }
  async function loadPasses() {
    const r = await app.request<{ passes: Array<Omit<Pass, "state"> & { state: Pass["state"] | "revoked" }> }>("keys.list");
    // отозванные не показываем (слово пользователя 3 нояб.)
    passes = r.ok ? r.result.passes.filter((p): p is Pass => p.state !== "revoked") : { error: r.error };
    bump();
  }
  async function loadGithub() {
    if (!app.worker("github")) return;
    const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname });
    gh = r.ok ? r.result : { error: r.error };
    bump();
  }

  // ───────── выпуски: что держит машина ─────────
  function planOf(m: string): Record<string, Entry> {
    return list && !("error" in list) ? (list.machines.find((x) => x.machine === m)?.plan ?? {}) : {};
  }
  function stableOf(part: string): string | null {
    return list && !("error" in list) ? (list.parts[part]?.stable ?? null) : null;
  }
  /** Последние номера части, кроме stable, новые первыми (до n). */
  function versionsOf(part: string, n: number): string[] {
    const vs = list && !("error" in list) ? (list.parts[part]?.versions ?? []) : [];
    const st = stableOf(part);
    return vs.filter((v) => v !== st).reverse().slice(0, n);
  }
  /** Ячейка матрицы: что стоит на машине против того, что ей велено (закрепление плана, иначе stable). */
  function cellOf(m: string, part: string): Cell | null {
    const st = kst.get(m);
    const pe = planOf(m)[part];
    const pin = pe?.pin;
    const want = pin ?? stableOf(part);
    const online = machines().includes(m);
    const kp = st && !("error" in st) ? (part === "keeper" && st.keeper ? { part, version: st.keeper, state: "running" } : st.parts?.find((x) => x.part === part)) : undefined;
    if (!online || !st || "error" in st) return kp || pe || want ? { k: "gone", t: kp?.version ?? want ?? "—", pin } : null;
    if (!kp && !pe) return null;
    if (pe?.on === false) return { k: "off", t: "выключена", pin };
    if (kp?.state === "failed") return { k: "fail", t: `${kp.version ?? "?"} · сбой`, pin, why: kp.error };
    if (kp?.version && want && kp.version !== want) return { k: kp.state === "starting" || kp.state === "updating" ? "upd" : "behind", t: `${kp.version} → ${want}`, pin };
    return { k: "ok", t: kp?.version ?? want ?? "—", pin };
  }
  const machineParts = () => {
    const fromList = list && !("error" in list) ? Object.entries(list.parts).filter(([, p]) => p.where === "machine").map(([n]) => n) : [];
    const seen = [...kst.values()].flatMap((s) => ("error" in s ? [] : (s.parts ?? []).map((p) => p.part)));
    const all = [...new Set([...fromList, ...seen])];
    const rank = (p: string) => (p === "host" ? 0 : p === "keeper" ? 1 : 2);
    return all.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  };
  /** Машины матрицы: на связи и те, у кого есть план. */
  const relMachines = () => {
    const planned = list && !("error" in list) ? list.machines.map((x) => x.machine) : [];
    return [...new Set([...machines(), ...planned])].sort();
  };

  async function setPlan(m: string, part: string, body: Record<string, unknown>, quiet = false) {
    const r = await app.request<{ machine: string; rev: number }>("releases.set", { machine: m, part, ...body });
    if (!r.ok) {
      note("rel", `@${m} ${part}: ${say(r.error)}`, "bad");
      return false;
    }
    if (!quiet) app.toast(`@${m}: план rev ${r.result.rev}`, "ok");
    return true;
  }
  async function pin(m: string, part: string, v: string | null) {
    if (await setPlan(m, part, { pin: v })) await Promise.all([loadList(), loadKeeper(m)]);
  }
  async function toggle(m: string, part: string) {
    const on = planOf(m)[part]?.on !== false;
    if (await setPlan(m, part, { on: !on })) await Promise.all([loadList(), loadKeeper(m)]);
  }
  async function bulk(v: string | null) {
    const ms = [...rsel];
    const done = await Promise.all(ms.map((m) => setPlan(m, "host", { pin: v }, true)));
    const ok = done.filter(Boolean).length;
    app.toast(`${ok} ${plural(ok, "машина", "машины", "машин")}: план изменён`, ok === ms.length ? "ok" : "bad");
    rsel.clear();
    bump();
    await Promise.all([loadList(), ...ms.map(loadKeeper)]);
  }
  async function deploy(part: string, version?: string) {
    busy = part;
    note("deploy", "");
    const r = await app.request<{ parts: Record<string, { from: string | null; to: string }> }>("releases.deploy", version ? { part, version } : { part });
    busy = "";
    if (!r.ok) {
      note("deploy", `Не выложен ${part}${version ? " " + version : ""}: ${say(r.error)}`, "bad");
      return;
    }
    const moved = Object.entries(r.result.parts).map(([p, x]) => `${p} ${x.from ?? "—"} → ${x.to}`);
    note("deploy", `Выложено: ${moved.join(", ")}`, "ok");
    await loadReleases();
  }

  // ───────── пропуска ─────────
  async function invite() {
    if (!inviting) return;
    const { kind, name, person } = inviting;
    const role = kind === "machine" ? "host" : "client";
    const r = await app.request<{ kid: string; invite: string; addr: string }>("keys.invite", { role, name: name.trim(), ...(role === "client" ? { person: person.trim() } : {}) });
    if (!r.ok) return note("invite", say(r.error), "bad");
    invited = { kind, invite: r.result.invite, addr: r.result.addr };
    inviting = null;
    note("invite", "");
    await loadPasses();
  }
  async function revoke(p: Pass) {
    const r = await app.request<{ addr: string }>("keys.revoke", { kid: p.id });
    confirm = null;
    bump();
    if (!r.ok) return note("passes", `${p.addr}: ${say(r.error)}`, "bad");
    app.toast(`${p.addr} отозван — соединения закрыты`, "ok");
    await loadPasses();
  }

  function copy(text: string) {
    // буфер — по нажатию; отказ браузера — словом
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (!clip) return app.toast("Буфер обмена недоступен — выделите строку");
    clip.writeText(text).then(
      () => app.toast("Скопировано", "ok"),
      () => app.toast("Буфер обмена недоступен — выделите строку"),
    );
  }

  // ───────── GitHub ─────────
  async function setup() {
    note("gh", "Сохраняю приложение…");
    const r = await app.request<{ app: { slug: string }; install: string }>("github.setup", { code: ghCode });
    if (!r.ok) return note("gh", say(r.error), "bad");
    ghCode = "";
    history.replaceState(null, "", location.pathname + location.hash);
    gh = { app: r.result.app, install: r.result.install, repos: [] };
    note("gh", "Приложение сохранено — установите его на репозитории.", "ok");
  }
  async function create(org: string) {
    let form = gh && !("error" in gh) ? gh.form : undefined;
    if (org) {
      const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname, org });
      if (!r.ok) return note("gh", say(r.error), "bad");
      form = r.result.form;
    }
    if (!form) return;
    posting = form;
    bump();
  }

  // ───────── экран ─────────
  /** Строка отказа или итога по ключу. */
  function NoteOf({ k }: { k: string }) {
    const n = notes.get(k);
    if (!n?.text) return null;
    return (
      <Note tone={n.tone} role={n.tone === "bad" ? "alert" : undefined}>
        {n.text}
      </Note>
    );
  }

  function Tabs({ tab }: { tab: Tab }) {
    const b = (k: Tab, l: string) => (
      <Btn role="tab" aria-selected={tab === k ? "true" : "false"} aria-pressed={tab === k ? "true" : "false"} data-tab={k} onClick={() => app.open("settings", { tab: k })}>
        {l}
      </Btn>
    );
    return (
      <div className="st-tabs" role="tablist">
        {b("releases", "Выпуски")}
        {b("passes", "Пропуска")}
        {b("general", "GitHub и устройство")}
      </div>
    );
  }

  // ── выпуски по машинам ──
  function Roll() {
    const on = machines();
    return (
      <Sec>
        <b>Stable флота</b>
        {["host", "keeper"].filter((p) => stableOf(p)).map((p) => {
          const n = on.filter((m) => cellOf(m, p)?.k === "ok").length;
          const back = prevBuild(stableOf(p));
          return (
            <div key={p} className="st-roll" data-roll={p}>
              <span className="st-grow">
                <b>{p}</b> <M>{stableOf(p)}</M>
              </span>
              <Meter className="st-bar" value={on.length ? Math.round((n / on.length) * 100) : 0} warn={n < on.length} />
              <Note>{`${n} из ${on.length} ${plural(on.length, "машины", "машин", "машин")}`}</Note>
              {back ? (
                <Btn disabled={busy !== ""} onClick={() => void deploy(p, back)}>
                  {`Вернуть ${short(back)}`}
                </Btn>
              ) : null}
            </div>
          );
        })}
        <NoteOf k="deploy" />
      </Sec>
    );
  }

  function Matrix() {
    const parts = machineParts();
    const q = rq.trim().toLowerCase();
    const ms = relMachines().filter((m) => !q || m.toLowerCase().includes(q));
    return (
      <Sec className="st-matrix">
        <PageHead>
          <In
            className="st-rq"
            data-f="rq"
            placeholder="Найти машину"
            aria-label="Найти машину"
            defaultValue={rq}
            onInput={(e) => {
              rq = e.currentTarget.value;
              bump();
            }}
          />
          <Note className="st-end">{`${ms.length} ${plural(ms.length, "машина", "машины", "машин")}`}</Note>
        </PageHead>
        <div className="st-scroll">
          <table className="st-mx">
            <thead>
              <tr>
                <th></th>
                <th>машина</th>
                {parts.map((p) => (
                  <th key={p}>{p}</th>
                ))}
                <th>план</th>
              </tr>
            </thead>
            <tbody>
              {ms.map((m) => {
                const st = kst.get(m);
                const online = machines().includes(m);
                const tone = !online ? "stop" : st && "error" in st ? "wait" : parts.some((p) => cellOf(m, p)?.k === "fail") ? "wait" : "idle";
                return (
                  <tr key={m} data-machine={m} aria-current={rm === m ? "true" : undefined}>
                    <td>
                      <button
                        className="st-ck"
                        role="checkbox"
                        aria-checked={rsel.has(m) ? "true" : "false"}
                        aria-label={`Выбрать ${m}`}
                        onClick={() => {
                          if (rsel.has(m)) rsel.delete(m);
                          else rsel.add(m);
                          bump();
                        }}
                      >
                        {rsel.has(m) ? "✓" : ""}
                      </button>
                    </td>
                    <td>
                      <button
                        className="st-mn"
                        onClick={() => {
                          rm = rm === m ? null : m;
                          bump();
                        }}
                      >
                        <Dot kind={tone} />
                        {`@${m}`}
                      </button>
                    </td>
                    {parts.map((p) => {
                      const c = cellOf(m, p);
                      return (
                        <td key={p} data-part={p}>
                          {c ? (
                            <span className={`st-cell ${c.k}`} title={c.why}>
                              {`${c.pin ? "📌 " : ""}${c.t}`}
                            </span>
                          ) : (
                            <Note>—</Note>
                          )}
                        </td>
                      );
                    })}
                    <td>
                      <Note>{st && !("error" in st) ? `rev ${st.rev ?? 0}` : online ? (st ? `keeper: ${st.error}` : "…") : "не на связи"}</Note>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Sec>
    );
  }

  /** Часть в плане машины: версии, закрепление, включение. Введённая версия живёт в поле. */
  function PlanPart({ m, p }: { m: string; p: string }) {
    const vin = useRef<HTMLInputElement>(null);
    const c = cellOf(m, p)!;
    const stable = stableOf(p);
    const plan = planOf(m)[p];
    const pinned = plan?.pin;
    const choices = [...new Set([...versionsOf(p, 4), pinned].filter((v): v is string => !!v && v !== stable))];
    const off = plan?.on === false;
    return (
      <div className="st-part" data-part={p}>
        <PageHead>
          <b className="st-grow">{p}</b>
          <span className={`st-cell ${c.k}`}>{c.t}</span>
        </PageHead>
        {c.why ? <Note tone="bad">{c.why}</Note> : null}
        {stable || choices.length ? (
          <Opts>
            {stable ? (
              <Btn aria-pressed={pinned ? "false" : "true"} onClick={() => void pin(m, p, null)}>
                {`stable ${short(stable)}`}
              </Btn>
            ) : null}
            {choices.map((v) => (
              <Btn key={v} aria-pressed={pinned === v ? "true" : "false"} onClick={() => void pin(m, p, v)}>
                {`📌 ${short(v)}`}
              </Btn>
            ))}
            <In ref={vin} mono className="st-ver" placeholder="версия" aria-label={`Версия ${p}`} />
            <Btn
              onClick={() => {
                const v = vin.current?.value.trim();
                if (v) void pin(m, p, v);
              }}
            >
              Закрепить
            </Btn>
          </Opts>
        ) : null}
        {p === "keeper" ? null : (
          <Opts>
            <Btn role="switch" aria-checked={off ? "false" : "true"} aria-pressed={off ? "false" : "true"} onClick={() => void toggle(m, p)}>
              {off ? "выключена" : "включена"}
            </Btn>
          </Opts>
        )}
      </div>
    );
  }

  function Plan({ m }: { m: string }) {
    const st = kst.get(m);
    return (
      <Sec className="st-side" data-plan={m}>
        <PageHead>
          <M className="st-grow">
            <b>{`@${m}`}</b>
          </M>
          {st && !("error" in st) && st.os ? <Note>{st.os}</Note> : null}
          <Btn
            aria-label="Закрыть"
            onClick={() => {
              rm = null;
              bump();
            }}
          >
            ✕
          </Btn>
        </PageHead>
        <Note>{`план rev ${st && !("error" in st) ? (st.rev ?? 0) : "—"}${machines().includes(m) ? "" : " · не на связи"}`}</Note>
        {machineParts()
          .filter((p) => cellOf(m, p))
          .map((p) => (
            <PlanPart key={p} m={m} p={p} />
          ))}
        <NoteOf k="rel" />
      </Sec>
    );
  }

  function Bulk() {
    if (!rsel.size) return null;
    const stable = stableOf("host");
    const vs = versionsOf("host", 3).filter((v) => v !== stable);
    return (
      <div className="st-bulk" data-bulk="">
        <b>{`Выбрано ${rsel.size}`}</b>
        <Note>{[...rsel].map((m) => "@" + m).join(", ")}</Note>
        <span className="st-grow" />
        {vs.map((v) => (
          <Btn key={v} onClick={() => void bulk(v)}>
            {`host: закрепить ${short(v)}`}
          </Btn>
        ))}
        <Btn onClick={() => void bulk(null)}>host: к stable</Btn>
        <Btn
          onClick={() => {
            rsel.clear();
            bump();
          }}
        >
          Снять
        </Btn>
      </div>
    );
  }

  // ── каталог и сборки ──
  function Catalog() {
    const ls = list && !("error" in list) ? list : null;
    const rows = Object.entries(ls?.parts ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const mods = Object.entries(ls?.modules ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const newer = (edge: string | null, built: Record<string, string>) => !!edge && Object.values(built).some((v) => cmpV(edge, v) > 0);
    return (
      <div className="st-cat">
        <Sec>
          <b>Части</b>
          <table className="st-tbl">
            <thead>
              <tr>
                <th>часть</th>
                <th>где</th>
                <th>stable</th>
                <th>история</th>
                <th className="st-w30"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([p, x]) => {
                // прежние номера — история части: вернуть можно любой из них
                const older = (x.versions ?? []).filter((v) => x.stable && cmpV(v, x.stable) < 0).reverse().slice(0, 3);
                return (
                  <tr key={p} data-part={p}>
                    <td>
                      <M>{p}</M>
                    </td>
                    <td>{x.where === "cloud" ? "Cloudflare" : "машины"}</td>
                    <td>
                      <M>{x.stable ?? "—"}</M>
                    </td>
                    <td>
                      <Note>
                        <M>{(x.versions ?? []).slice(-4).map(short).join(" · ")}</M>
                      </Note>
                    </td>
                    <td>
                      <Opts>
                        {x.edge && x.edge !== x.stable ? (
                          <Btn pri disabled={busy !== ""} onClick={() => void deploy(p, x.edge!)}>
                            {busy === p ? "Выкладываю…" : `Выложить ${short(x.edge)}`}
                          </Btn>
                        ) : null}
                        {older.map((v) => (
                          <Btn key={v} data-back={v} disabled={busy !== ""} onClick={() => void deploy(p, v)}>
                            {`Вернуть ${short(v)}`}
                          </Btn>
                        ))}
                      </Opts>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Sec>
        <Sec>
          <b>Модули сборок</b>
          <table className="st-tbl">
            <thead>
              <tr>
                <th>модуль</th>
                <th>входит в</th>
                <th>в сборке</th>
                <th>новее</th>
                <th className="st-w20"></th>
              </tr>
            </thead>
            <tbody>
              {mods.map(([n, x]) => (
                <tr key={n} data-module={n}>
                  <td>
                    <M>{n}</M>
                  </td>
                  <td>{x.into.join(", ")}</td>
                  <td>
                    <M>{Object.entries(x.built).map(([a, v]) => `${a} ${v}`).join(" · ") || "—"}</M>
                  </td>
                  <td>
                    <M>{newer(x.edge, x.built) ? x.edge : ""}</M>
                  </td>
                  <td>
                    {newer(x.edge, x.built) ? (
                      <Btn pri disabled={busy !== ""} onClick={() => void deploy(n, x.edge!)}>
                        {busy === n ? "Выкладываю…" : `Выложить ${x.edge}`}
                      </Btn>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Sec>
        <NoteOf k="deploy" />
      </div>
    );
  }

  function Releases() {
    if (!app.worker("releases")) return <Note>«Выпусков» во флоте нет</Note>;
    const pick = (k: "machines" | "catalog", l: string) => (
      <Btn
        aria-pressed={rtab === k ? "true" : "false"}
        onClick={() => {
          rtab = k;
          bump();
        }}
      >
        {l}
      </Btn>
    );
    const sub = (
      <div className="st-tabs">
        {pick("machines", "По машинам")}
        {pick("catalog", "Каталог и сборки")}
      </div>
    );
    if (list && "error" in list) {
      return (
        <>
          {sub}
          <Note tone="bad" role="alert">{`releases.list: ${list.error}`}</Note>
        </>
      );
    }
    if (!list) {
      return (
        <>
          {sub}
          <Note>…</Note>
        </>
      );
    }
    if (rtab === "catalog") {
      return (
        <>
          {sub}
          <Catalog />
        </>
      );
    }
    return (
      <>
        {sub}
        <Roll />
        <Bulk />
        <div className="st-grid">
          <Matrix />
          {rm ? <Plan key={rm} m={rm} /> : <span />}
        </div>
      </>
    );
  }

  // ── пропуска ──
  function InviteForm() {
    const f = inviting!;
    const kind = (k: Kind, l: string) => (
      <Btn
        aria-pressed={f.kind === k ? "true" : "false"}
        onClick={() => {
          f.kind = k;
          bump();
        }}
      >
        {l}
      </Btn>
    );
    return (
      <Sec data-invite="">
        <Opts>
          {kind("device", "устройство")}
          {kind("program", "программа")}
          {kind("machine", "машина")}
        </Opts>
        <Opts>
          <In data-f="iname" placeholder={f.kind === "machine" ? "имя машины" : "laptop"} aria-label="Имя" defaultValue={f.name} onInput={(e) => void (f.name = e.currentTarget.value)} />
          {f.kind === "machine" ? null : <In data-f="iwho" placeholder="почта" aria-label="Почта" defaultValue={f.person} onInput={(e) => void (f.person = e.currentTarget.value)} />}
        </Opts>
        <Opts>
          <Btn pri onClick={() => void invite()}>
            Пригласить
          </Btn>
          <Btn
            onClick={() => {
              inviting = null;
              bump();
            }}
          >
            Отмена
          </Btn>
        </Opts>
        <NoteOf k="invite" />
      </Sec>
    );
  }

  function Invited() {
    const x = invited!;
    // устройству — ссылка на пульт и на телефон (адрес страницы телефона — из сборки); копирует человек нужную
    const phone = app.worker("phone");
    const rows: Array<[string | null, string]> =
      x.kind === "device"
        ? [["Пульт", `${location.origin}${location.pathname}#invite=${x.invite}`], ...(phone ? [["Телефон", new URL(`#invite=${x.invite}`, phone).href] as [string, string]] : [])]
        : [[null, x.invite]];
    // QR — ссылки на телефон: её сканируют телефоном; колонка справа, в узком окне — под ссылками
    const toPhone = rows.find(([l]) => l === "Телефон")?.[1];
    return (
      <Sec tone="ok" data-invited="">
        <div className="st-inv">
          <div className="st-invl">
            <span>
              {x.kind === "device" ? "Ссылка для " : x.kind === "program" ? "Приглашение для " : "Приглашение машины "}
              <b>
                <M>{x.addr}</M>
              </b>
            </span>
            {rows.map(([l, text]) => (
              <Opts key={text} data-link={l ?? ""}>
                {l ? <b className="st-lbl">{l}</b> : null}
                <Cmd className="st-link">{text}</Cmd>
                <Btn pri onClick={() => copy(text)}>
                  Копировать
                </Btn>
              </Opts>
            ))}
            <Opts>
              <Btn
                onClick={() => {
                  invited = null;
                  bump();
                }}
              >
                Готово
              </Btn>
            </Opts>
          </div>
          {toPhone ? <Qr text={toPhone} /> : null}
        </div>
      </Sec>
    );
  }

  function PassTable({ title, rows, me }: { title: string; rows: Pass[]; me: Pass | undefined }) {
    if (!rows.length) return null;
    const word = { ok: ["действует", "ok"], wait: ["ждёт приёма", "wait"] } as const;
    return (
      <Sec data-passes={title}>
        <b>{title}</b>
        <table className="st-tbl">
          <colgroup>
            <col className="st-w28" />
            <col className="st-w16" />
            <col className="st-w22" />
            <col className="st-w14" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>адрес</th>
              <th>состояние</th>
              <th>кто пригласил</th>
              <th>когда</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} data-pass={p.id}>
                <td>
                  <M>{p.addr}</M>
                </td>
                <td>
                  <Pill tone={word[p.state][1]}>{word[p.state][0]}</Pill>
                </td>
                <td>
                  <M>{p.by}</M>
                </td>
                <td>{new Date(p.at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</td>
                <td>
                  {p === me ? (
                    <Note>это устройство</Note>
                  ) : confirm === p.id ? (
                    <Opts>
                      <Btn bad onClick={() => void revoke(p)}>
                        Отозвать
                      </Btn>
                      <Btn
                        onClick={() => {
                          confirm = null;
                          bump();
                        }}
                      >
                        Отмена
                      </Btn>
                    </Opts>
                  ) : (
                    <Btn
                      bad
                      onClick={() => {
                        confirm = p.id;
                        bump();
                      }}
                    >
                      Отозвать…
                    </Btn>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Sec>
    );
  }

  function Passes() {
    const ps = passes && !("error" in passes) ? passes : [];
    const me = ps.find((p) => p.role === "client" && p.name === app.name && p.state === "ok");
    return (
      <>
        <Opts>
          {inviting || invited ? null : (
            <Btn
              pri
              onClick={() => {
                inviting = { kind: "device", name: "", person: "" };
                bump();
              }}
            >
              Пригласить
            </Btn>
          )}
        </Opts>
        {inviting ? <InviteForm /> : invited ? <Invited /> : null}
        {passes && "error" in passes ? (
          <Note tone="bad" role="alert">{`keys.list: ${passes.error}`}</Note>
        ) : passes ? null : (
          <Note>…</Note>
        )}
        <PassTable title="Машины" rows={ps.filter((p) => p.role === "host")} me={me} />
        <PassTable title="Устройства и программы" rows={ps.filter((p) => p.role === "client")} me={me} />
        <NoteOf k="passes" />
      </>
    );
  }

  // ── GitHub и устройство ──
  function GhCreate() {
    const org = useRef("");
    return (
      <Opts>
        <In mono data-f="org" placeholder="организация" aria-label="Организация" onInput={(e) => void (org.current = e.currentTarget.value)} />
        <Btn pri onClick={() => void create(org.current.trim())}>
          Создать приложение GitHub
        </Btn>
      </Opts>
    );
  }

  function GhApp({ value }: { value: Gh }) {
    const repos = value.repos ?? [];
    const q = gq.trim().toLowerCase();
    const shown = repos.filter((r) => !q || r.toLowerCase().includes(q));
    return (
      <>
        <PageHead>
          <M className="st-grow">
            <b>{value.app!.slug}</b>
          </M>
          <Pill tone="ok">{`${repos.length} ${plural(repos.length, "репозиторий", "репозитория", "репозиториев")}`}</Pill>
          {value.install ? (
            <LinkBtn href={value.install} target="_blank" rel="noopener">
              Доступ на GitHub ↗
            </LinkBtn>
          ) : null}
        </PageHead>
        {repos.length ? (
          <Opts className="st-nowrap">
            <In
              className="st-grow"
              data-f="gq"
              placeholder="Найти репозиторий"
              aria-label="Найти репозиторий"
              defaultValue={gq}
              onInput={(e) => {
                gq = e.currentTarget.value;
                bump();
              }}
            />
          </Opts>
        ) : null}
        {repos.length ? (
          <div className="st-repos">
            {shown.length ? (
              shown.map((r) => (
                <div key={r} className="st-repo" data-repo={r}>
                  <M className="st-grow">{r}</M>
                </div>
              ))
            ) : (
              <Note className="st-repo">Таких нет</Note>
            )}
          </div>
        ) : null}
      </>
    );
  }

  function Github() {
    if (!app.worker("github")) return null;
    return (
      <Sec data-github="">
        <b>Приложение GitHub флота</b>
        {ghCode ? (
          <>
            <span>GitHub вернул код нового приложения.</span>
            <Opts>
              <Btn pri onClick={() => void setup()}>
                Сохранить приложение
              </Btn>
            </Opts>
          </>
        ) : !gh ? (
          <Note>…</Note>
        ) : "error" in gh ? (
          <Note tone="bad">{`github.app: ${gh.error}`}</Note>
        ) : gh.app ? (
          <GhApp value={gh} />
        ) : (
          <GhCreate />
        )}
        <NoteOf k="gh" />
      </Sec>
    );
  }

  function Device() {
    const ps = passes && !("error" in passes) ? passes : [];
    const me = ps.find((p) => p.role === "client" && p.name === app.name);
    const push = app.use(() => app.mark("alerts.state"));
    const pw: Record<string, string> = { on: "включены", ask: "выключены", error: "не включились", working: "включаю…", denied: "запрещены в браузере", off: "браузер не умеет" };
    return (
      <Sec data-device="">
        <b>Это устройство</b>
        <Row label="адрес">
          <M>{me?.addr ?? app.name}</M>
        </Row>
        <Row label="пропуск">
          <span>
            {me ? (me.state === "ok" ? "действует" : "ждёт приёма") : "—"}
            {app.wide ? (
              <Btn className="st-ml8" onClick={() => app.open("settings", { tab: "passes" })}>
                Пропуска
              </Btn>
            ) : null}
          </span>
        </Row>
        <Row label="уведомления">
          <span data-push={push ?? ""}>{pw[push ?? ""] ?? "—"}</span>
        </Row>
      </Sec>
    );
  }

  function Settings({ params }: ScreenProps) {
    const tab: Tab = !app.wide ? "general" : params.tab === "passes" || params.tab === "general" ? params.tab : "releases";
    // при открытии: машина из адреса и код GitHub из адреса — до первого рисунка
    useState(() => {
      if (params.machine) rm = params.machine;
      ghCode = new URLSearchParams(location.search).get("code") ?? "";
    });
    // состояние модуля и машины на связи: новая машина появляется в матрице
    app.use(() => rev);
    app.use(machines);

    useEffect(() => {
      const shown = tab === "releases";
      if (shown) open.releases++;
      // при открытии — ответы владельцев своей вкладки
      if (tab === "releases") void loadReleases();
      if (tab === "passes" || tab === "general") void loadPasses();
      if (tab === "general" && app.wide) void loadGithub();
      return () => {
        if (shown) open.releases--;
      };
    }, []);

    return (
      <Page>
        <PageHead title="Настройки">{app.wide ? <Tabs tab={tab} /> : null}</PageHead>
        {tab === "releases" ? (
          <Releases />
        ) : tab === "passes" ? (
          <Passes />
        ) : (
          <>
            {app.wide ? <Github /> : null}
            <Device />
          </>
        )}
        {posting ? (
          <PostForm
            form={posting}
            sent={() => {
              posting = null;
            }}
          />
        ) : null}
      </Page>
    );
  }

  return {
    on: {
      roster(r: Roster) {
        // машина пришла (или вернулась) при открытой вкладке — её keeper; закрытая вкладка спросит сама
        for (const m of r.machines.map((x) => x.machine)) {
          if (open.releases && !kst.has(m)) void loadKeeper(m);
        }
      },
    },
    screens: {
      settings: {
        nav: "Настройки",
        group: "Флот",
        label: "Настройки",
        view: Settings,
        head: () => ({ title: "Настройки" }),
        find: (q: string) =>
          [
            ["releases", "Выпуски"],
            ["passes", "Пропуска"],
            ["general", "GitHub и устройство"],
          ]
            .filter(([, l]) => !q || l.toLowerCase().includes(q))
            .map(([tab, l]) => ({ label: `Настройки: ${l.toLowerCase()}`, hint: "Флот", screen: "settings", params: { tab } })),
      },
    },
    css,
    start(a) {
      app = a;
    },
  };
}
