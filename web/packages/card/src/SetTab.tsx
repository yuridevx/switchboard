// Вкладка «Настройки» широкой карточки: профиль, быстрый режим, заголовок, слот, остановка и удаление.
import { useEffect, useRef, useState } from "react";
import { useApp, type SessionRecord } from "@switchboard/web-core";
import { profileName, useLoad } from "@switchboard/web-ui";
import { notAsked, profileOf, slotOf, type Can } from "./session.ts";
import type { WideData } from "./useWideData.ts";

type Note = { text: string; tone: string };
type Spec = { title?: string | null };
type Profiles = { profiles: Record<string, unknown> };

function NoteLine({ note }: { note?: Note }) {
  if (!note?.text) return null;
  return (
    <div className={`cw-note ${note.tone}`} role="status">
      {note.text}
    </div>
  );
}

export function SetTab({ machine, callsign, s, can, live, data }: { machine: string; callsign: string; s: SessionRecord | undefined; can: Can; live: boolean; data: WideData }) {
  const app = useApp();
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const spec = useLoad(() => (app.can(machine, "session.spec") === true ? app.request<Spec>("session.spec", { callsign }) : notAsked<Spec>()), [callsign]);
  const profiles = useLoad(() => (app.can(machine, "machine.profiles") === true ? app.request<Profiles>("machine.profiles", { machine }) : notAsked<Profiles>()), [machine]);
  const [savedTitle, setSavedTitle] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | undefined>();
  const [removing, setRemoving] = useState(false);
  const titleEl = useRef<HTMLInputElement>(null);
  const title = savedTitle ?? spec.data?.title ?? "";

  const note = (k: string, text: string, tone = "") => setNotes((old) => ({ ...old, [k]: { text, tone } }));

  // слоты: шапка могла не успеть прочитать — вкладке они нужны сразу
  useEffect(() => {
    if (!data.slots) data.reloadSlots();
    // только при открытии вкладки
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function move(name: "session.slot" | "session.profile", value: string | null) {
    const key = name === "session.slot" ? "slot" : "profile";
    note(key, "…");
    const r = await app.request<{ restart?: boolean }>(name, { callsign, [key]: value });
    if (!r.ok) return note(key, `Не вышло: ${r.error}`, "bad");
    note(key, r.result?.restart ? "после хода" : "", "ok");
  }

  // заголовок уходит по настоящему событию change поля — подтверждение ввода; onChange в React срабатывает на каждую букву
  useEffect(() => {
    const el = titleEl.current;
    if (!el) return;
    const save = async () => {
      const v = el.value;
      if (v === title) return;
      const r = await app.request("session.update", { callsign, title: v });
      if (!r.ok) return note("title", `Не вышло: ${r.error}`, "bad");
      setSavedTitle(v);
      setTitleEdit(undefined);
      note("title", "");
    };
    const on = () => void save();
    el.addEventListener("change", on);
    return () => el.removeEventListener("change", on);
  }, [app, callsign, title]);

  async function act(name: "session.stop" | "session.start" | "session.remove") {
    note("ctl", "…");
    const r = await app.request(name, { callsign });
    if (!r.ok) return note("ctl", `${name}: ${r.error}`, "bad");
    if (name === "session.remove") return app.back();
    note("ctl", "");
  }

  const profNow = profileOf(s) ?? "";
  const slotNow = slotOf(s)?.name ?? "";
  const fast = !!(s?.fast as boolean | undefined);
  const stopped = s?.state === "stopped" || s?.state === "failed";
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
          <NoteLine note={notes.profile} />
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
          <input ref={titleEl} className="cw-in" data-f="title" placeholder="Заголовок в claude.ai" value={titleEdit ?? title} onInput={(e) => setTitleEdit(e.currentTarget.value)} />
          <NoteLine note={notes.title} />
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
          <NoteLine note={notes.slot} />
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
        <NoteLine note={notes.ctl} />
      </div>
    </div>
  );
}
