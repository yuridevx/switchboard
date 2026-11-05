// Куда поднимается точка: машина, её слоты и проба папки. Общее для окон подъёма, переноса, копии и «пожара».
import { useState } from "react";
import { type Result, machinesWith, Note, PickOne, Row, slotChoice, type SlotInfo, SlotPick, useApp, useLoad } from "@switchboard/web-ui";
import { type Check, folderCheck, type Probe, wordText } from "./words.ts";

export const PENDING: Check = { key: "pending", text: "проверяю папку…" };

/** Машина подъёма и её слот. Слот уходит в запрос, только когда есть из чего выбирать. */
export function useTarget(first: (machines: string[]) => string, preferred = "") {
  const app = useApp();
  const machines = app.use(() => machinesWith(app, "points.raise"));
  const [picked, setPicked] = useState("");
  const [slotName, setSlotName] = useState(preferred);
  const machine = picked || first(machines);
  const answer = useLoad(() => app.read<{ slots?: Record<string, SlotInfo> }>("machine.accounts", { machine }), [machine]);
  const slots = answer.loading ? undefined : answer.data?.slots;
  const slot = slotChoice(Object.keys(slots ?? {}), slotName);
  return { machines, machine, pick: setPicked, slots, slot, setSlot: setSlotName, slotsError: answer.loading ? "" : answer.error, ready: !answer.loading && !answer.error };
}

export type Target = ReturnType<typeof useTarget>;

/** Строка выбора машины; ближние (проект, своя) — кнопками. */
export function MachineRow({ label, t, near = [] }: { label: string; t: Target; near?: string[] }) {
  return (
    <Row label={label}>
      <div className="sb-opts">
        <PickOne all={t.machines} near={near} cur={t.machine} on={t.pick} select={{ "data-f": "target", "aria-label": "Другая машина" }} />
      </div>
    </Row>
  );
}

/** Слот; в окне одной сессии — вместе с итогом пробы, пока она идёт, строки нет. */
export function SlotRow({ t, label, check }: { t: Target; label?: string; check?: Check }) {
  return t.slots && check?.key !== "pending" ? <SlotPick slots={t.slots} value={t.slot} on={t.setSlot} label={label} /> : null;
}

export function CheckLine({ check }: { check: Check }) {
  if (check.key === "pending") return null;
  return (
    <Note data-check={check.key} tone={check.tone}>
      {check.text}
    </Note>
  );
}

const NOT_ASKED = Promise.resolve({ ok: false, error: "" } as const);

/** Проба папки: только читает. Без неё слоты не пришли — запрос не уходит. */
export function useProbe(t: Target, body: { sid: string; point?: number; dir: string } | null): Check {
  const app = useApp();
  const ready = t.ready && !!body && body.point !== undefined;
  const asked = useLoad(() => (ready ? app.read<Probe>("points.raise", { machine: t.machine, ...body, files: "point", dryRun: true }) : (NOT_ASKED as Promise<Result<Probe>>)), [ready, t.machine, JSON.stringify(body)]);
  if (t.slotsError) return { key: "error", text: `machine.accounts: ${t.slotsError}`, tone: "bad" };
  if (t.slots && !Object.keys(t.slots).length) return { key: "error", text: `На ${t.machine} нет слотов: войдите в аккаунт на этой машине`, tone: "bad" };
  if (!ready || asked.loading) return PENDING;
  if (asked.error) return { key: "error", text: wordText(asked.error), tone: "bad" };
  return asked.data ? folderCheck(asked.data, t.machine) : PENDING;
}

/** Запуск возможен: проверка пришла и папка годится. */
export const runnable = (c: Check) => c.key !== "pending" && c.key !== "error" && c.key !== "other";
