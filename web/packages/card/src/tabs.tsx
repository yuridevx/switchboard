// Вкладки широкой карточки: «Настройки» и «Журнал».
import { useEffect, useRef, useState } from "react";
import { hhmm, Btn, CommitIn, midnight, Opts, profileIdOf, profileName, sessionOf, slotOf, Switch, useApp, useMachineLoad, type AccountsAnswer, type JournalAnswer, type JournalRecord, type ProfilesAnswer } from "@switchboard/web-ui";
import { Control, useAct, useControl } from "./narrow.tsx";

const toldLater = (r: { ok: boolean; result?: unknown }) => (r.ok && (r.result as { restart?: boolean } | undefined)?.restart ? "после хода" : "");

/** Подпись раздела итога: «Не вышло: слово» или «после хода». */
function Told({ word }: { word: string }) {
  return word ? <span className={word.startsWith("Не вышло") ? "cw-note bad" : "cw-note ok"}>{word}</span> : null;
}

function Refused({ name, word }: { name: string; word: string }) {
  return (
    <span className="cw-note bad" data-refused={name}>
      {word}
    </span>
  );
}

export function SetTab({ callsign, machine, accounts, error }: { callsign: string; machine: string; accounts: AccountsAnswer | undefined; error: string }) {
  const app = useApp();
  const s = app.use(() => sessionOf(app, callsign));
  const can = app.use(() => Object.fromEntries(["session.update", "session.spec", "session.profile", "session.slot", "session.remove"].map((n) => [n, app.can(machine, n) === true])));
  const control = useControl(callsign);
  const { busy, word, act } = useAct(callsign);
  const profiles = useMachineLoad<ProfilesAnswer>(machine, "machine.profiles", undefined, can["session.profile"]);
  const spec = useMachineLoad<{ title?: string }>(machine, "session.spec", { callsign }, can["session.spec"]);
  const [told, setTold] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  if (!s) return <div className="cw-set" data-sec="ctl" />;
  const say = (sec: string, text: string) => setTold((t) => ({ ...t, [sec]: text }));
  const profile = profileIdOf(s);
  const slot = slotOf(s)?.name;
  async function change(sec: string, name: string, body: Record<string, unknown>) {
    const r = await act(name, body);
    say(sec, r.ok ? toldLater(r) : `Не вышло: ${r.error}`);
  }
  async function title(text: string) {
    await change("title", "session.update", { title: text });
    spec.reload();
  }
  async function fast() {
    const r = await act("session.update", { fast: !s!.fast });
    if (!r.ok) app.toast(`${callsign}: быстрый режим — ${r.error}`, "bad");
  }
  async function remove() {
    const r = await act("session.remove");
    if (r.ok) app.back();
  }
  const pickProfile = (id: string) => id !== (profile ?? "") && void change("profile", "session.profile", { profile: id || null });
  return (
    <div className="cw-set">
      {can["session.profile"] && (
        <div className="cw-fs" data-sec="profile">
          <span className="lb">Профиль</span>
          {!profiles.data && profiles.error ? (
            <Refused name="profile" word={`${profile ? profileName(profile) : "без профиля"} · ${profiles.error}`} />
          ) : (
            <div className="cw-opts flat">
              {[...Object.keys(profiles.data?.profiles ?? {}), ""].map((id) => (
                <Btn key={id} data-profile={id} aria-pressed={id === (profile ?? "")} onClick={() => pickProfile(id)}>
                  {id ? profileName(id) : "без профиля"}
                </Btn>
              ))}
            </div>
          )}
          <Told word={told.profile ?? ""} />
        </div>
      )}
      {can["session.update"] && (
        <div className="cw-fs" data-sec="fast">
          <label className="cw-sw">
            <span>Быстрый режим</span>
            <Switch on={!!s.fast} onClick={() => void fast()} />
          </label>
        </div>
      )}
      {can["session.update"] && can["session.spec"] && (
        <div className="cw-fs" data-sec="title">
          <span className="lb">Заголовок</span>
          {!spec.data && spec.error ? <Refused name="title" word={spec.error} /> : <CommitIn className="cw-in" data-f="title" placeholder="Заголовок в claude.ai" value={spec.data?.title ?? ""} onCommit={(t) => void title(t)} />}
          <Told word={told.title ?? ""} />
        </div>
      )}
      {can["session.slot"] && (
        <div className="cw-fs" data-sec="slot">
          <span className="lb">Слот</span>
          {!accounts && error ? (
            <Refused name="slot" word={`${slot ?? "—"} · ${error}`} />
          ) : (
            <div className="cw-opts flat">
              {Object.keys(accounts?.slots ?? {}).map((name) => (
                <Btn key={name} data-slot={name} aria-pressed={name === slot} onClick={() => name !== slot && void change("slot", "session.slot", { slot: name })}>
                  {name}
                </Btn>
              ))}
            </div>
          )}
          <Told word={told.slot ?? ""} />
        </div>
      )}
      <div className="cw-fs" data-sec="ctl">
        <span className="lb">Сессия</span>
        <div className="cw-opts flat">
          <Control kind={control} busy={busy} act={act} />
          {can["session.remove"] && <Btn bad onClick={() => setConfirm(true)}>Убрать…</Btn>}
        </div>
        {word && <span className="cw-note bad">{word}</span>}
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
    </div>
  );
}

const KINDS = ["stop", "refuse", "note"];
const timeOf = (t: string) => (Number.isNaN(Date.parse(t)) ? t : hhmm(Date.parse(t)));

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
      <span className="cw-note">{`${machine} · ${days ? `с ${days} дн. назад` : "сегодня"}`}</span>
      <div className="cw-opts flat">
        {["", ...KINDS].map((k) => (
          <Btn key={k} aria-pressed={k === kind} onClick={() => setKind(k)}>
            {k || "все"}
          </Btn>
        ))}
      </div>
      {page?.records.map((r, i) => (
        <div key={i} className="cw-lr">
          <span>{timeOf(r.t)}</span>
          <span className={`k ${r.kind ?? ""}`}>{r.kind}</span>
          <span className="w">{r.part}</span>
          <span className="x">{[r.ev, r.word, r.why].filter(Boolean).join(" · ")}</span>
        </div>
      ))}
      {page?.word && <span className="cw-note bad">{page.word}</span>}
      {page && !page.word && !page.records.length && <span className="cw-note">Записей нет.</span>}
      <Opts>
        {page?.more && <Btn onClick={() => void read(page.records.at(-1)?.t ?? midnight(days), page.records)}>дальше →</Btn>}
        <Btn onClick={() => setDays(days + 1)}>Раньше</Btn>
      </Opts>
    </div>
  );
}
