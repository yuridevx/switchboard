// Узкая карточка: «Чат» и «Ещё» — поля roster, модель и усилие, имена, пункты места, пуск и стоп.
import { useState } from "react";
import { machineOf } from "@switchboard/protocol";
import { BadCard, Btn, EFFORTS, failText, isLive, MODELS, Opts, Pad, profileIdOf, sessionOf, slotOf, Tabs, useApp } from "@switchboard/web-ui";

const TABS = [["chat", "Чат"], ["info", "Ещё"]] as const;

export function NarrowCard({ callsign, tab }: { callsign: string; tab?: string }) {
  const app = useApp();
  const machine = machineOf(callsign) ?? "";
  const session = app.use(() => sessionOf(app, callsign));
  const placed = app.use(() => app.placed("card.menu", { callsign }));
  const canUpdate = app.use(() => app.can(machine, "session.update") === true);
  const canStop = app.use(() => app.can(machine, "session.stop") === true);
  const canStart = app.use(() => app.can(machine, "session.start") === true);
  const [cur, setCur] = useState<"chat" | "info">(tab === "info" ? "info" : "chat");
  const [names, setNames] = useState(false);
  const [busy, setBusy] = useState("");
  const [word, setWord] = useState("");

  async function act(name: string, body: Record<string, unknown> = {}) {
    setWord("");
    setBusy(name);
    const r = await app.request(name, { callsign, ...body });
    setBusy("");
    if (!r.ok) setWord(`${name}: ${r.error}`);
  }

  const rows: Array<[string, unknown]> = session
    ? [["адрес", callsign], ["папка", session.dir], ["слот", slotOf(session)?.name], ["аккаунт", session.account], ["профиль", profileIdOf(session)], ["сбой", failText(session)]]
    : [["адрес", callsign]];
  const live = isLive(session?.state);

  return (
    <>
      <Tabs className="card-tabs" tabs={TABS} cur={cur} pick={setCur} />
      <div className="card-place">
        {cur === "chat" ? (
          <app.Slot screen="chat" params={{ callsign }} />
        ) : (
          <Pad>
            <dl className="card-info">
              {rows
                .filter(([, v]) => v)
                .flatMap(([k, v]) => [<dt key={`t${k}`}>{k}</dt>, <dd key={`d${k}`}>{String(v)}</dd>])}
            </dl>
            {session && canUpdate ? (
              <div className="card-pick">
                <Opts data-pick="model">
                  {MODELS.map((m) => (
                    <Btn key={m} aria-pressed={session.model === m ? "true" : "false"} disabled={!!busy} onClick={() => void act("session.update", { model: m })}>
                      {m}
                    </Btn>
                  ))}
                </Opts>
                <Opts data-pick="effort">
                  {EFFORTS.map(([k, label]) => (
                    <Btn key={k} aria-pressed={session.effort === k ? "true" : "false"} disabled={!!busy} onClick={() => void act("session.update", { effort: k })}>
                      {label}
                    </Btn>
                  ))}
                </Opts>
              </div>
            ) : null}
            <Btn className="card-act" data-act="names" onClick={() => setNames(true)}>
              Имена
            </Btn>
            {placed.map((p) => (
              <Btn key={p.name} className="card-act" data-screen={p.name} onClick={() => app.run(p.name, { callsign })}>
                {p.label}
              </Btn>
            ))}
            {live && canStop ? (
              <Btn className="card-act" disabled={!!busy} onClick={() => void act("session.stop")}>
                {busy === "session.stop" ? "Останавливаю…" : "Остановить"}
              </Btn>
            ) : null}
            {session && !live && canStart ? (
              <Btn className="card-act" disabled={!!busy} onClick={() => void act("session.start")}>
                {busy === "session.start" ? "Запускаю…" : "Запустить"}
              </Btn>
            ) : null}
            {word ? (
              <BadCard role="alert">
                <b>Не вышло</b>
                <code>{word}</code>
              </BadCard>
            ) : null}
          </Pad>
        )}
      </div>
      {names ? <app.Slot screen="labels" params={{ callsign }} close={() => setNames(false)} /> : null}
    </>
  );
}
