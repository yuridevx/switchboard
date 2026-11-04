// Карточка на телефоне: вкладки чат, вставки места card.tab, видные этой сессии, и «Ещё» — сведения, модель и усилие, действия.
import { useState } from "react";
import type { Params } from "@switchboard/web-core";
import { BadCard, Btn, EFFORTS, failText, MODELS, Opts, Pad, profileIdOf, remoteOf, slotOf, useApp, Tabs } from "@switchboard/web-ui";
import { machineOf } from "@switchboard/protocol";
import { useCan, useSession, useSessionActions } from "./hooks.ts";
import { Names } from "./Names.tsx";
import { isDown, tabIn } from "./session.ts";

/** «Ещё» на телефоне. */
function Info({ callsign, openNames }: { callsign: string; openNames(): void }) {
  const app = useApp();
  const s = useSession(callsign);
  const can = useCan(machineOf(callsign) ?? "");
  const menu = app.use(() => app.placed("card.menu", { callsign }));
  // модель и усилие, пуск и остановка — один путь; отказ — словом ниже
  const { busy, error, act } = useSessionActions(callsign);
  const update = (body: Record<string, string>) => act("session.update", body);

  const rows: Array<[string, unknown]> = s
    ? [
        ["адрес", callsign],
        ["папка", s.dir],
        ["слот", slotOf(s)?.name],
        ["аккаунт", s.account],
        ["профиль", profileIdOf(s)],
        ["сбой", s.failed ? failText(s) : undefined],
      ]
    : [["адрес", callsign]];
  const remote = remoteOf(s);
  const down = isDown(s);
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
      <Btn className="card-act" data-act="names" onClick={openNames}>
        Имена
      </Btn>
      {/* пункты места card.menu: закрепление (web-board) */}
      {menu.map((x) => (
        <Btn key={x.name} className="card-act" data-screen={x.name} onClick={() => app.run(x.name, { callsign })}>
          {x.label}
        </Btn>
      ))}
      {remote ? (
        <a className="card-act" href={remote} target="_blank" rel="noopener">
          Открыть в claude.ai
        </a>
      ) : null}
      {s && !down && can("session.stop") ? (
        <Btn className="card-act" disabled={!!busy} onClick={() => void act("session.stop")}>
          {busy === "session.stop" ? "Останавливаю…" : "Остановить"}
        </Btn>
      ) : null}
      {s && down && can("session.start") ? (
        <Btn className="card-act" disabled={!!busy} onClick={() => void act("session.start")}>
          {busy === "session.start" ? "Запускаю…" : "Запустить"}
        </Btn>
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
  const list: Array<[string, string]> = [["chat", "Чат"], ...placed.map((t): [string, string] => [t.name, t.label]), ["info", "Ещё"]];
  const tab = tabIn(picked, list, "chat");
  return (
    <>
      <Tabs className="card-tabs" tabs={list} cur={tab} pick={setPicked} />
      <div className="card-place">{tab === "info" ? <Info callsign={callsign} openNames={() => setNames(true)} /> : <app.Slot key={tab} screen={tab} params={{ callsign }} />}</div>
      {names ? <Names callsign={callsign} close={() => setNames(false)} /> : null}
    </>
  );
}
