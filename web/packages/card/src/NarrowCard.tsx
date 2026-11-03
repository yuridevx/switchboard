// Карточка на телефоне: вкладки чат, вставки места card.tab, видные этой сессии, и «Ещё» — сведения, модель и усилие, действия.
import { useState } from "react";
import { useApp, type Params } from "@switchboard/web-core";
import { BadCard, Btn, EFFORTS, MODELS, Opts, Pad } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";
import { useCan, useSession } from "./context.ts";
import { Names } from "./Names.tsx";
import { failedText, profileOf, slotOf } from "./session.ts";

/** «Ещё» на телефоне. */
function Info({ callsign, openNames }: { callsign: string; openNames(): void }) {
  const app = useApp();
  const s = useSession(callsign);
  const can = useCan(machineOf(callsign) ?? "");
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
        ["слот", slotOf(s)?.name],
        ["аккаунт", s.account],
        ["профиль", profileOf(s)],
        ["сбой", s.failed ? failedText(s) : undefined],
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

export function NarrowCard({ params }: { params: Params }) {
  const app = useApp();
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
      {names ? <Names callsign={callsign} close={() => setNames(false)} /> : null}
    </>
  );
}
