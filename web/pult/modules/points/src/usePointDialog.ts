// Диалог действия над точкой вкладки: перенос, копия, смена папки, откат. Шаги ведёт страница: каждый запрос — после ответа предыдущего.
import { slotOf } from "@switchboard/web-ui";
import { useState } from "react";
import { machineOf } from "@switchboard/protocol";
import { usePoints } from "./store.ts";
import { nameOf, say } from "./format.ts";
import type { CheckResult } from "./store.ts";
import { useTargetPick } from "./useTargetPick.ts";

export type DialogKind = "move" | "copy" | "dir" | "rb";
export type Dialog = {
  kind: DialogKind;
  target: string;
  from: "fresh" | number;
  slot: string;
  slots: string[] | null;
  dir: string;
  name: string;
  files: "point" | "keep";
  interrupt: boolean;
  check: CheckResult | null;
  phase: "" | "run" | "done" | "err";
  msg: string;
};
export type DialogControl = ReturnType<typeof usePointDialog>;

export function usePointDialog(callsign: string, sid: string, reload: () => void) {
  const points = usePoints();
  const machine = machineOf(callsign) ?? "";
  const [dlg, setDlg] = useState<Dialog | null>(null);
  const pick = useTargetPick(setDlg);

  async function check(d: Dialog) {
    // слоты цели не пришли — проверка остаётся отказом, подъём недоступен
    if ((d.kind !== "move" && d.kind !== "copy") || d.slots === null) return;
    const point = d.from === "fresh" ? points.line(sid)?.head : d.from;
    const c: CheckResult = typeof point === "number" ? await points.dry(d.target, sid, point, d.dir) : { error: "bad_point" };
    setDlg((x) => x && { ...x, check: c });
  }

  function pickTarget(d: Dialog, m: string) {
    const point = d.from === "fresh" ? points.line(sid)?.head : d.from;
    const cur = String(slotOf(points.session(callsign))?.name);
    return pick(m, [{ sid, point, dir: d.dir }], (x, { slots, checks }) => ({ ...x, slots, slot: slots ? (slots.includes(cur) ? cur : (slots[0] ?? "")) : x.slot, check: checks[0] }));
  }

  function open(kind: DialogKind, from: "fresh" | number = "fresh") {
    const name = nameOf(callsign);
    const dir = points.dirOf(sid);
    const target = kind === "dir" || kind === "rb" ? machine : (points.raisers().find((m) => m !== machine) ?? machine);
    const d: Dialog = {
      kind,
      target,
      from,
      slot: "",
      slots: null,
      dir: kind === "copy" ? `${dir}-copy` : kind === "dir" ? `${dir}-v2` : dir,
      name: kind === "copy" ? `${name}-copy` : kind === "dir" ? `${name}-v2` : name,
      files: kind === "dir" || kind === "rb" ? "keep" : "point",
      interrupt: false,
      check: null,
      phase: "",
      msg: "",
    };
    setDlg(d);
    if (kind === "move" || kind === "copy") void pickTarget(d, target);
  }

  /** Шаги диалога: точка (со стопом, кроме копии), затем подъём; смена папки — ещё «Забыть» прежнюю. */
  async function run(d: Dialog) {
    const step = (msg: string) => setDlg((x) => x && { ...x, phase: "run", msg });
    const fail = (w: string) => setDlg((x) => x && { ...x, phase: "err", msg: d.kind === "dir" && w === "open_failed" ? `Копия не поднялась — «Забыть» не отправлен, ${callsign} остаётся остановленной` : say(w, nameOf(callsign), d.target, machine) });
    let point = typeof d.from === "number" ? d.from : 0;
    const stop = d.kind !== "copy";
    if (stop || d.from === "fresh") {
      step(stop ? `${machine} дожидается конца ответа, останавливает сессию и кладёт точку…` : `${machine} кладёт свежую точку…`);
      const s = await points.savePoint(callsign, { stop, interrupt: d.interrupt });
      if (!s.ok) return fail(s.error);
      if (d.from === "fresh") point = s.result.point;
    }
    step(`${d.target} поднимает сессию из точки №${point}…`);
    const body: Record<string, unknown> = { machine: d.target, sid, point, dir: d.dir, files: d.files };
    if (d.kind === "copy" || d.kind === "dir") Object.assign(body, { copy: true, name: d.name });
    if (d.slot && (d.kind === "move" || d.kind === "copy")) body.slot = d.slot;
    const r = await points.raise(body);
    if (!r.ok) return fail(r.error);
    points.keepProject(callsign, r.result.callsign);
    if (d.kind === "dir") {
      step(`«Забыть» ${callsign}…`);
      const rm = await points.forget(callsign);
      if (!rm.ok) return fail(rm.error);
    }
    const msg =
      d.kind === "move"
        ? `${nameOf(callsign)} перенесена на ${d.target}: ${r.result.callsign}. ${machine} её отпустил.`
        : d.kind === "copy"
          ? `Копия поднята: ${r.result.callsign}. Исходная сессия не менялась.`
          : d.kind === "dir"
            ? `Копия в новой папке: ${r.result.callsign}; ${callsign} забыта, её точки остались в R2.`
            : `Откат: ${callsign} поднята из точки №${point}; нынешнее — веткой «до отката»${r.result.branch ? `, папка на ветке git ${r.result.branch}` : ""}. Новая ссылка claude.ai придёт в roster.`;
    setDlg((x) => x && { ...x, phase: "done", msg });
    reload();
  }

  return {
    dlg,
    open,
    close: () => setDlg(null),
    patch: (p: Partial<Dialog>) => setDlg((x) => x && { ...x, ...p }),
    pickTarget: (d: Dialog, m: string) => void pickTarget(d, m),
    /** Выбор откуда и готовая папка: заново проверить подъём. */
    recheck: (d: Dialog, p: Partial<Dialog>) => {
      setDlg((x) => x && { ...x, ...p });
      void check({ ...d, ...p });
    },
    run: (d: Dialog) => void run(d),
  };
}
