// Состояние открытого экрана: вид, диалог, выбранная машина слотов, строки итогов. Карточки берут его из контекста.
import { createContext, useContext, useMemo, useRef, useState } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { type Result, useApp, useOutcome } from "@switchboard/web-ui";
import type {} from "@switchboard/web-board";
import { useAccounts } from "./store.ts";

type Dialog = null | { kind: "new"; id: number; machine: string } | { kind: "sess"; machine: string; slot: string } | { kind: "rm"; machine: string; account: string };

export function useAccountsScreen(params: ScreenProps["params"]) {
  const app = useApp();
  const store = useAccounts();
  const dialogs = useRef(1);
  const [view, setView] = useState(params.view === "slots" ? "slots" : "accounts");
  const [dialog, setDialog] = useState<Dialog>(() => (params.machine && app.can(params.machine, "machine.login") ? { kind: "new", id: dialogs.current++, machine: params.machine } : null));
  const [picked, setPicked] = useState<string | null>(null);
  /** почта, у которой открыт выбор машины для входа */
  const [pickFor, setPickFor] = useState("");
  const [notes, note] = useOutcome();

  // машина из адреса может прийти позже первого roster: выбрать её, пока человек не выбрал другую
  const fromAddress = app.use(() => (params.machine && app.can(params.machine, "machine.accounts") ? params.machine : ""));
  const first = app.use(() => store.machines("machine.accounts")[0] ?? "");
  const project = app.use(() => app.mark("project.current"));
  const near = app.use(() => (project ? (app.mark("project.machines", project) ?? []) : []));
  const slotMachine = picked ?? (fromAddress || first);

  return useMemo(() => {
    /** Действие со строкой итога: пока идёт — pending, потом итог. */
    function act(key: string, pending: string | null, run: Promise<Result<string>>, done?: () => void) {
      if (pending) note(key, pending);
      void run.then((r) => {
        if (r.ok) done?.();
        note(key, r.ok ? r.result : r.error, r.ok ? "ok" : "bad");
      });
    }
    return {
      view,
      setView,
      dialog,
      setDialog,
      openNew: (machine: string) => setDialog({ kind: "new", id: dialogs.current++, machine }),
      slotMachine,
      pickSlotMachine: setPicked,
      pickFor,
      setPickFor,
      notes,
      /** машины открытого проекта */
      near,
      swap: (m: string, slot: string, account: string) => act(`swap:${m}:${slot}`, "Меняю…", store.swap(m, slot, account)),
      setOrder: (m: string, slot: string, order: string[]) => act(`set:${m}:${slot}`, "Сохраняю…", store.setOrder(m, slot, order)),
      moveSessions: (m: string, callsigns: string[], target: string) => act(`move:${m}`, null, store.moveSessions(m, callsigns, target)),
      remove: (m: string, account: string, next: string) => act(`rm:${m}:${account}`, "Удаляю…", store.remove(m, account, next), () => setDialog(null)),
    };
  }, [store, view, dialog, slotMachine, pickFor, notes, note, near]);
}

const Screen = createContext<ReturnType<typeof useAccountsScreen> | null>(null);
export const ScreenProvider = Screen.Provider;
export const useScreen = () => useContext(Screen)!;
