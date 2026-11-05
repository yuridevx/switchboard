// Вкладка «Настройки» широкой карточки: профиль, быстрый режим, заголовок, слот, остановка и удаление.
import { useState } from "react";
import type { SessionRecord } from "@switchboard/web-core";
import { Btn, CommitIn, Note, Outcome, type OutcomeNote, profileIdOf, profileName, type ProfilesAnswer, slotOf, useApp, useMachineLoad, useOutcome } from "@switchboard/web-ui";
import { isDown, useSessionActions, type Can } from "./session.tsx";
import type { WideData } from "./wide.tsx";

/** Выбор варианта: нажат текущий — запроса нет. */
function Choice({ section, attr, label, options, current, word, note, pick, nameOf }: { section: string; attr: "data-profile" | "data-slot"; label: string; options: string[]; current: string; word: string; note?: OutcomeNote; pick(v: string): void; nameOf(v: string): string }) {
  return (
    <div className="cw-fs" data-sec={section}>
      <span className="lb">{label}</span>
      {word ? (
        <Note tone="bad" data-refused={section}>{word}</Note>
      ) : (
        <div className="cw-opts flat">
          {[...options, ""].map((v) => (
            <Btn key={v} aria-pressed={current === v ? "true" : "false"} {...{ [attr]: v }} onClick={() => v !== current && pick(v)}>
              {nameOf(v)}
            </Btn>
          ))}
        </div>
      )}
      <Outcome className="cw-note" note={note} />
    </div>
  );
}

export function SetTab({ machine, callsign, s, can, live, data }: { machine: string; callsign: string; s: SessionRecord | undefined; can: Can; live: boolean; data: WideData }) {
  const app = useApp();
  const actions = useSessionActions(callsign);
  const [notes, note] = useOutcome();
  const spec = useMachineLoad<{ title?: string | null }>(machine, "session.spec", { callsign });
  const profiles = useMachineLoad<ProfilesAnswer>(machine, "machine.profiles");
  const [removing, setRemoving] = useState(false);

  async function move(name: "session.slot" | "session.profile", key: "slot" | "profile", value: string) {
    note(key, "…");
    const r = await app.request<{ restart?: boolean }>(name, { callsign, [key]: value || null });
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
  return (
    <div className="cw-set">
      {can("session.profile") ? (
        <Choice
          section="profile"
          attr="data-profile"
          label="Профиль"
          options={profiles.data ? Object.keys(profiles.data.profiles ?? {}) : profNow ? [profNow] : []}
          current={profNow}
          word={profiles.error && !profiles.data ? `${profNow ? `${profileName(profNow)} · ` : ""}${profiles.error}` : ""}
          note={notes.profile}
          pick={(v) => void move("session.profile", "profile", v)}
          nameOf={(v) => (v ? profileName(v) : "без профиля")}
        />
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
        <Choice
          section="slot"
          attr="data-slot"
          label="Слот"
          options={Object.keys(data.slots ?? (slotNow ? { [slotNow]: 1 } : {}))}
          current={slotNow}
          word={data.word && !data.slots ? `${slotNow ? `${slotNow} · ` : ""}${data.word}` : ""}
          note={notes.slot}
          pick={(v) => void move("session.slot", "slot", v)}
          nameOf={(v) => v || "без слота"}
        />
      ) : null}
      <div className="cw-fs" data-sec="ctl">
        <span className="lb">Сессия</span>
        <div className="cw-opts flat">
          {s && live && can("session.stop") ? <Btn onClick={() => void act("session.stop")}>Остановить</Btn> : null}
          {s && isDown(s) && can("session.start") ? (
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
              <Btn onClick={() => setRemoving(false)}>Отмена</Btn>
            </div>
          </div>
        ) : null}
        <Outcome className="cw-note" note={actions.busy ? { text: "…" } : actions.error ? { text: actions.error, tone: "bad" } : undefined} />
      </div>
    </div>
  );
}
