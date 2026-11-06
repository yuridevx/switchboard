// Вкладки широкой карточки: «Настройки» и «Журнал». Раздел настроек виден, если машина умеет его запрос.
import { useEffect, useRef, useState } from "react";
import { Btn, CommitIn, midnight, Note, Outcome, profileIdOf, profileName, sessionOf, slotOf, useApp, useMachineLoad, useOutcome, type AccountsAnswer, type JournalAnswer, type JournalRecord, type ProfilesAnswer } from "@switchboard/web-ui";
import { Control, useAct, useControl } from "./narrow.tsx";

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

function Refused({ what, text }: { what: string; text: string }) {
  return (
    <Note tone="bad" data-refused={what}>
      {text}
    </Note>
  );
}

function ProfileSec({ callsign, machine }: { callsign: string; machine: string }) {
  const app = useApp();
  const [notes, change] = useChange(callsign);
  const profiles = useMachineLoad<ProfilesAnswer>(machine, "machine.profiles");
  const cur = app.use(() => profileIdOf(sessionOf(app, callsign)) ?? "");
  const word = refusal(profiles, cur && profileName(cur));
  return (
    <div className="cw-fs" data-sec="profile">
      <span className="lb">Профиль</span>
      {word ? (
        <Refused what="profile" text={word} />
      ) : (
        <div className="cw-opts flat">
          {[...Object.keys(profiles.data?.profiles ?? {}), ""].map((id) => (
            <Btn key={id} data-profile={id} aria-pressed={id === cur} onClick={() => void (id !== cur && change("profile", "session.profile", { profile: id || null }))}>
              {id ? profileName(id) : "без профиля"}
            </Btn>
          ))}
        </div>
      )}
      <Outcome className="cw-note" note={notes.profile} />
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
    <label className="cw-sw" data-sec="fast">
      <span>Быстрый режим</span>
      <Btn role="switch" aria-checked={on} aria-pressed={on} onClick={() => void set()}>
        {on ? "вкл" : "выкл"}
      </Btn>
    </label>
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

function SlotSec({ callsign, accounts }: { callsign: string; accounts: Load<AccountsAnswer> }) {
  const app = useApp();
  const [notes, change] = useChange(callsign);
  const cur = app.use(() => slotOf(sessionOf(app, callsign))?.name ?? "");
  const word = refusal(accounts, cur);
  return (
    <div className="cw-fs" data-sec="slot">
      <span className="lb">Слот</span>
      {word ? (
        <Refused what="slot" text={word} />
      ) : (
        <div className="cw-opts flat">
          {Object.keys(accounts.data?.slots ?? {}).map((name) => (
            <Btn key={name} data-slot={name} aria-pressed={name === cur} onClick={() => void (name !== cur && change("slot", "session.slot", { slot: name }))}>
              {name}
            </Btn>
          ))}
        </div>
      )}
      <Outcome className="cw-note" note={notes.slot} />
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
      {confirm && (
        <div className="cw-confirm">
          <span>{`${callsign} остановится и уйдёт из списка. Точки в R2 останутся.`}</span>
          <div className="cw-opts flat">
            <Btn bad disabled={!!busy} onClick={() => void remove()}>
              Убрать
            </Btn>
            <Btn onClick={() => setConfirm(false)}>Отмена</Btn>
          </div>
        </div>
      )}
      {word && (
        <span className="cw-note bad" role="alert">
          {word}
        </span>
      )}
    </div>
  );
}

export function SetTab({ callsign, machine, accounts }: { callsign: string; machine: string; accounts: Load<AccountsAnswer> }) {
  const app = useApp();
  const can = app.use(() => Object.fromEntries(["session.update", "session.spec", "session.profile", "session.slot", "session.remove"].map((n) => [n, app.can(machine, n) === true])));
  const present = app.use(() => !!sessionOf(app, callsign));
  return (
    <div className="cw-set">
      {can["session.profile"] && <ProfileSec callsign={callsign} machine={machine} />}
      {can["session.update"] && <FastSec callsign={callsign} />}
      {can["session.spec"] && <TitleSec callsign={callsign} machine={machine} />}
      {can["session.slot"] && <SlotSec callsign={callsign} accounts={accounts} />}
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
