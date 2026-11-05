// Встроенный экран машины: система, keeper и части, перезапуск упавшей, план в «Выпусках». Встраивает его страница «Аккаунты».
import type { ScreenProps } from "@switchboard/web-core";
import { Btn, Dot, Note, okOf, Opts, Outcome, useApp, useModule, wordOf } from "@switchboard/web-ui";
import type { KeeperAnswers, KeeperPart } from "../../settings/contract.ts";
import type { MachinesState } from "./module.tsx";

const STATE_DOT: Record<string, string> = { running: "idle", failed: "bad" };
const partText = (p: KeeperPart) => [p.version, p.state, p.pid ? `pid ${p.pid}` : ""].filter(Boolean).join(" · ");

export function MachineParts({ params }: ScreenProps) {
  const app = useApp();
  const state = useModule<MachinesState>();
  const machine = params.machine ?? "";
  const { gone, notes } = app.use(() => state.get());
  const answers = app.use(() => (app.mark("keeper.answers") as KeeperAnswers | undefined)?.get() ?? {});
  const answer = okOf(answers[machine]);
  const word = wordOf(answers[machine]);

  return (
    <div className="mc-det" data-machine-parts={machine}>
      {answer ? (
        <div className="mc-kv">
          <span>система</span>
          <span>{answer.os}</span>
          <span>keeper</span>
          <span data-keeper={answer.keeper}>{`${answer.keeper} · план rev ${answer.rev}`}</span>
        </div>
      ) : null}
      {word ? <Note tone="bad">{`keeper.state: ${word}`}</Note> : null}
      {!answer && !word ? <Note>…</Note> : null}
      {answer ? (
        <div className="mc-parts">
          {(answer.parts ?? []).map((p) => (
            <div key={p.part} className="mc-part">
              <Dot kind={STATE_DOT[p.state] ?? "stop"} />
              <span>
                <b>{p.part}</b>{" "}
                <span className={p.state === "failed" ? "v bad" : "v"} data-part={p.part} data-state={p.state}>
                  {partText(p)}
                </span>
                {p.error ? <div className="e">{p.error}</div> : null}
              </span>
              {p.state === "failed" && p.part !== "keeper" ? (
                <Btn className="r" onClick={() => void state.restart(machine, p.part)}>
                  Перезапустить
                </Btn>
              ) : null}
              <Outcome note={notes[`${machine}:${p.part}`]} />
            </div>
          ))}
        </div>
      ) : null}
      {gone[machine] === undefined && app.wide ? (
        <Opts>
          <Btn onClick={() => app.open("settings", { tab: "releases", machine })}>План в «Выпусках»</Btn>
        </Opts>
      ) : null}
    </div>
  );
}
