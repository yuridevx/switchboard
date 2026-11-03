// Вкладка «Настройки» широкой карточки: профиль, быстрый режим, заголовок, слот, остановка и удаление.
import { useState } from "react";
import { useApp, type SessionRecord } from "@switchboard/web-core";
import { CommitIn, Outcome, profileIdOf, profileName, useLoad } from "@switchboard/web-ui";
import { useCard } from "./context.ts";
import { isDown, notAsked, slotOf, type Can } from "./session.ts";
import type { WideData } from "./useWideData.ts";

type Note = { text: string; tone: "ok" | "bad" | "" };
type Spec = { title?: string | null };
type Profiles = { profiles: Record<string, unknown> };

export function SetTab({ machine, callsign, s, can, live, data }: { machine: string; callsign: string; s: SessionRecord | undefined; can: Can; live: boolean; data: WideData }) {
  const app = useApp();
  const card = useCard();
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const spec = useLoad(() => (app.can(machine, "session.spec") === true ? app.request<Spec>("session.spec", { callsign }) : notAsked<Spec>()), [callsign]);
  const profiles = useLoad(() => (app.can(machine, "machine.profiles") === true ? app.request<Profiles>("machine.profiles", { machine }) : notAsked<Profiles>()), [machine]);
  const [removing, setRemoving] = useState(false);

  const note = (k: string, text: string, tone: Note["tone"] = "") => setNotes((old) => ({ ...old, [k]: { text, tone } }));

  async function move(name: "session.slot" | "session.profile", value: string | null) {
    const key = name === "session.slot" ? "slot" : "profile";
    note(key, "…");
    const r = await app.request<{ restart?: boolean }>(name, { callsign, [key]: value });
    if (!r.ok) return note(key, `Не вышло: ${r.error}`, "bad");
    note(key, r.result?.restart ? "после хода" : "", "ok");
  }

  /** Заголовок уходит, когда ввод подтверждён; владелец значения — session.spec. */
  async function saveTitle(title: string) {
    const r = await app.request("session.update", { callsign, title });
    if (!r.ok) return note("title", `Не вышло: ${r.error}`, "bad");
    spec.reload();
    note("title", "");
  }

  async function act(name: "session.stop" | "session.start" | "session.remove") {
    note("ctl", "…");
    const r = await card.control(callsign, name);
    if (!r.ok) return note("ctl", `${name}: ${r.error}`, "bad");
    if (name === "session.remove") return app.back();
    note("ctl", "");
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
          <div className="cw-opts flat">
            {[...profileList, ""].map((p) => (
              <button key={p} className="cw-b" aria-pressed={profNow === p ? "true" : "false"} data-profile={p} onClick={() => (p === profNow ? null : void move("session.profile", p || null))}>
                {p ? profileName(p) : "без профиля"}
              </button>
            ))}
          </div>
          <Outcome className="cw-note" note={notes.profile} />
        </div>
      ) : null}
      {can("session.update") ? (
        <label className="cw-sw" data-sec="fast">
          <button className="cw-b" role="switch" aria-checked={fast ? "true" : "false"} aria-pressed={fast ? "true" : "false"} onClick={() => void data.update({ fast: !fast }, "быстрый режим")}>
            {fast ? "вкл" : "выкл"}
          </button>
          <span>Быстрый режим</span>
        </label>
      ) : null}
      {can("session.update") ? (
        <div className="cw-fs" data-sec="title">
          <span className="lb">Заголовок</span>
          <CommitIn className="cw-in" data-f="title" placeholder="Заголовок в claude.ai" value={spec.data?.title ?? ""} onCommit={(v) => void saveTitle(v)} />
          <Outcome className="cw-note" note={notes.title} />
        </div>
      ) : null}
      {can("session.slot") ? (
        <div className="cw-fs" data-sec="slot">
          <span className="lb">Слот</span>
          <div className="cw-opts flat">
            {[...Object.keys(data.slots ?? (slotNow ? { [slotNow]: 1 } : {})), ""].map((v) => (
              <button key={v} className="cw-b" aria-pressed={slotNow === v ? "true" : "false"} data-slot={v} onClick={() => (v === slotNow ? null : void move("session.slot", v || null))}>
                {v || "без слота"}
              </button>
            ))}
          </div>
          <Outcome className="cw-note" note={notes.slot} />
        </div>
      ) : null}
      <div className="cw-fs" data-sec="ctl">
        <span className="lb">Сессия</span>
        <div className="cw-opts flat">
          {s && live && can("session.stop") ? (
            <button className="cw-b" onClick={() => void act("session.stop")}>
              Остановить
            </button>
          ) : null}
          {s && stopped && can("session.start") ? (
            <button className="cw-b pri" onClick={() => void act("session.start")}>
              Запустить
            </button>
          ) : null}
          {s && can("session.remove") && !removing ? (
            <button className="cw-b bad" onClick={() => setRemoving(true)}>
              Убрать…
            </button>
          ) : null}
        </div>
        {removing ? (
          <div className="cw-confirm">
            <span>{`${callsign} остановится и уйдёт из списка. Точки в R2 останутся.`}</span>
            <div className="cw-opts flat">
              <button className="cw-b bad" onClick={() => void act("session.remove")}>
                Убрать
              </button>
              <button className="cw-b" onClick={() => setRemoving(false)}>
                Отмена
              </button>
            </div>
          </div>
        ) : null}
        <Outcome className="cw-note" note={notes.ctl} />
      </div>
    </div>
  );
}
