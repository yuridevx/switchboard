// Состояние открытого экрана: вид, диалог, выбранная машина слотов, строки итогов. Живёт, пока экран открыт; карточки берут его из контекста.
import { useMemo, useRef, useState } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { type Result, useApp, useOutcome } from "@switchboard/web-ui";
import type {} from "@switchboard/web-board";
import { useAccounts } from "./store.ts";

export type Dlg = null | { kind: "new"; id: number; machine: string } | { kind: "sess"; machine: string; slot: string } | { kind: "rm"; machine: string; account: string };

export function useAccountsScreen(params: ScreenProps["params"]) {
  const app = useApp();
  const store = useAccounts();
  const ids = useRef(1);
  const [view, setView] = useState(params.view === "slots" ? "slots" : "accounts");
  const [dlg, setDlg] = useState<Dlg>(() => (params.machine && app.can(params.machine, "machine.login") ? { kind: "new", id: ids.current++, machine: params.machine } : null));
  const [picked, setPicked] = useState<string | null>(null);
  /** почта, у которой открыт выбор машины для входа */
  const [pickFor, setPickFor] = useState("");
  const [notes, say] = useOutcome();

  // машина из адреса может прийти позже первого roster: выбрать её, пока человек не выбрал другую
  const fromAddress = app.use(() => (params.machine && app.can(params.machine, "machine.slots") ? params.machine : ""));
  const first = app.use(() => store.machines("machine.slots")[0] ?? "");
  const slotMachine = picked ?? (fromAddress || first);

  const proj = app.use(() => app.mark("project.current"));
  const near = app.use(() => (proj ? (app.mark("project.machines", proj) ?? []) : []));

  return useMemo(() => {
    /** Итог действия — в строку экрана. */
    const put = (k: string) => (r: Result<string>) => say(k, r.ok ? r.result : r.error, r.ok ? "ok" : "bad");
    return {
      view,
      setView,
      dlg,
      setDlg,
      openNew: (machine: string) => setDlg({ kind: "new", id: ids.current++, machine }),
      slotMachine,
      pickSlotMachine: setPicked,
      pickFor,
      setPickFor,
      notes,
      /** машины открытого проекта */
      near,
      swap: (m: string, slot: string, account: string) => {
        say(`swap:${m}:${slot}`, "Меняю…");
        void store.swap(m, slot, account).then(put(`swap:${m}:${slot}`));
      },
      setOrder: (m: string, slot: string, order: string[]) => {
        say(`set:${m}:${slot}`, "Сохраняю…");
        void store.setOrder(m, slot, order).then(put(`set:${m}:${slot}`));
      },
      moveSessions: (m: string, list: string[], target: string) => void store.moveSessions(m, list, target).then(put(`move:${m}`)),
      remove: (m: string, account: string, next: string) => {
        const k = `rm:${m}:${account}`;
        void store
          .remove(m, account, next, (step) => say(k, step))
          .then((r) => {
            if (r.ok) setDlg(null);
            put(k)(r);
          });
      },
    };
  }, [store, view, dlg, slotMachine, pickFor, notes, say, near]);
}

export type AccountsScreenState = ReturnType<typeof useAccountsScreen>;
