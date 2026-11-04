// Строка машины и её карточка: части по ответу keeper, перезапуск упавшей части. Строка читает только своё: изменилась другая машина — эта не перерисовывается.
import { memo } from "react";
import { machineOf } from "@switchboard/protocol";
import { Btn, Dot, hhmm, machineLabel, Note, Opts, plural, useApp } from "@switchboard/web-ui";
import { useMachines } from "./store.ts";
import { okOf, stateOf, type Part } from "./store.ts";

/** Строка части: перезапуск упавшей и строка его итога. */
function PartRow({ m, p }: { m: string; p: Part }) {
  const app = useApp();
  const machines = useMachines();
  const n = app.use(() => machines.note(`part:${m}:${p.part}`));
  return (
    <div className="mc-part">
      <Dot kind={p.state === "running" ? "idle" : p.state === "failed" ? "bad" : "stop"} />
      <span>
        <b>{p.part}</b>{" "}
        <span className={p.state === "failed" ? "v bad" : "v"} data-part={p.part} data-state={p.state ?? ""}>
          {[p.version, p.state, p.pid ? `pid ${p.pid}` : ""].filter(Boolean).join(" · ")}
        </span>
        {p.error ? <div className="e">{p.error}</div> : null}
      </span>
      {p.state === "failed" && p.part !== "keeper" && app.worker("releases") ? (
        <Btn className="r" onClick={() => void machines.restart(m, p.part)}>
          Перезапустить
        </Btn>
      ) : null}
      {n?.text ? (
        <Note tone={n.tone} role="status">
          {n.text}
        </Note>
      ) : null}
    </div>
  );
}

/** Карточка машины: система, keeper, части и переходы. */
function Detail({ m }: { m: string }) {
  const app = useApp();
  const machines = useMachines();
  const st = app.use(() => machines.states()[m] ?? null);
  const on = app.use(() => machines.gone()[m] === undefined);
  const login = app.use(() => app.can(m, "machine.login"));
  const ok = okOf(st);
  return (
    <div className="mc-det" data-machine={m}>
      {ok ? (
        <div className="mc-kv">
          <span>система</span>
          <span>{ok.os ?? "?"}</span>
          <span>keeper</span>
          <span data-keeper={ok.keeper ?? ""}>{`${ok.keeper ?? "?"} · план rev ${ok.rev ?? 0}`}</span>
        </div>
      ) : st && "error" in st ? (
        <Note tone="bad">{`keeper.state: ${st.error}`}</Note>
      ) : on ? (
        <Note>…</Note>
      ) : null}
      {ok ? (
        <div className="mc-parts">
          {(ok.parts ?? []).map((p) => (
            <PartRow key={p.part} m={m} p={p} />
          ))}
        </div>
      ) : null}
      {on ? (
        <Opts>
          {login ? <Btn onClick={() => app.open("accounts", { machine: m })}>Аккаунты машины</Btn> : null}
          {app.wide ? <Btn onClick={() => app.open("settings", { tab: "releases", machine: m })}>План в «Выпусках»</Btn> : null}
        </Opts>
      ) : null}
    </div>
  );
}

export const MachineRow = memo(function MachineRow({ m, open, toggle }: { m: string; open: boolean; toggle(m: string): void }) {
  const app = useApp();
  const machines = useMachines();
  const d = app.use(() => {
    const ok = okOf(machines.states()[m]);
    return {
      st: stateOf(m, machines.states(), machines.gone()),
      os: ok?.os ?? "",
      host: ok?.parts?.find((p) => p.part === "host")?.version,
      keeper: ok?.keeper,
      at: machines.gone()[m] ?? 0,
      n: (app.roster()?.sessions ?? []).filter((s) => machineOf(s.callsign) === m).length,
      name: machineLabel(app, m).text,
    };
  });
  const text = d.st === "gone" ? `ушла ${hhmm(d.at)}` : d.st === "fail" ? "сбой части" : "на связи";
  return (
    <>
      <div className="mc-row" data-row={m} data-state={d.st}>
        <button className="mc-head" aria-expanded={open ? "true" : "false"} onClick={() => toggle(m)}>
          <Dot kind={d.st === "ok" ? "idle" : d.st === "gone" ? "gone" : "bad"} />
          <span className="n">{d.name}</span>
          <span className="os">{d.os}</span>
          <span className="v">{d.host ? `host ${d.host}` : ""}</span>
          <span className="v">{d.keeper ? `keeper ${d.keeper}` : ""}</span>
          <span className="st">{[d.n ? `${d.n} ${plural(d.n, "сессия", "сессии", "сессий")}` : "", text].filter(Boolean).join(" · ")}</span>
        </button>
      </div>
      {open ? <Detail m={m} /> : null}
    </>
  );
});
