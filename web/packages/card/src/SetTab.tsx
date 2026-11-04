// Вкладка «Настройки» широкой карточки: профиль, быстрый режим, заголовок, слот, остановка и удаление.
import type { ProfilesAnswer } from "@switchboard/web-ui";
import { useState } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { CommitIn, Note, Outcome, profileIdOf, profileName, useMachineLoad, useApp, useOutcome, slotOf, Btn } from "@switchboard/web-ui";
import { useSessionActions } from "./hooks.ts";
import { isDown, type Can } from "./session.ts";
import type { WideData } from "./useWideData.ts";

type Spec = { title?: string | null };

export function SetTab({ machine, callsign, s, can, live, data }: { machine: string; callsign: string; s: SessionRecord | undefined; can: Can; live: boolean; data: WideData }) {
  const app = useApp();
  const actions = useSessionActions(callsign);
  const [notes, note] = useOutcome();
  const spec = useMachineLoad<Spec>(machine, "session.spec", { callsign });
  const profiles = useMachineLoad<ProfilesAnswer>(machine, "machine.profiles");
  const [removing, setRemoving] = useState(false);

  async function move(name: "session.slot" | "session.profile", value: string | null) {
    const key = name === "session.slot" ? "slot" : "profile";
    note(key, "…");
    const r = await app.request<{ restart?: boolean }>(name, { callsign, [key]: value });
    if (!r.ok) return note(key, `Не вышло: ${r.error}`, "bad");
    note(key, r.result?.restart ? "после хода" : "", "ok");
  }

  /** Заголовок уходит, когда ввод подтверждён; владелец значения — session.spec. */
  async function saveTitle(title: string) {
    const word = await actions.send("session.update", { title });
    if (word) return note("title", `Не вышло: ${word}`, "bad");
    spec.reload();
    note("title", "");
  }

  async function act(name: "session.stop" | "session.start" | "session.remove") {
    if (!(await actions.act(name)) && name === "session.remove") app.back();
  }

  const profNow = profileIdOf(s) ?? "";
  const slotNow = slotOf(s)?.name ?? "";
  const fast = !!(s?.fast as boolean | undefined);
  const stopped = isDown(s);
  const profileList = profiles.data ? Object.keys(profiles.data.profiles ?? {}) : profNow ? [profNow] : [];
  return (
    <div className="cw-set">
      {can("session.profile") ? (
        <div className="cw-fs" data-sec="profile">
          <span className="lb">Профиль</span>
          {profiles.error && !profiles.data ? (
            <Note tone="bad" data-refused="profile">{`${profNow ? `${profileName(profNow)} · ` : ""}${profiles.error}`}</Note>
          ) : (
            <div className="cw-opts flat">
              {[...profileList, ""].map((p) => (
                <Btn key={p} aria-pressed={profNow === p ? "true" : "false"} data-profile={p} onClick={() => (p === profNow ? null : void move("session.profile", p || null))}>
                  {p ? profileName(p) : "без профиля"}
                </Btn>
              ))}
            </div>
          )}
          <Outcome className="cw-note" note={notes.profile} />
        </div>
      ) : null}
      {can("session.update") ? (
        <label className="cw-sw" data-sec="fast">
          <Btn role="switch" aria-checked={fast ? "true" : "false"} aria-pressed={fast ? "true" : "false"} onClick={() => void actions.update({ fast: !fast }, "быстрый режим")}>
            {fast ? "вкл" : "выкл"}
          </Btn>
          <span>Быстрый режим</span>
        </label>
      ) : null}
      {can("session.update") ? (
        <div className="cw-fs" data-sec="title">
          <span className="lb">Заголовок</span>
          {spec.error && !spec.data ? (
            <Note tone="bad" data-refused="title">{spec.error}</Note>
          ) : (
            <CommitIn className="cw-in" data-f="title" placeholder="Заголовок в claude.ai" value={spec.data?.title ?? ""} onCommit={(v) => void saveTitle(v)} />
          )}
          <Outcome className="cw-note" note={notes.title} />
        </div>
      ) : null}
      {can("session.slot") ? (
        <div className="cw-fs" data-sec="slot">
          <span className="lb">Слот</span>
          {data.word && !data.slots ? (
            <Note tone="bad" data-refused="slot">{`${slotNow ? `${slotNow} · ` : ""}${data.word}`}</Note>
          ) : (
            <div className="cw-opts flat">
              {[...Object.keys(data.slots ?? (slotNow ? { [slotNow]: 1 } : {})), ""].map((v) => (
                <Btn key={v} aria-pressed={slotNow === v ? "true" : "false"} data-slot={v} onClick={() => (v === slotNow ? null : void move("session.slot", v || null))}>
                  {v || "без слота"}
                </Btn>
              ))}
            </div>
          )}
          <Outcome className="cw-note" note={notes.slot} />
        </div>
      ) : null}
      <div className="cw-fs" data-sec="ctl">
        <span className="lb">Сессия</span>
        <div className="cw-opts flat">
          {s && live && can("session.stop") ? (
            <Btn onClick={() => void act("session.stop")}>
              Остановить
            </Btn>
          ) : null}
          {s && stopped && can("session.start") ? (
            <Btn pri onClick={() => void act("session.start")}>
              Запустить
            </Btn>
          ) : null}
          {s && can("session.remove") && !removing ? (
            <Btn bad onClick={() => setRemoving(true)}>
              Убрать…
            </Btn>
          ) : null}
        </div>
        {removing ? (
          <div className="cw-confirm">
            <span>{`${callsign} остановится и уйдёт из списка. Точки в R2 останутся.`}</span>
            <div className="cw-opts flat">
              <Btn bad onClick={() => void act("session.remove")}>
                Убрать
              </Btn>
              <Btn onClick={() => setRemoving(false)}>
                Отмена
              </Btn>
            </div>
          </div>
        ) : null}
        <Outcome className="cw-note" note={actions.busy ? { text: "…" } : actions.error ? { text: actions.error, tone: "bad" } : undefined} />
      </div>
    </div>
  );
}
