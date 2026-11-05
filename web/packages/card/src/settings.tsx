// Вкладка «Настройки»: профиль, быстрый режим, заголовок, слот, пуск и стоп, убрать. Раздел виден, если машина умеет его запрос.
import { useState } from "react";
import { machineOf } from "@switchboard/protocol";
import type { SessionRecord } from "@switchboard/relay";
import { Btn, CommitIn, Note, Outcome, profileIdOf, profileName, slotOf, useApp, useMachineLoad, useOutcome, type AccountsAnswer, type ProfilesAnswer } from "@switchboard/web-ui";

const Refused = ({ what, text }: { what: string; text: string }) => (
  <Note tone="bad" data-refused={what}>
    {text}
  </Note>
);

export function SetTab({ callsign, session }: { callsign: string; session?: SessionRecord }) {
  const app = useApp();
  const machine = machineOf(callsign) ?? "";
  const can = (name: string) => app.can(machine, name) === true;
  const profiles = useMachineLoad<ProfilesAnswer>(machine, "machine.profiles");
  const accounts = useMachineLoad<AccountsAnswer>(machine, "machine.accounts");
  const spec = useMachineLoad<{ title?: string }>(machine, "session.spec", { callsign });
  const [notes, say] = useOutcome();
  const [confirm, setConfirm] = useState(false);
  app.use(() => app.roster()?.machines.find((m) => m.machine === machine)?.contract);

  const live = session?.state === "busy" || session?.state === "idle" || session?.state === "waiting";
  const curProfile = profileIdOf(session) ?? "";
  const curSlot = slotOf(session)?.name ?? "";

  /** Смена с итогом в своём разделе: сразу или «после хода». */
  async function change(key: string, name: string, body: Record<string, unknown>) {
    say(key, "…");
    const r = await app.request<{ restart?: boolean }>(name, { callsign, ...body });
    if (r.ok) say(key, r.result?.restart ? "после хода" : "");
    else say(key, `Не вышло: ${r.error}`, "bad");
  }
  async function saveTitle(title: string) {
    const r = await app.request("session.update", { callsign, title });
    if (r.ok) {
      say("title", "");
      spec.reload();
    } else say("title", `Не вышло: ${r.error}`, "bad");
  }
  async function setFast(fast: boolean) {
    const r = await app.request("session.update", { callsign, fast });
    if (!r.ok) app.toast(`${callsign}: быстрый режим — ${r.error}`);
  }
  async function ctl(name: string) {
    say("ctl", "");
    const r = await app.request(name, { callsign });
    if (!r.ok) say("ctl", `${name}: ${r.error}`, "bad");
  }
  async function remove() {
    const r = await app.request("session.remove", { callsign });
    if (r.ok) app.back();
    else say("ctl", `session.remove: ${r.error}`, "bad");
  }

  const refusal = (answer: { data?: unknown; error: string }, cur: string) => (answer.error && !answer.data ? [cur, answer.error].filter(Boolean).join(" · ") : "");
  const profileWord = refusal(profiles, curProfile && profileName(curProfile));
  const slotWord = refusal(accounts, curSlot);

  return (
    <div className="cw-set">
      {can("session.profile") ? (
        <div className="cw-fs" data-sec="profile">
          <span className="lb">Профиль</span>
          {profileWord ? (
            <Refused what="profile" text={profileWord} />
          ) : (
            <div className="cw-opts flat">
              {[...Object.keys(profiles.data?.profiles ?? {}), ""].map((id) => (
                <Btn key={id} aria-pressed={id === curProfile ? "true" : "false"} data-profile={id} onClick={() => void (id !== curProfile && change("profile", "session.profile", { profile: id || null }))}>
                  {id ? profileName(id) : "без профиля"}
                </Btn>
              ))}
            </div>
          )}
          <Outcome className="cw-note" note={notes.profile} />
        </div>
      ) : null}
      {can("session.update") ? (
        <label className="cw-sw" data-sec="fast">
          <Btn role="switch" aria-checked={session?.fast === true} aria-pressed={session?.fast === true ? "true" : "false"} onClick={() => void setFast(session?.fast !== true)}>
            {session?.fast === true ? "вкл" : "выкл"}
          </Btn>
          <span>Быстрый режим</span>
        </label>
      ) : null}
      {can("session.spec") ? (
        <div className="cw-fs" data-sec="title">
          <span className="lb">Заголовок</span>
          {spec.error && !spec.data ? <Refused what="title" text={spec.error} /> : <CommitIn className="cw-in" data-f="title" placeholder="Заголовок в claude.ai" value={spec.data?.title ?? ""} onCommit={(t) => void saveTitle(t)} />}
          <Outcome className="cw-note" note={notes.title} />
        </div>
      ) : null}
      {can("session.slot") ? (
        <div className="cw-fs" data-sec="slot">
          <span className="lb">Слот</span>
          {slotWord ? (
            <Refused what="slot" text={slotWord} />
          ) : (
            <div className="cw-opts flat">
              {[...Object.keys(accounts.data?.slots ?? {}), ""].map((name) => (
                <Btn key={name} aria-pressed={name === curSlot ? "true" : "false"} data-slot={name} onClick={() => void (name !== curSlot && change("slot", "session.slot", { slot: name || null }))}>
                  {name || "без слота"}
                </Btn>
              ))}
            </div>
          )}
          <Outcome className="cw-note" note={notes.slot} />
        </div>
      ) : null}
      {session ? (
        <div className="cw-fs" data-sec="ctl">
          <span className="lb">Сессия</span>
          <div className="cw-opts flat">
            {live && can("session.stop") ? <Btn onClick={() => void ctl("session.stop")}>Остановить</Btn> : null}
            {!live && can("session.start") ? (
              <Btn pri onClick={() => void ctl("session.start")}>
                Запустить
              </Btn>
            ) : null}
            {can("session.remove") && !confirm ? (
              <Btn bad onClick={() => setConfirm(true)}>
                Убрать…
              </Btn>
            ) : null}
          </div>
          {confirm ? (
            <div className="cw-confirm">
              <span>{`${callsign} остановится и уйдёт из списка. Точки в R2 останутся.`}</span>
              <div className="cw-opts flat">
                <Btn bad onClick={() => void remove()}>
                  Убрать
                </Btn>
                <Btn onClick={() => setConfirm(false)}>Отмена</Btn>
              </div>
            </div>
          ) : null}
          <Outcome className="cw-note" note={notes.ctl} />
        </div>
      ) : null}
    </div>
  );
}
