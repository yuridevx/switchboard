// Цель подъёма — общее у трёх окон: выбор машины, её слоты, проверка папки.
import type { Dispatch, SetStateAction } from "react";
import { Note, Opts, PickOne, useApp } from "@switchboard/web-ui";
import { usePoints } from "./store.ts";
import type { CheckResult, PointsStore, Raising } from "./store.ts";
import { folderText, refusal } from "./words.ts";

type Probe = Awaited<ReturnType<PointsStore["probe"]>>;

/** Выбрать цель: машина — сразу, слоты и проверка — когда ответит; выбрали другую, пока шёл ответ, — ответ устарел. */
export function useChooseTarget<D extends { target: string }>(set: Dispatch<SetStateAction<D | null>>) {
  const points = usePoints();
  return async (target: string, raises: Raising[], apply: (d: D, p: Probe) => D) => {
    set((d) => d && { ...d, target });
    const p = await points.probe(target, raises);
    set((d) => (d && d.target === target ? apply(d, p) : d));
  };
}

/** Строка проверки папки в окне: отказ словом или что будет. */
export function CheckLine({ check, target }: { check: CheckResult | null; target: string }) {
  if (!check) return null;
  if ("error" in check) {
    return (
      <Note tone="bad" data-check="error">
        {refusal(check.error)}
      </Note>
    );
  }
  return (
    <Note tone={check.folder === "other" ? "bad" : check.folder === "dirty" ? "wait" : "ok"} data-check={check.folder}>
      {folderText(check, target)}
    </Note>
  );
}

/** Выбор машины: выбранная и машины проекта сессии — кнопками, остальные — списком. */
export function PickMachine({ cur, callsign, on }: { cur: string; callsign: string | undefined; on(machine: string): void }) {
  const app = useApp();
  const points = usePoints();
  const near = app.use(() => {
    const project = callsign ? app.mark("project.of", callsign)?.id : null;
    return project ? (app.mark("project.machines", project) ?? []) : [];
  });
  const all = app.use(points.raisers);
  return (
    <Opts>
      <PickOne all={all} near={near} cur={cur} on={on} select={{ "data-f": "target", "aria-label": "Другая машина" }} />
    </Opts>
  );
}
