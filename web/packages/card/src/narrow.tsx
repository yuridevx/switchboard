// Карточка на телефоне: вкладки «Чат» и «Ещё»; правило кнопок пуска и стопа — одно на оба вида.
import { useState } from "react";
import { machineOf } from "@switchboard/protocol";
import type { ScreenProps } from "@switchboard/web-core";
import { BadCard, Btn, EFFORTS, failText, isLive, MODELS, Opts, Pad, profileIdOf, sessionOf, slotOf, Tabs, useApp, wingOf, type Result } from "@switchboard/web-ui";
import { Feeds, PairPick } from "./pair.tsx";

/** Какая кнопка у сессии: запуск или стоп; машина не умеет — кнопки нет. */
export function useControl(callsign: string) {
  const app = useApp();
  const machine = machineOf(callsign)!;
  return app.use(() => {
    const s = sessionOf(app, callsign);
    if (isLive(s?.state)) return app.can(machine, "session.stop") ? ("stop" as const) : null;
    return (s?.state === "stopped" || s?.state === "failed") && app.can(machine, "session.start") ? ("start" as const) : null;
  });
}

/** Запрос о сессии: пока идёт — кнопки неактивны; отказ — слово «запрос: отказ», следующее действие его снимает. */
export function useAct(callsign: string) {
  const app = useApp();
  const [busy, setBusy] = useState("");
  const [word, setWord] = useState("");
  async function act<T>(name: string, body: Record<string, unknown> = {}): Promise<Result<T>> {
    setBusy(name);
    setWord("");
    const r = await app.request<T>(name, { callsign, ...body });
    setBusy("");
    if (!r.ok) setWord(`${name}: ${r.error}`);
    return r;
  }
  return { busy, word, act };
}

export function Control({ kind, busy, act, className }: { kind: "start" | "stop" | null; className?: string } & Pick<ReturnType<typeof useAct>, "busy" | "act">) {
  if (!kind) return null;
  const name = kind === "start" ? "session.start" : "session.stop";
  const [idle, working] = kind === "start" ? ["Запустить", "Запускаю…"] : ["Остановить", "Останавливаю…"];
  return (
    <Btn className={className} disabled={!!busy} onClick={() => void act(name)}>
      {busy === name ? working : idle}
    </Btn>
  );
}

function Info({ callsign }: { callsign: string }) {
  const app = useApp();
  const machine = machineOf(callsign)!;
  const s = app.use(() => sessionOf(app, callsign));
  const update = app.use(() => app.can(machine, "session.update") === true);
  const placed = app.use(() => app.placed("card.menu", { callsign }));
  const control = useControl(callsign);
  const { busy, word, act } = useAct(callsign);
  const [names, setNames] = useState(false);
  const wing = app.use(() => wingOf(app.roster()?.sessions ?? [], callsign));
  const facts = (x: typeof s, cs: string): Array<[string, unknown]> => [["адрес", cs], ["папка", x?.dir], ["слот", slotOf(x)?.name], ["аккаунт", x?.account], ["профиль", profileIdOf(x)], ["сбой", x && failText(x)]];
  return (
    <Pad>
      {[[s, callsign] as const, ...(wing ? [[wing, wing.callsign] as const] : [])].map(([x, cs]) => (
        <dl key={cs} className="card-info">
          {facts(x, cs).filter(([, v]) => v).flatMap(([k, v]) => [<dt key={k}>{k}</dt>, <dd key={`${k}=`}>{String(v)}</dd>])}
        </dl>
      ))}
      {s && update && (
        <div className="card-pick">
          <Opts data-pick="model">
            {MODELS.map((m) => (
              <Btn key={m} aria-pressed={m === s.model} disabled={!!busy} onClick={() => void act("session.update", { model: m })}>
                {m}
              </Btn>
            ))}
          </Opts>
          <Opts data-pick="effort">
            {EFFORTS.map(([e, name]) => (
              <Btn key={e} aria-pressed={e === s.effort} disabled={!!busy} onClick={() => void act("session.update", { effort: e })}>
                {name}
              </Btn>
            ))}
          </Opts>
        </div>
      )}
      {placed.map((p) => (
        <Btn key={p.name} className="card-act" data-screen={p.name} onClick={() => app.run(p.name, { callsign })}>
          {p.label}
        </Btn>
      ))}
      <Btn className="card-act" data-act="names" onClick={() => setNames(true)}>
        Имена
      </Btn>
      <Control className="card-act" kind={control} busy={busy} act={act} />
      {word && (
        <BadCard role="alert">
          <b>Не вышло</b>
          <code>{word}</code>
        </BadCard>
      )}
      {names && <app.Slot screen="labels" params={{ callsign }} close={() => setNames(false)} />}
    </Pad>
  );
}

export function NarrowCard({ params }: ScreenProps) {
  const app = useApp();
  const { callsign } = params;
  const [tab, setTab] = useState(params.tab === "info" ? "info" : "chat");
  const placed = app.use(() => app.placed("card.tab", { callsign }));
  const lead = app.use(() => sessionOf(app, callsign));
  const wing = app.use(() => wingOf(app.roster()?.sessions ?? [], callsign));
  const tabs: Array<[string, string]> = [["chat", "Чат"], ...placed.map((p): [string, string] => [p.name, p.label]), ["info", "Ещё"]];
  return (
    <>
      <div className="card-tabrow">
        <Tabs className="card-tabs" tabs={tabs} cur={tab} pick={setTab} />
        {tab === "chat" && lead && wing ? <PairPick lead={lead} wing={wing} /> : null}
      </div>
      <div className="card-place">{tab === "info" ? <Info callsign={callsign} /> : tab === "chat" ? <Feeds callsign={callsign} wide={false} /> : <app.Slot screen={tab} params={{ callsign }} />}</div>
    </>
  );
}
