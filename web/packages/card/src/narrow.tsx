// Карточка на телефоне: вкладки «Чат» и «Ещё»; правило кнопок пуска и стопа — одно на оба вида.
import { useState } from "react";
import { machineOf } from "@switchboard/protocol";
import type { ScreenProps } from "@switchboard/web-core";
import { BadCard, Btn, EFFORTS, failText, MODELS, Opts, Pad, profileIdOf, sessionOf, slotOf, Tabs, useApp, type Result } from "@switchboard/web-ui";

const words = (s: { state?: unknown }) => (["stopped", "failed"].includes(s.state as string) ? ("start" as const) : ("stop" as const));

/** Какая кнопка у сессии: запуск или стоп; машина не умеет — кнопки нет. */
export function useControl(callsign: string) {
  const app = useApp();
  const machine = machineOf(callsign)!;
  return app.use(() => {
    const s = sessionOf(app, callsign);
    if (!s) return null;
    const kind = words(s);
    return app.can(machine, kind === "start" ? "session.start" : "session.stop") ? kind : null;
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
  const facts: Array<[string, unknown]> = [["адрес", callsign], ["папка", s?.dir], ["слот", slotOf(s)?.name], ["аккаунт", s?.account], ["профиль", profileIdOf(s)], ["сбой", s && failText(s)]];
  return (
    <Pad>
      <dl className="card-info">
        {facts.filter(([, v]) => v).flatMap(([k, v]) => [<dt key={k}>{k}</dt>, <dd key={`${k}=`}>{String(v)}</dd>])}
      </dl>
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
        <BadCard>
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
  const tabs: Array<[string, string]> = [["chat", "Чат"], ...placed.map((p): [string, string] => [p.name, p.label]), ["info", "Ещё"]];
  return (
    <>
      <Tabs className="card-tabs" tabs={tabs} cur={tab} pick={setTab} />
      <div className="card-place">{tab === "info" ? <Info callsign={callsign} /> : <app.Slot screen={tab} params={{ callsign }} />}</div>
    </>
  );
}
