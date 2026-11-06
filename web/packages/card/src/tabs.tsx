// Вкладки широкой карточки: «Настройки» и «Журнал». Раздел настроек виден, если машина умеет его запрос.
import { useEffect, useRef, useState } from "react";
import { Btn, Chip, Chips, CommitIn, Confirm, isLive, midnight, Outcome, permModeName, permModesOf, sessionOf, Switch, useApp, useMachineLoad, useOutcome, wingOf, type AccountsAnswer, type JournalAnswer, type JournalRecord, type ModelInfo } from "@switchboard/web-ui";
import { Control, useAct, useControl } from "./narrow.tsx";
import { PairSet, Refused } from "./settings.tsx";

type Load<T> = { data?: T; error: string };

/** Смена с итогом в своём разделе: слово отказа или «после хода». */
function useChange(callsign: string) {
  const app = useApp();
  const [notes, say] = useOutcome();
  async function change(key: string, name: string, body: Record<string, unknown>) {
    say(key, "…");
    const r = await app.request<{ restart?: boolean }>(name, { callsign, ...body });
    if (r.ok) say(key, r.result?.restart ? "после хода" : "", "ok");
    else say(key, `Не вышло: ${r.error}`, "bad");
    return r.ok;
  }
  return [notes, change] as const;
}

/** Чтение не удалось и данных нет: слово на их месте. */
const refusal = (answer: Load<unknown>, cur: string) => (answer.error && !answer.data ? [cur, answer.error].filter(Boolean).join(" · ") : "");

/** Режим разрешений рядом с настройками: кнопки, как модель и усилие. */
function ModeSec({ callsign, sdk }: { callsign: string; sdk: boolean }) {
  const app = useApp();
  const [notes, change] = useChange(callsign);
  const s = app.use(() => sessionOf(app, callsign));
  const mode = s?.mode as string | undefined;
  const models = app.use(() => app.mark("models", callsign) as ModelInfo[] | null | undefined);
  // «Авто» — если модель умеет: список моделей у разговора
  useEffect(() => {
    if (sdk) app.run("models.load", { callsign });
  }, [app, callsign, sdk]);
  if (mode === undefined || !isLive(s?.state)) return null;
  const modes = permModesOf(mode, String(s?.model ?? ""), models);
  return (
    <div className="cw-fs" data-sec="mode">
      <span className="lb">Режим разрешений</span>
      <Chips className="pt-seg cw-modes" aria-label="Режим разрешений" data-mode={mode}>
        {modes.some(([value]) => value === mode) ? null : <Chip on>{permModeName(mode) ?? mode}</Chip>}
        {modes.map(([value, label]) => (
          <Chip key={value} on={value === mode} data-perm={value} onClick={() => void (value !== mode && change("mode", "session.call", { method: "setPermissionMode", args: [value] }))}>
            {label}
          </Chip>
        ))}
      </Chips>
      <Outcome className="cw-note" note={notes.mode} />
    </div>
  );
}

function FastSec({ callsign }: { callsign: string }) {
  const app = useApp();
  const on = app.use(() => sessionOf(app, callsign)?.fast === true);
  async function set() {
    const r = await app.request("session.update", { callsign, fast: !on });
    if (!r.ok) app.toast(`${callsign}: быстрый режим — ${r.error}`);
  }
  return (
    <div className="cw-fastrow" data-sec="fast">
      <span className="pt-sw">
        <Switch on={on} aria-label="Быстрый режим" onClick={() => void set()} />
        <span>Быстрый режим</span>
      </span>
    </div>
  );
}

function TitleSec({ callsign, machine }: { callsign: string; machine: string }) {
  const [notes, change] = useChange(callsign);
  const spec = useMachineLoad<{ title?: string }>(machine, "session.spec", { callsign });
  const word = refusal(spec, "");
  async function save(title: string) {
    if (await change("title", "session.update", { title })) spec.reload();
  }
  return (
    <div className="cw-fs" data-sec="title">
      <span className="lb">Заголовок</span>
      {word ? <Refused what="title" text={word} /> : <CommitIn className="cw-in" data-f="title" placeholder="Заголовок в claude.ai" value={spec.data?.title ?? ""} onCommit={(t) => void save(t)} />}
      <Outcome className="cw-note" note={notes.title} />
    </div>
  );
}

function ControlSec({ callsign, removable }: { callsign: string; removable: boolean }) {
  const app = useApp();
  const control = useControl(callsign);
  const { busy, word, act } = useAct(callsign);
  const [confirm, setConfirm] = useState(false);
  async function remove() {
    if ((await act("session.remove")).ok) app.back();
  }
  return (
    <div className="cw-fs" data-sec="ctl">
      <span className="lb">Сессия</span>
      <div className="cw-opts flat">
        <Control kind={control} busy={busy} act={act} />
        {removable && !confirm && <Btn bad onClick={() => setConfirm(true)}>Убрать…</Btn>}
      </div>
      {confirm && <Confirm text={`${callsign} остановится и уйдёт из списка. Точки в R2 останутся.`} act="Убрать" run={() => void remove()} cancel={() => setConfirm(false)} />}
      {word && (
        <span className="cw-note bad" role="alert">
          {word}
        </span>
      )}
    </div>
  );
}

/** Своё у каждой стороны вне таблицы: быстрый режим, режим разрешений, заголовок. */
function Side({ callsign, machine, can }: { callsign: string; machine: string; can: Record<string, boolean> }) {
  return (
    <div className="cw-side" data-callsign={callsign}>
      {can["session.update"] && <FastSec callsign={callsign} />}
      {can["session.call"] && <ModeSec callsign={callsign} sdk={can["session.call"]} />}
      {can["session.spec"] && <TitleSec callsign={callsign} machine={machine} />}
    </div>
  );
}

export function SetTab({ callsign, machine, accounts }: { callsign: string; machine: string; accounts: Load<AccountsAnswer> }) {
  const app = useApp();
  const can = app.use(() => Object.fromEntries(["session.update", "session.spec", "session.remove", "session.call"].map((n) => [n, app.can(machine, n) === true])));
  const present = app.use(() => !!sessionOf(app, callsign));
  const wing = app.use(() => wingOf(app.roster()?.sessions ?? [], callsign)?.callsign);
  return (
    <div className="cw-set">
      {present && can["session.update"] && <PairSet callsign={callsign} accounts={accounts} />}
      <div className={wing ? "cw-sides two" : "cw-sides"}>
        <Side callsign={callsign} machine={machine} can={can} />
        {wing && <Side callsign={wing} machine={machine} can={can} />}
      </div>
      <ControlSec callsign={callsign} removable={present && can["session.remove"]} />
    </div>
  );
}

const KINDS = ["stop", "refuse", "note"];
/** ЧЧ:ММ:СС записи; не дата — как пришло. */
const timeOf = (t: string) => (Number.isNaN(Date.parse(t)) ? t : new Date(t).toTimeString().slice(0, 8));

export function LogTab({ callsign, machine }: { callsign: string; machine: string }) {
  const app = useApp();
  const [days, setDays] = useState(0);
  const [kind, setKind] = useState("");
  const [page, setPage] = useState<{ records: JournalRecord[]; more: boolean; word: string } | null>(null);
  /** номер последнего вопроса: ответ на прежний отброшен */
  const asked = useRef(0);
  async function read(since: string, more: JournalRecord[]) {
    const number = ++asked.current;
    const r = await app.read<JournalAnswer>("machine.journal", { machine, session: callsign, limit: 50, since, ...(kind ? { kind: [kind] } : {}) });
    if (number !== asked.current) return;
    setPage(r.ok ? { records: [...more, ...r.result.records], more: r.result.more, word: "" } : { records: more, more: false, word: `machine.journal: ${r.error}` });
  }
  useEffect(() => void read(midnight(days), []), [days, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="cw-log">
      <div className="cw-opts flat">
        {["", ...KINDS].map((k) => (
          <Btn key={k} aria-pressed={k === kind} onClick={() => setKind(k)}>
            {k || "все"}
          </Btn>
        ))}
        <span className="cw-note">{`${machine} · ${days ? `с ${days} дн. назад` : "сегодня"}`}</span>
      </div>
      {page?.word && (
        <div className="cw-note bad" role="alert">
          {page.word}
        </div>
      )}
      {page && !page.word && !page.records.length && <div className="cw-note">Записей нет.</div>}
      {page?.records.map((r, i) => (
        <div key={`${r.t}:${i}`} className="cw-lr">
          <span>{timeOf(r.t)}</span>
          <span className={`k ${r.kind ?? ""}`}>{r.kind}</span>
          <span className="w">{[r.part, r.who].filter(Boolean).join(" · ")}</span>
          <span className="x">{[r.ev, r.word, r.why].filter(Boolean).join(" · ")}</span>
        </div>
      ))}
      {page?.more && page.records.length > 0 && <Btn onClick={() => void read(page.records.at(-1)!.t, page.records)}>дальше →</Btn>}
      <Btn onClick={() => setDays(days + 1)}>Раньше</Btn>
    </div>
  );
}
