// Матрица выпусков: машина × часть по ответам keeper'ов и плану; поиск, отметка машин, выбор машины для её плана.
import { useState } from "react";
import { Dot, In, Note, okOf, PageHead, plural, RowBtn, Sec, Switch, useApp } from "@switchboard/web-ui";
import { useSettings } from "./store.ts";
import { cellOf, type Listed, machineParts, relMachines } from "./rules.ts";

export function Matrix({ list, rm, pick }: { list: Listed; rm: string | null; pick(m: string | null): void }) {
  const app = useApp();
  const settings = useSettings();
  const d = app.use(() => settings.releaseData(list));
  const [rq, setRq] = useState("");
  const rsel = app.use(() => settings.get().rsel);
  const parts = machineParts(d);
  const q = rq.trim().toLowerCase();
  const ms = relMachines(d).filter((m) => !q || m.toLowerCase().includes(q));
  return (
    <Sec className="st-matrix">
      <PageHead>
        <In className="st-rq" data-f="rq" placeholder="Найти машину" aria-label="Найти машину" value={rq} onInput={(e) => setRq(e.currentTarget.value)} />
        <Note className="st-end">{`${ms.length} ${plural(ms.length, "машина", "машины", "машин")}`}</Note>
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
            {ms.map((m) => {
              const st = d.kst[m];
              const online = d.online.includes(m);
              const ok = okOf(st);
              const tone = !online ? "stop" : st && !ok ? "wait" : parts.some((p) => cellOf(d, m, p)?.k === "fail") ? "wait" : "idle";
              return (
                <tr key={m} data-machine={m} aria-current={rm === m ? "true" : undefined}>
                  <td>
                    <Switch className="st-ck" role="checkbox" on={!!rsel[m]} aria-label={`Выбрать ${m}`} onClick={() => settings.toggleSelected(m)}>
                      {rsel[m] ? "✓" : ""}
                    </Switch>
                  </td>
                  <td>
                    <RowBtn className="st-mn" onClick={() => pick(rm === m ? null : m)}>
                      <Dot kind={tone} />
                      {`@${m}`}
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
                    <Note>{ok ? `rev ${ok.rev ?? 0}` : !online ? "не на связи" : st && "error" in st ? `keeper: ${st.error}` : "…"}</Note>
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
