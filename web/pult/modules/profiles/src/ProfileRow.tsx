// Строка профиля: имя, модель, сколько машин и сессий; раскрывается в машины, идущие сессии и конфликты.
import { DisclosureBtn, Dot, effortName, plural, profileName, RowBtn, useApp } from "@switchboard/web-ui";
import type { ProfileRowData } from "./store.ts";

export function ProfileRow({ row, machines, open, toggle }: { row: ProfileRowData; machines: number; open: boolean; toggle(): void }) {
  const app = useApp();
  const conflicted = row.conflicts.length > 0;
  const runs = row.running.length;
  return (
    <div className={"pf-w" + (conflicted ? " cf" : "")} data-profile={row.id}>
      <DisclosureBtn className="pf-r" open={open} onClick={toggle}>
        <span className="pf-n">
          <b>{profileName(row.id)}</b>
          {row.about ? <span>{row.about}</span> : null}
        </span>
        <span className="pf-m">
          <span>{[row.model, row.effort ? effortName(row.effort) : null].filter(Boolean).join(" · ")}</span>
          <span className="c">{`${row.machines.length}/${machines} ${plural(machines, "машины", "машин", "машин")} · ${runs} ${plural(runs, "сессия", "сессии", "сессий")}`}</span>
          {conflicted ? <span className="pf-p bad">{`конфликт ${row.conflicts.map((c) => c.label).join(", ")}`}</span> : null}
        </span>
      </DisclosureBtn>
      {open ? (
        <div className="pf-d">
          <div className="pf-ms">
            {row.machines.map(({ m, label }) => {
              const bad = row.conflicts.some((c) => c.m === m);
              return (
                <span key={m} className={`pf-p ${bad ? "bad" : "ok"}`}>
                  {bad ? `${label} конфликт` : label}
                </span>
              );
            })}
          </div>
          {runs ? (
            <div className="pf-ss">
              {row.running.map((s) => (
                <RowBtn key={s.callsign} data-callsign={s.callsign} onClick={() => app.open("card", { callsign: s.callsign })}>
                  <Dot kind={s.lamp} />
                  <span className={"nm" + (s.human ? " hum" : "")}>{s.text}</span>
                  <span className="k">{s.place}</span>
                </RowBtn>
              ))}
            </div>
          ) : null}
          {row.conflicts.map((c) => (
            <div key={c.m} className="pf-cf">
              <b>{`${c.label}: ${c.repo.state === "conflict" ? "конфликт" : "ошибка"}`}</b>
              {c.repo.error ? <span>{c.repo.error}</span> : null}
              {(c.repo.files ?? []).map((f) => (
                <code key={f}>{f}</code>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
