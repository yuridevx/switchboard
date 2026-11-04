// Машина хозяина не на связи: плашка на машину и перенос её сессий по одной, следующая — после ответа на предыдущую.
import { useEffect, useRef, useState } from "react";
import { Btn, H4, hhmm, M, Note, Opts, plural, Row, Sec, slotChoice, SlotPick, useApp } from "@switchboard/web-ui";
import { usePoints } from "./store.ts";
import type { CheckResult, FleetSession, Slots } from "./store.ts";
import { PickMachine, useChooseTarget } from "./target.tsx";
import { canRaise, folderText, nameOf, refusal } from "./words.ts";

type Item = { s: FleetSession; dir: string; check: CheckResult | null; status: string };
type Moving = { from: string; target: string; slots: Slots | null; slot: string; items: Item[]; started: boolean; done: number };

const nameOfItem = (s: FleetSession) => nameOf(s.callsign ?? s.sid);

function ProgressHead({ m }: { m: Moving }) {
  const total = m.items.length;
  const going = m.done < total && m.items.some((i) => !i.status || i.status.endsWith("…"));
  return (
    <Sec tone={m.done === total ? "ok" : "wait"} role="status" data-progress={`${m.done}/${total}`}>
      <b>{`Перенос с ${m.from} на ${m.target}: ${m.done} из ${total} готовы${going ? " — не закрывайте страницу" : ""}`}</b>
    </Sec>
  );
}

function ItemCheck({ check, target }: { check: CheckResult | null; target: string }) {
  if (!check) return <Note>проверяю папку…</Note>;
  return "error" in check ? <Note tone="bad">{refusal(check.error)}</Note> : <Note>{folderText(check, target)}</Note>;
}

function MoveDialog({ m, pick, chooseSlot, run, close }: { m: Moving; pick(machine: string): void; chooseSlot(slot: string): void; run(): void; close(): void }) {
  const total = m.items.length;
  return (
    <Sec dlg data-dlg="fire">
      <H4>{`Перенести сессии ${m.from} на другую машину`}</H4>
      {m.started ? (
        <ProgressHead m={m} />
      ) : (
        <Row label="Куда">
          <PickMachine cur={m.target} callsign={m.items[0]?.s.callsign} on={pick} />
        </Row>
      )}
      {!m.started && m.slots ? <SlotPick label={`Слот на ${m.target}`} slots={m.slots} value={m.slot} on={chooseSlot} /> : null}
      {m.items.map((i) => (
        <Sec key={i.s.sid} data-row={nameOfItem(i.s)}>
          <b>{nameOfItem(i.s)}</b>
          <Note>{`точка ${hhmm(i.s.head.at)} · №${i.s.head.id}`}</Note>
          {m.started ? (
            <Note>{i.status}</Note>
          ) : (
            <>
              <Opts>
                <M>{i.dir}</M>
              </Opts>
              <ItemCheck check={i.check} target={m.target} />
            </>
          )}
        </Sec>
      ))}
      {m.started ? (
        <Opts>
          <Btn onClick={close}>Закрыть</Btn>
        </Opts>
      ) : (
        <Opts>
          <Btn onClick={close}>Отмена</Btn>
          <Btn pri disabled={!m.target || !m.items.every((i) => canRaise(i.check))} onClick={run}>{`Перенести ${total} из ${total} на ${m.target}`}</Btn>
        </Opts>
      )}
    </Sec>
  );
}

/** Плашка машины: когда ушла, знает модуль машин; идёт перенос — второй не начать. */
function LostMachine({ machine, list, open }: { machine: string; list: FleetSession[]; open: (() => void) | null }) {
  const app = useApp();
  const left = app.use(() => app.mark("machines.left", machine));
  return (
    <Sec tone="bad" data-fire={machine}>
      <b>{`${machine} не на связи${left ? ` с ${hhmm(left)}` : ""} · ${list.length} ${plural(list.length, "сессия ждёт", "сессии ждут", "сессий ждут")} на последних точках`}</b>
      {open ? (
        <Opts>
          <Btn pri onClick={open}>
            Перенести на другую машину…
          </Btn>
        </Opts>
      ) : null}
    </Sec>
  );
}

export function FireSection({ fires }: { fires: Array<[string, FleetSession[]]> }) {
  const app = useApp();
  const points = usePoints();
  const hasRaisers = app.use(() => points.raisers().length > 0);
  const [moving, setMoving] = useState<Moving | null>(null);
  const [running, setRunning] = useState(false);
  // закрыли окно или ушли с экрана: текущая доходит, оставшиеся ждут на точках
  const halted = useRef(false);
  useEffect(() => {
    halted.current = false;
    return () => {
      halted.current = true;
    };
  }, []);
  const choose = useChooseTarget(setMoving);

  const chooseTarget = (target: string, items: Item[]) =>
    choose(target, items.map((i) => ({ sid: i.s.sid, point: i.s.head.id, dir: i.dir })), (m, { slots, checks }) => ({ ...m, slots, slot: slots ? slotChoice(Object.keys(slots)) : "", items: m.items.map((i, n) => ({ ...i, check: checks[n] })) }));

  function open(from: string, list: FleetSession[]) {
    const target = points.raisers()[0] ?? "";
    const items: Item[] = list.map((s) => ({ s, dir: s.dir ?? "~", check: null, status: "" }));
    setMoving({ from, target, slots: null, slot: "", items, started: false, done: 0 });
    void chooseTarget(target, items);
  }

  async function run(m: Moving) {
    halted.current = false;
    setRunning(true);
    setMoving((x) => x && { ...x, started: true });
    const report = (n: number, status: string, done = 0) => setMoving((x) => x && { ...x, done: x.done + done, items: x.items.map((i, k) => (k === n ? { ...i, status } : i)) });
    for (const [n, i] of m.items.entries()) {
      if (halted.current) break;
      report(n, "поднимается…");
      const r = await points.raise({ machine: m.target, sid: i.s.sid, point: i.s.head.id, dir: i.dir, ...(m.slot ? { slot: m.slot } : {}), files: "point" }, i.s.callsign);
      if (r.ok) report(n, `готова — ${r.result.callsign}`, 1);
      else report(n, r.error === "not_owner" ? "уже подняли на другой машине" : `не поднялась: ${refusal(r.error)}`);
    }
    setRunning(false);
    void points.loadFleet();
  }

  function close() {
    halted.current = true;
    setMoving(null);
  }

  return (
    <>
      {fires.map(([machine, list]) => (
        <LostMachine key={machine} machine={machine} list={list} open={!moving && !running && hasRaisers ? () => open(machine, list) : null} />
      ))}
      {moving ? <MoveDialog m={moving} pick={(machine) => void chooseTarget(machine, moving.items)} chooseSlot={(slot) => setMoving((x) => x && { ...x, slot })} run={() => void run(moving)} close={close} /> : null}
    </>
  );
}
