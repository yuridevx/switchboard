// Строка профиля: имя, модель, сколько машин и сессий; раскрывается в машины, идущие сессии и конфликты.
import { useApp } from "@switchboard/web-core";
import { Dot, effortName, plural, profileName as short } from "@switchboard/web-ui";
import type { ProfileRowData } from "./store.ts";

export function ProfileRow({ r, machines, open, toggle }: { r: ProfileRowData; machines: number; open: boolean; toggle(id: string): void }) {
  const app = useApp();
  return (
    <div className={"pf-w" + (r.cf.length ? " cf" : "")} data-profile={r.id}>
      <button className="pf-r" aria-expanded={open} onClick={() => toggle(r.id)}>
        <span className="pf-n">
          <b>{short(r.id)}</b>
          {r.about ? <span>{r.about}</span> : null}
        </span>
        <span className="pf-m">
          <span>{[r.model, r.effort ? effortName(r.effort) : null].filter(Boolean).join(" · ")}</span>
          <span className="c">{`${r.ms.length}/${machines} ${plural(machines, "машины", "машин", "машин")} · ${r.run.length} ${plural(r.run.length, "сессия", "сессии", "сессий")}`}</span>
          {r.cf.length ? <span className="pf-p bad">{`конфликт ${r.cf.map((x) => x.label).join(", ")}`}</span> : null}
        </span>
      </button>
      {open ? (
        <div className="pf-d">
          <div className="pf-ms">
            {r.ms.map(({ m, label }) =>
              r.cf.some((x) => x.m === m) ? (
                <span key={m} className="pf-p bad">{`${label} конфликт`}</span>
              ) : (
                <span key={m} className="pf-p ok">
                  {label}
                </span>
              ),
            )}
          </div>
          {r.run.length ? (
            <div className="pf-ss">
              {r.run.map((s) => (
                <button key={s.callsign} data-callsign={s.callsign} onClick={() => app.open("card", { callsign: s.callsign })}>
                  <Dot kind={s.lamp} />
                  <span className={"nm" + (s.human ? " hum" : "")}>{s.text}</span>
                  <span className="k">{s.place}</span>
                </button>
              ))}
            </div>
          ) : null}
          {r.cf.map((x) => (
            <div key={x.m} className="pf-cf">
              <b>{`${x.label}: ${x.repo.state === "conflict" ? "конфликт" : "ошибка"}`}</b>
              {x.repo.error ? <span>{x.repo.error}</span> : null}
              {(x.repo.files ?? []).map((f) => (
                <code key={f}>{f}</code>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
