// Окна чипов новой сессии: профиль; модель, усилие, слот и «Точки в R2».
import { effortName, EFFORTS, MODELS, profileName as short } from "@switchboard/web-ui";
import { useOpen } from "./context.ts";
import { useMachineLabels } from "./Browser.tsx";
import { hm } from "./form.ts";
import type { OpenForm } from "./useOpenForm.ts";

export function ProfilePop({ form }: { form: OpenForm }) {
  const { f, set, setProfile } = form;
  const label = useMachineLabels();
  const ql = f.pq.trim().toLowerCase();
  const profiles = f.profiles ?? {};
  const ids = Object.keys(profiles);
  const choose = (id: string | null) => {
    setProfile(id);
    set({ pop: "" });
  };
  return (
    <>
      <div className="lb">{`Профиль · ${label(f.machine).text} · ${ids.length}`}</div>
      <input className="op-flt" data-f="pq" value={f.pq} placeholder="Найти профиль" autoComplete="off" aria-label="Найти профиль" onInput={(e) => set({ pq: e.currentTarget.value })} />
      {f.refused["machine.profiles"] ? (
        <div className="op-err" role="alert">
          {`machine.profiles: ${f.refused["machine.profiles"]}`}
        </div>
      ) : null}
      {ids
        .filter((id) => !ql || `${id} ${profiles[id].about ?? ""}`.toLowerCase().includes(ql))
        .map((id) => {
          const p = profiles[id];
          return (
            <button key={id} className="op-pr" role="radio" aria-checked={f.profile === id} data-profile={id} onClick={() => choose(id)}>
              <span className="r1">
                <b>{short(id)}</b>
                <span className="sp">{[p.model, p.effort ? effortName(p.effort) : null].filter(Boolean).join(" · ")}</span>
              </span>
              {p.about ? <span className="r2">{p.about}</span> : null}
            </button>
          );
        })}
      <button className="op-pr" role="radio" aria-checked={f.profile === null} data-profile="" onClick={() => choose(null)}>
        <span className="r1">
          <b>без профиля</b>
        </span>
      </button>
    </>
  );
}

export function ModelPop({ form }: { form: OpenForm }) {
  const open = useOpen();
  const { f, set } = form;
  const slots = Object.entries(f.slots ?? {});
  return (
    <>
      <div className="lb">Модель</div>
      <div className="op-opts">
        {MODELS.map((m) => (
          <button key={m} data-model={m} aria-pressed={f.model === m} onClick={() => set({ model: m, modelSet: true })}>
            {m}
          </button>
        ))}
      </div>
      <div className="lb">Усилие</div>
      <div className="op-opts">
        {EFFORTS.map(([k, l]) => (
          <button key={k} data-effort={k} aria-pressed={f.effort === k} onClick={() => set({ effort: k, modelSet: true })}>
            {l}
          </button>
        ))}
      </div>
      {slots.length ? <div className="lb">Слот</div> : null}
      {slots.length ? (
        <div className="op-opts">
          {slots.map(([n, sl]) => (
            <button key={n} data-slot={n} aria-pressed={f.slot === n} onClick={() => set({ slot: n })}>
              {sl.wait ? `${n} · ждёт сброса ${hm(sl.wait)}` : n}
            </button>
          ))}
        </div>
      ) : null}
      {f.refused["machine.slots"] ? (
        <div className="op-err" role="alert">
          {`machine.slots: ${f.refused["machine.slots"]}`}
        </div>
      ) : null}
      {open.can(f.machine, "session.r2") || !f.machine ? (
        <div className="op-sw">
          <span>Точки в R2</span>
          <button role="switch" aria-label="Точки в R2" aria-checked={f.r2} data-r2="1" onClick={() => set({ r2: !f.r2 })} />
        </div>
      ) : null}
    </>
  );
}
