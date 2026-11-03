// Общие части диалогов: строка проверки папки, поле папки, выбор машины.
import { useEffect, useRef } from "react";
import { useApp } from "@switchboard/web-core";
import { In, Note, Opts, PickOne } from "@switchboard/web-ui";
import { usePoints } from "./context.ts";
import { folderText, say } from "./format.ts";
import type { CheckResult } from "./store.ts";

/** Проверка папки диалога: отказ или что будет с папкой. */
export function CheckLine({ check, target }: { check: CheckResult | null; target: string }) {
  if (!check) return null;
  if ("error" in check) {
    return (
      <Note tone="bad" data-check="error">
        {say(check.error)}
      </Note>
    );
  }
  return (
    <Note tone={check.folder === "other" ? "bad" : check.folder === "dirty" ? "wait" : "ok"} data-check={check.folder}>
      {folderText(check, target)}
    </Note>
  );
}

/** Поле папки: каждая буква — в onInput, готовое значение (браузерное change: уход с поля, Enter) — в onCommit. */
export function DirInput({ value, onInput, onCommit }: { value: string; onInput(v: string): void; onCommit(v: string): void }) {
  const field = useRef<HTMLInputElement>(null);
  // в React onChange — на каждую букву: готовое значение даёт только событие браузера
  useEffect(() => {
    const el = field.current!;
    const commit = () => onCommit(el.value);
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, [onCommit]);
  return <In ref={field} mono data-f="dir" value={value} onInput={(e) => onInput(e.currentTarget.value)} />;
}

/** Выбор машины подъёма: выбранная и машины проекта сессии (метки web-board) — кнопками, остальные — списком. */
export function PickMachine({ cur, callsign, on }: { cur: string; callsign: string | undefined; on(m: string): void }) {
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
