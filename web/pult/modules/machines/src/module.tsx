// Машины флота: кто на связи и кто ушёл, части машины по ответу её keeper. Ответы keeper — у модуля настроек.
import { useState } from "react";
import type { AppPart, Roster, ScreenProps } from "@switchboard/web-core";
import { Btn, Note, okOf, wordOf } from "@switchboard/web-ui";
import type { KeeperAnswers, KeeperPart, KeeperState } from "../../settings/contract.ts";
import css from "./machines.css";

export type MachineRowInfo = { machine: string; state: "ok" | "fail" | "gone"; at?: number };

const failedIn = (k: KeeperState | undefined) => !!k?.parts.some((p) => p.state === "failed");

export const createMachines = ((app) => {
  /** машины, которые страница видела на связи */
  const known = new Set<string>();
  /** ушедшие при открытой странице: машина → когда */
  let gone: Readonly<Record<string, number>> = {};
  /** ушедшие раньше: ответ журнала флота */
  const left = new Map<string, number | undefined>();
  /** итог перезапуска части: живёт у строки машины, свёртка его не теряет */
  const notes = new Map<string, string>();

  const answers = () => (app.mark("keeper.answers") ?? {}) as KeeperAnswers;

  function onRoster(r: Roster) {
    const here = new Set(r.machines.map((m) => m.machine));
    const next = { ...gone };
    for (const m of here) {
      known.add(m);
      delete next[m];
      left.delete(m);
    }
    for (const m of known) if (!here.has(m)) next[m] ??= Date.now();
    gone = next;
  }

  function rows(): MachineRowInfo[] {
    const list = [...known].sort().map((machine): MachineRowInfo => {
      if (Object.hasOwn(gone, machine)) return { machine, state: "gone", at: gone[machine] };
      return { machine, state: failedIn(okOf(answers()[machine])) ? "fail" : "ok" };
    });
    return [...list.filter((m) => m.state === "fail"), ...list.filter((m) => m.state !== "fail")];
  }

  async function readLeft(machine: string) {
    if (!machine || left.has(machine) || Object.hasOwn(gone, machine)) return;
    left.set(machine, undefined);
    const r = await app.read<{ events: Array<{ t: number; ev: string }> }>("ledger.read", { machine, limit: 1 });
    const last = r.ok ? r.result.events[0] : undefined;
    if (last?.ev === "machine.left") left.set(machine, last.t);
    app.changed();
  }

  function Part({ machine, part, online }: { machine: string; part: KeeperPart; online: boolean }) {
    const [busy, setBusy] = useState(false);
    async function restart() {
      setBusy(true);
      for (const on of [false, true]) {
        const r = await app.request("releases.set", { machine, part: part.part, on });
        if (!r.ok) {
          notes.set(machine, `releases.set: ${r.error}`);
          setBusy(false);
          return app.changed();
        }
      }
      notes.set(machine, `${part.part} выключена и включена по плану`);
      setBusy(false);
      app.run("keeper.reload", { machine });
    }
    const failed = part.state === "failed";
    return (
      <div className="mc-part">
        <b>{part.part}</b>
        <span className={failed ? "v bad" : "v"} data-part={part.part} data-state={part.state}>
          {[part.version, part.state, part.pid && `pid ${part.pid}`].filter(Boolean).join(" · ")}
        </span>
        {part.error && <span className="e">{part.error}</span>}
        {failed && online && part.part !== "keeper" && (
          <Btn className="r" disabled={busy} onClick={() => void restart()}>
            {busy ? "Перезапускаю…" : "Перезапустить"}
          </Btn>
        )}
      </div>
    );
  }

  function Parts({ params }: ScreenProps) {
    const { machine } = params;
    const answer = app.use(() => answers()[machine]);
    const online = app.use(() => !Object.hasOwn(gone, machine));
    const note = app.use(() => notes.get(machine) ?? "");
    const k = okOf(answer);
    const word = wordOf(answer);
    return (
      <div className="mc-det" data-machine-parts={machine}>
        {k && (
          <div className="mc-kv">
            <span>система</span>
            <span>{k.os}</span>
            <span>keeper</span>
            <span data-keeper="1">{`${k.keeper} · план rev ${k.rev}`}</span>
          </div>
        )}
        {word && <Note tone="bad">{`keeper.state: ${word}`}</Note>}
        {!k && !word && <Note>…</Note>}
        {k && (
          <div className="mc-parts">
            {k.parts.map((p) => (
              <Part key={p.part} machine={machine} part={p} online={online} />
            ))}
          </div>
        )}
        {note && <Note>{note}</Note>}
        {online && <Btn onClick={() => app.open("settings", { tab: "releases", machine })}>План в «Выпусках»</Btn>}
      </div>
    );
  }

  return {
    css,
    on: { roster: onRoster },
    marks: {
      "machines.rows": rows,
      "machines.gone": () => gone,
      "machines.left": (machine: string) => gone[machine] ?? left.get(machine),
    },
    commands: { "machines.left.read": { run: (p) => void readLeft(p.machine) } },
    screens: { "machine.parts": { view: Parts } },
  };
}) satisfies AppPart["module"];
