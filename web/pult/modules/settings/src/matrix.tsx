// Матрица выпусков: машина × часть по ответам keeper'ов и плану; поиск, отметка машин, выбор машины для её плана.
import { useState } from "react";
import { Dot, In, machineLabel, Note, okOf, PageHead, plural, RowBtn, Sec, Switch, useApp } from "@switchboard/web-ui";
import { useHosts } from "./load.ts";
import { cellOf, type KState, type Listed, machineParts, matrixMachines } from "./rules.ts";
import { useSettings } from "./state.ts";

export function Matrix({ list, picked, pick }: { list: Listed | null; picked: string | null; pick(m: string | null): void }) {
  const app = useApp();
  const settings = useSettings();
  const d = app.use(() => settings.releaseData(list));
  const { data: hosts, error: noHosts } = useHosts();
  const [query, setQuery] = useState("");
  const selected = app.use(() => settings.get().rsel);
  const parts = machineParts(d);
  const q = query.trim().toLowerCase();
  const all = matrixMachines(d, hosts ?? []);
  const names = app.use(() => Object.fromEntries(all.map((m) => [m, machineLabel(app, m).text])));
  const shown = all.filter((m) => !q || m.toLowerCase().includes(q) || names[m]?.toLowerCase().includes(q));
  return (
    <Sec className="st-matrix">
      {noHosts ? <Note tone="bad" role="alert">{`keys.list: ${noHosts}`}</Note> : null}
      <PageHead>
        <In className="st-rq" data-f="rq" placeholder="Найти машину" aria-label="Найти машину" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        <Note className="st-end">{`${shown.length} ${plural(shown.length, "машина", "машины", "машин")}`}</Note>
      </PageHead>
      <div className="st-scroll">
        <table className="st-mx">
          <thead>
            <tr>
              <th></th>
              <th>машина</th>
              {parts.map((p) => (
                <th key={p}>{p}</th>
              ))}
              <th>план</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => {
              const answer = d.kst[m];
              const online = d.online.includes(m);
              const ok = okOf<KState>(answer);
              const refused = answer && "error" in answer ? answer.error : "";
              const tone = !online ? "stop" : refused || parts.some((p) => cellOf(d, m, p)?.k === "fail") ? "wait" : "idle";
              return (
                <tr key={m} data-machine={m} aria-current={picked === m ? "true" : undefined}>
                  <td>
                    <Switch className="st-ck" role="checkbox" on={!!selected[m]} aria-label={`Выбрать ${m}`} onClick={() => settings.toggleSelected(m)}>
                      {selected[m] ? "✓" : ""}
                    </Switch>
                  </td>
                  <td>
                    <RowBtn className="st-mn" onClick={() => pick(picked === m ? null : m)}>
                      <Dot kind={tone} />
                      {names[m] ?? `@${m}`}
                    </RowBtn>
                  </td>
                  {parts.map((p) => {
                    const c = cellOf(d, m, p);
                    return (
                      <td key={p} data-part={p}>
                        {c ? (
                          <span className={`st-cell ${c.k}`} title={c.why}>
                            {`${c.pin ? "📌 " : ""}${c.t}`}
                          </span>
                        ) : (
                          <Note>—</Note>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    <Note>{!online ? "не на связи" : refused ? `keeper: ${refused}` : ok ? `rev ${ok.rev ?? 0}` : "…"}</Note>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Sec>
  );
}
