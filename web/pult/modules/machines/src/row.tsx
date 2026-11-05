// Строка машины и её карточка: части по ответу keeper, перезапуск упавшей части. Строка читает только своё: изменилась другая машина — эта не перерисовывается.
import { memo } from "react";
import { machineOf } from "@switchboard/protocol";
import { Btn, DisclosureBtn, Dot, hhmm, machineLabel, Note, okOf, Opts, Outcome, type OutcomeNote, plural, useApp, useOutcome } from "@switchboard/web-ui";
import { conditionOf, useMachines, type Part } from "./state.ts";

const PART_DOT: Record<string, string> = { running: "idle", failed: "bad" };

/** Строка части: перезапуск упавшей и строка его итога. */
function PartRow({ p, note, restart }: { p: Part; note?: OutcomeNote; restart(part: string): void }) {
  const app = useApp();
  return (
    <div className="mc-part">
      <Dot kind={PART_DOT[p.state ?? ""] ?? "stop"} />
      <span>
        <b>{p.part}</b>{" "}
        <span className={p.state === "failed" ? "v bad" : "v"} data-part={p.part} data-state={p.state ?? ""}>
          {[p.version, p.state, p.pid ? `pid ${p.pid}` : ""].filter(Boolean).join(" · ")}
        </span>
        {p.error ? <div className="e">{p.error}</div> : null}
      </span>
      {p.state === "failed" && p.part !== "keeper" && app.worker("releases") ? (
        <Btn className="r" onClick={() => restart(p.part)}>
          Перезапустить
        </Btn>
      ) : null}
      <Outcome note={note} />
    </div>
  );
}

/** Карточка машины: система, keeper, части и переходы. */
function Detail({ m, notes, restart }: { m: string; notes: Readonly<Record<string, OutcomeNote>>; restart(part: string): void }) {
  const app = useApp();
  const machines = useMachines();
  const answer = app.use(() => machines.answers()[m] ?? null);
  const online = app.use(() => machines.gone()[m] === undefined);
  const canLogin = app.use(() => app.can(m, "machine.login"));
  const ok = okOf(answer);
  return (
    <div className="mc-det" data-machine={m}>
      {ok ? (
        <div className="mc-kv">
          <span>система</span>
          <span>{ok.os ?? "?"}</span>
          <span>keeper</span>
          <span data-keeper={ok.keeper ?? ""}>{`${ok.keeper ?? "?"} · план rev ${ok.rev ?? 0}`}</span>
        </div>
      ) : answer && "error" in answer ? (
        <Note tone="bad">{`keeper.state: ${answer.error}`}</Note>
      ) : online ? (
        <Note>…</Note>
      ) : null}
      {ok ? (
        <div className="mc-parts">
          {(ok.parts ?? []).map((p) => (
            <PartRow key={p.part} p={p} note={notes[p.part]} restart={restart} />
          ))}
        </div>
      ) : null}
      {online ? (
        <Opts>
          {canLogin ? <Btn onClick={() => app.open("accounts", { machine: m })}>Аккаунты машины</Btn> : null}
          {app.wide ? <Btn onClick={() => app.open("settings", { tab: "releases", machine: m })}>План в «Выпусках»</Btn> : null}
        </Opts>
      ) : null}
    </div>
  );
}

export const MachineRow = memo(function MachineRow({ m, open, toggle }: { m: string; open: boolean; toggle(m: string): void }) {
  const app = useApp();
  const machines = useMachines();
  // строка итога — у строки машины: переживает свёртку карточки
  const [notes, say] = useOutcome();
  const restart = (part: string) => {
    say(part, "Перезапускаю…");
    void machines.restart(m, part).then((r) => say(part, r.ok ? r.result : r.error, r.ok ? "ok" : "bad"));
  };
  const d = app.use(() => {
    const ok = okOf(machines.answers()[m]);
    return {
      condition: conditionOf(m, machines.answers(), machines.gone()),
      os: ok?.os ?? "",
      host: ok?.parts?.find((p) => p.part === "host")?.version,
      keeper: ok?.keeper,
      at: machines.gone()[m] ?? 0,
      n: (app.roster()?.sessions ?? []).filter((s) => machineOf(s.callsign) === m).length,
      name: machineLabel(app, m).text,
    };
  });
  const text = d.condition === "gone" ? `ушла ${hhmm(d.at)}` : d.condition === "fail" ? "сбой части" : "на связи";
  return (
    <>
      <div className="mc-row" data-row={m} data-state={d.condition}>
        <DisclosureBtn className="mc-head" open={open} onClick={() => toggle(m)}>
          <Dot kind={d.condition === "ok" ? "idle" : d.condition === "gone" ? "gone" : "bad"} />
          <span className="n">{d.name}</span>
          <span className="os">{d.os}</span>
          <span className="v">{d.host ? `host ${d.host}` : ""}</span>
          <span className="v">{d.keeper ? `keeper ${d.keeper}` : ""}</span>
          <span className="st">{[d.n ? `${d.n} ${plural(d.n, "сессия", "сессии", "сессий")}` : "", text].filter(Boolean).join(" · ")}</span>
        </DisclosureBtn>
      </div>
      {open ? <Detail m={m} notes={notes} restart={restart} /> : null}
    </>
  );
});
