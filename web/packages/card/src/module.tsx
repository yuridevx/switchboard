// web-card — карточка сессии: шапка из roster, вкладки «Чат» (экран chat в месте карточки), вкладки места card.tab
// и «Сведения» (поля roster как прислали владельцы; остановить и поднять — если они есть в contract машины).
// Широкий вид (пульт) — src/wide.tsx: шапка в одну строку, «Настройки», «Журнал» и вкладки места card.tab;
// «Сведения сбоку» — выбор устройства, раздел хранилища info.
import { useEffect, useState } from "react";
import type { App, AppModule, Head, ScreenProps } from "@switchboard/web-core";
import { BadCard, Btn, EFFORTS, MODELS, Opts, Pad, projectOf, stateLabel } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";
import css from "./card.css";
import { HEAD0, machineName, Names, sessionName, useCan, useSession, Wide, wideHead, type HeadView, type WideOpts } from "./wide.tsx";

/** Единицы шапки в панели вида «Работы». */
const UNITS: Array<[keyof HeadView, string, string]> = [["haddr", "Адрес", "Адрес сессии"], ["howner", "Владелец", "Владелец в шапке"], ["hprof", "Профиль", "Профиль в шапке"], ["hmodel", "Модель", "Модель и усилие в шапке"]];

/** Новый модуль со своей памятью (в выпуске — один; в тестах — на каждый прогон). */
export function createCard(): AppModule {
  let app: App;
  /** сведения сбоку в широкой карточке — выбор этого устройства */
  let info = false;
  /** что показывать в шапке карточки пульта — выбор этого устройства */
  let head: HeadView = { ...HEAD0 };
  const opts: WideOpts = {
    head: () => head,
    info: () => info,
    setInfo: (v: boolean) => {
      info = v;
      void app.store<boolean>("card.info").set(v);
      app.changed();
    },
  };

  /** «Ещё» на телефоне: сведения, модель и усилие, действия. */
  function Info({ callsign, openNames }: { callsign: string; openNames(): void }) {
    const s = useSession(app, callsign);
    const can = useCan(app, machineOf(callsign) ?? "");
    const menu = app.use(() => app.placed("card.menu", { callsign }));
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");

    /** модель и усилие — session.update; отказ — словом ниже */
    async function update(body: Record<string, string>) {
      setBusy("session.update");
      setError("");
      const r = await app.request("session.update", { callsign, ...body });
      setBusy("");
      if (!r.ok) setError(`session.update: ${r.error}`);
    }

    async function act(name: "session.stop" | "session.start") {
      setBusy(name);
      setError("");
      const r = await app.request(name, { callsign });
      setBusy("");
      if (!r.ok) setError(`${name}: ${r.error}`);
    }

    const rows: Array<[string, unknown]> = s
      ? [
          ["адрес", callsign],
          ["папка", s.dir],
          ["слот", (s.slot as { name?: string } | undefined)?.name],
          ["аккаунт", s.account],
          ["профиль", (s.profile as { id?: string } | null | undefined)?.id],
          ["сбой", s.failed ? Object.entries(s.failed as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join("; ") : undefined],
        ]
      : [["адрес", callsign]];
    const remote = typeof s?.remote === "string" ? s.remote : (s?.remote as { url?: string } | undefined)?.url;
    const stopped = s?.state === "stopped";
    return (
      <Pad>
        <dl className="card-info">
          {rows
            .filter(([, v]) => v !== undefined && v !== null && v !== "")
            .flatMap(([k, v]) => [<dt key={`t:${k}`}>{k}</dt>, <dd key={`d:${k}`}>{String(v)}</dd>])}
        </dl>
        {s && can("session.update") ? (
          <div className="card-pick">
            <Opts data-pick="model">
              {MODELS.map((m) => (
                <Btn key={m} aria-pressed={s.model === m ? "true" : "false"} disabled={!!busy} onClick={() => void update({ model: m })}>
                  {m}
                </Btn>
              ))}
            </Opts>
            <Opts data-pick="effort">
              {EFFORTS.map(([k, l]) => (
                <Btn key={k} aria-pressed={s.effort === k ? "true" : "false"} disabled={!!busy} onClick={() => void update({ effort: k })}>
                  {l}
                </Btn>
              ))}
            </Opts>
          </div>
        ) : null}
        <button className="card-act" data-act="names" onClick={openNames}>
          Имена
        </button>
        {/* пункты места card.menu: закрепление (web-board) */}
        {menu.map((x) => (
          <button key={x.screen} className="card-act" data-screen={x.screen} onClick={() => app.open(x.screen, { from: callsign })}>
            {x.label}
          </button>
        ))}
        {remote ? (
          <a className="card-act" href={remote} target="_blank" rel="noopener">
            Открыть в claude.ai
          </a>
        ) : null}
        {s && !stopped && can("session.stop") ? (
          <button className="card-act" disabled={!!busy} onClick={() => void act("session.stop")}>
            {busy === "session.stop" ? "Останавливаю…" : "Остановить"}
          </button>
        ) : null}
        {s && stopped && can("session.start") ? (
          <button className="card-act" disabled={!!busy} onClick={() => void act("session.start")}>
            {busy === "session.start" ? "Поднимаю…" : "Поднять"}
          </button>
        ) : null}
        {error ? (
          <BadCard role="alert">
            <b>Не вышло</b>
            <code>{error}</code>
          </BadCard>
        ) : null}
      </Pad>
    );
  }

  /** Карточка на телефоне: вкладки чат, вставки места card.tab, видные этой сессии, сведения. */
  function Narrow({ params }: ScreenProps) {
    const callsign = params.callsign ?? "";
    const [picked, setPicked] = useState(params.tab ?? "chat");
    const [names, setNames] = useState(false);
    const placed = app.use(() => app.placed("card.tab", { callsign }));
    const list: Array<[string, string]> = [["chat", "Чат"], ...placed.map((t): [string, string] => [t.screen, t.label]), ["info", "Ещё"]];
    const tab = list.some(([k]) => k === picked) ? picked : "chat";
    return (
      <>
        <div className="card-tabs" role="tablist">
          {list.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k ? "true" : "false"} data-tab={k} onClick={() => setPicked(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="card-place">{tab === "info" ? <Info callsign={callsign} openNames={() => setNames(true)} /> : <app.Slot key={tab} screen={tab} params={{ callsign }} />}</div>
        {names ? <Names app={app} callsign={callsign} close={() => setNames(false)} /> : null}
      </>
    );
  }

  function Card(p: ScreenProps) {
    return app.wide ? <Wide app={app} params={p.params} o={opts} /> : <Narrow {...p} />;
  }

  function cardHead(params: Record<string, string>): Head {
    const callsign = params.callsign ?? "";
    if (app.wide) return wideHead(app, callsign);
    const s = app.roster()?.sessions.find((x) => x.callsign === callsign);
    const name = sessionName(app, callsign);
    const at = machineName(app, machineOf(callsign) ?? "").text;
    if (!s) return { title: name.text, mono: !name.human, sub: `${at} не на связи` };
    // лампа без слов: состояние понятно по индикатору
    return { title: name.text, mono: !name.human, sub: `${at} · ${projectOf(s.dir)}`, dot: s.state === "failed" ? "bad" : stateLabel(s.state).dot };
  }

  const save = (next: HeadView) => {
    head = next;
    void app.store<HeadView>("card.head").set(head);
    app.changed();
  };

  /** Группа «Шапка» в панели вида «Работы». params.reset — номер сброса панели: новый номер, не «0», возвращает встроенное. */
  function HeadPanel({ params }: ScreenProps) {
    const v = app.use(() => head);
    useEffect(() => {
      if (params.reset && params.reset !== "0") save({ ...HEAD0 });
    }, []);
    return (
      <div className="vw-g">
        <span className="vw-t">Шапка</span>
        <div className="vw-c">
          {UNITS.map(([k, label, full]) => (
            <button key={k} data-v={k} aria-label={full} aria-pressed={String(v[k]) as "true" | "false"} onClick={() => save({ ...head, [k]: !head[k] })}>
              {label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return {
    screens: {
      card: { label: "Карточка", view: Card, head: cardHead },
      // группа «Шапка» в панели вида «Работы»: настройки шапки — у карточки
      "card.view": { label: "Шапка", path: "card-view", view: HeadPanel },
    },
    css,
    store: ["card.info", "card.head"],
    async start(a) {
      app = a;
      info = (await app.store<boolean>("card.info").get()) === true;
      head = { ...HEAD0, ...(await app.store<HeadView>("card.head").get()) };
    },
  };
}
