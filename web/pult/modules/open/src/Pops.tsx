// Окна чипов новой сессии: профиль; модель, усилие, слот и «Точки в R2».
import { Chip, Chips, effortName, EFFORTS, In, MODELS, profileName as short, RowBtn, SlotPick, Switch, useApp } from "@switchboard/web-ui";
import { useOpen } from "./store.ts";
import { useMachineLabels } from "./Browser.tsx";
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
      <In className="op-flt" data-f="pq" value={f.pq} placeholder="Найти профиль" autoComplete="off" aria-label="Найти профиль" onInput={(e) => set({ pq: e.currentTarget.value })} />
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
            <RowBtn key={id} className="op-pr" role="radio" aria-checked={f.profile === id} data-profile={id} onClick={() => choose(id)}>
              <span className="r1">
                <b>{short(id)}</b>
                <span className="sp">{[p.model, p.effort ? effortName(p.effort) : null].filter(Boolean).join(" · ")}</span>
              </span>
              {p.about ? <span className="r2">{p.about}</span> : null}
            </RowBtn>
          );
        })}
      <RowBtn className="op-pr" role="radio" aria-checked={f.profile === null} data-profile="" onClick={() => choose(null)}>
        <span className="r1">
          <b>без профиля</b>
        </span>
      </RowBtn>
    </>
  );
}

export function ModelPop({ form }: { form: OpenForm }) {
  const app = useApp();
  const open = useOpen();
  const { f, set, chooseModel } = form;
  const r2 = app.use(() => open.can(f.machine, "session.r2") || !f.machine);
  return (
    <>
      <div className="lb">Модель</div>
      <Chips className="op-opts">
        {MODELS.map((m) => (
          <Chip key={m} on={f.model === m} data-model={m} onClick={() => chooseModel({ model: m })}>
            {m}
          </Chip>
        ))}
      </Chips>
      <div className="lb">Усилие</div>
      <Chips className="op-opts">
        {EFFORTS.map(([k, l]) => (
          <Chip key={k} on={f.effort === k} data-effort={k} onClick={() => chooseModel({ effort: k })}>
            {l}
          </Chip>
        ))}
      </Chips>
      <SlotPick slots={f.slots ?? {}} value={f.slot} on={(slot) => set({ slot, err: "" })} />
      {f.refused["machine.accounts"] ? (
        <div className="op-err" role="alert">
          {`machine.accounts: ${f.refused["machine.accounts"]}`}
        </div>
      ) : null}
      {r2 ? (
        <div className="op-sw">
          <span>Точки в R2</span>
          <Switch aria-label="Точки в R2" on={f.r2} data-r2="1" onClick={() => set({ r2: !f.r2 })} />
        </div>
      ) : null}
    </>
  );
}
