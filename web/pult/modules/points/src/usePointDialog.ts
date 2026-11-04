// Окно действия над точкой: перенос, копия, смена папки, откат. Шаги ведёт страница: каждый запрос — после ответа предыдущего.
import { useState } from "react";
import { machineOf } from "@switchboard/protocol";
import { slotChoice, slotOf } from "@switchboard/web-ui";
import { usePoints } from "./store.ts";
import type { CheckResult, Slots } from "./store.ts";
import { useChooseTarget } from "./target.tsx";
import { nameOf, refusal } from "./words.ts";

export type DialogKind = "move" | "copy" | "dir" | "rb";
export type Dialog = {
  kind: DialogKind;
  target: string;
  from: "fresh" | number;
  slot: string;
  slots: Slots | null;
  dir: string;
  name: string;
  files: "point" | "keep";
  interrupt: boolean;
  check: CheckResult | null;
  phase: "" | "run" | "done" | "err";
  msg: string;
};
export type DialogControl = ReturnType<typeof usePointDialog>;

const movesMachine = (kind: DialogKind) => kind === "move" || kind === "copy";

export function usePointDialog(callsign: string, sid: string, reload: () => void) {
  const points = usePoints();
  const machine = machineOf(callsign) ?? "";
  const name = nameOf(callsign);
  const [current, setCurrent] = useState<Dialog | null>(null);
  const choose = useChooseTarget(setCurrent);

  const pointOf = (d: Dialog) => (d.from === "fresh" ? points.line(sid)?.head : d.from);
  const slotNow = () => slotOf(points.session(callsign))?.name;

  function chooseTarget(d: Dialog, target: string) {
    return choose(target, [{ sid, point: pointOf(d), dir: d.dir }], (x, { slots, checks }) => ({ ...x, slots, slot: slots ? slotChoice(Object.keys(slots), slotNow()) : "", check: checks[0] }));
  }

  /** Заново проверить подъём: слоты цели не пришли — проверка остаётся отказом. */
  async function recheck(d: Dialog) {
    if (!movesMachine(d.kind) || d.slots === null) return;
    const point = pointOf(d);
    const check: CheckResult = typeof point === "number" ? await points.dryRun(d.target, sid, point, d.dir) : { error: "bad_point" };
    setCurrent((x) => x && { ...x, check });
  }

  function open(kind: DialogKind, from: "fresh" | number = "fresh") {
    const dir = points.dirOf(sid);
    const suffix = kind === "copy" ? "-copy" : kind === "dir" ? "-v2" : "";
    const d: Dialog = {
      kind,
      target: movesMachine(kind) ? (points.raisers().find((m) => m !== machine) ?? machine) : machine,
      from,
      slot: "",
      slots: null,
      dir: `${dir}${suffix}`,
      name: `${name}${suffix}`,
      files: movesMachine(kind) ? "point" : "keep",
      interrupt: false,
      check: null,
      phase: "",
      msg: "",
    };
    setCurrent(d);
    if (movesMachine(kind)) void chooseTarget(d, d.target);
  }

  /** Слот копии в новой папке: текущий слот сессии, без него — как в строке выбора. */
  async function slotForNewDir(): Promise<{ slot: string } | { error: string }> {
    const now = slotNow();
    if (now) return { slot: now };
    const got = await points.slotsOf(machine);
    return "error" in got ? got : { slot: slotChoice(Object.keys(got.slots)) };
  }

  const doneText = (d: Dialog, raised: { callsign: string; branch: string | null }, point: number) => {
    switch (d.kind) {
      case "move":
        return `${name} перенесена на ${d.target}: ${raised.callsign}. ${machine} её отпустил.`;
      case "copy":
        return `Копия поднята: ${raised.callsign}. Исходная сессия не менялась.`;
      case "dir":
        return `Копия в новой папке: ${raised.callsign}; ${callsign} забыта, её точки остались в R2.`;
      case "rb":
        return `Откат: ${callsign} поднята из точки №${point}; нынешнее — веткой «до отката»${raised.branch ? `, папка на ветке git ${raised.branch}` : ""}. Новая ссылка claude.ai придёт в roster.`;
    }
  };

  /** Шаги: точка (со стопом, кроме копии), подъём; смена папки — ещё «Забыть» прежнюю. */
  async function run(d: Dialog) {
    const step = (msg: string) => setCurrent((x) => x && { ...x, phase: "run", msg });
    const fail = (word: string) => setCurrent((x) => x && { ...x, phase: "err", msg: d.kind === "dir" && word === "open_failed" ? `Копия не поднялась — «Забыть» не отправлен, ${callsign} остаётся остановленной` : refusal(word, name, d.target, machine) });

    // до остановки сессии: без списка слотов смена папки не начинается
    const dirSlot = d.kind === "dir" ? await slotForNewDir() : null;
    if (dirSlot && "error" in dirSlot) return fail(dirSlot.error);

    let point = typeof d.from === "number" ? d.from : 0;
    const stop = d.kind !== "copy";
    if (stop || d.from === "fresh") {
      step(stop ? `${machine} дожидается конца ответа, останавливает сессию и кладёт точку…` : `${machine} кладёт свежую точку…`);
      const saved = await points.save(callsign, { stop, interrupt: d.interrupt });
      if (!saved.ok) return fail(saved.error);
      if (d.from === "fresh") point = saved.result.point;
    }

    step(`${d.target} поднимает сессию из точки №${point}…`);
    const slot = movesMachine(d.kind) ? d.slot : dirSlot && "slot" in dirSlot ? dirSlot.slot : "";
    const raised = await points.raise({ machine: d.target, sid, point, dir: d.dir, files: d.files, ...(d.kind === "copy" || d.kind === "dir" ? { copy: true, name: d.name } : {}), ...(slot ? { slot } : {}) }, callsign);
    if (!raised.ok) return fail(raised.error);

    if (d.kind === "dir") {
      step(`«Забыть» ${callsign}…`);
      const gone = await points.forget(callsign);
      if (!gone.ok) return fail(gone.error);
    }
    setCurrent((x) => x && { ...x, phase: "done", msg: doneText(d, raised.result, point) });
    reload();
  }

  return {
    current,
    open,
    close: () => setCurrent(null),
    patch: (p: Partial<Dialog>) => setCurrent((x) => x && { ...x, ...p }),
    chooseTarget: (d: Dialog, target: string) => void chooseTarget(d, target),
    /** Поменяли откуда или папку: проверить заново. */
    change: (d: Dialog, p: Partial<Dialog>) => {
      setCurrent((x) => x && { ...x, ...p });
      void recheck({ ...d, ...p });
    },
    run: (d: Dialog) => void run(d),
  };
}
