// Куда поднимать: машина, её слоты, проба папки и новая сессия в проекте исходной. Одно на все окна подъёма.
import { useState } from "react";
import type { App } from "@switchboard/web-core";
import { machinesWith, Opts, PickOne, Row, slotChoice, SlotPick, useApp, useLoad, useMachineLoad } from "@switchboard/web-ui";
import { checkOf, refused, type Check, type Probe } from "./words.ts";

/** До стольких машин все — кнопками; больше — ближние кнопками, остальные списком. */
const FEW_MACHINES = 6;

type Slots = Record<string, { wait: number | null }>;

/** near — кнопками при любом числе машин; нет — только выбранная, остальные списком. */
export function useTarget(o: { owner?: string; near?: string[]; slot?: string } = {}) {
  const app = useApp();
  const machines = app.use(() => machinesWith(app, "points.raise"));
  const [picked, setPicked] = useState<string>();
  const [slotPicked, setSlot] = useState<string>();
  const machine = picked ?? machines.find((m) => m !== o.owner) ?? machines[0] ?? "";
  const accounts = useMachineLoad<{ slots: Slots }>(machine, "machine.accounts");
  const slots = accounts.stale ? undefined : accounts.data?.slots;
  const names = Object.keys(slots ?? {});
  const problem = accounts.error ? `machine.accounts: ${accounts.error}` : slots && !names.length ? `На ${machine} нет слотов: войдите в аккаунт на этой машине` : "";
  return { machines, machine, near: o.near && machines.length <= FEW_MACHINES ? machines : (o.near ?? []), pick: setPicked, slots, slot: slotChoice(names, slotPicked ?? o.slot), setSlot, problem };
}

export type Target = ReturnType<typeof useTarget>;

export function Machines({ t, label = "Машина" }: { t: Target; label?: string }) {
  return (
    <Row label={label}>
      <Opts>
        <PickOne all={t.machines} near={t.near} cur={t.machine} on={t.pick} select={{ "data-f": "target", "aria-label": "Другая машина" }} />
      </Opts>
    </Row>
  );
}

export const Slot = ({ t }: { t: Target }) => (t.slots ? <SlotPick slots={t.slots} value={t.slot} on={t.setSlot} label={`Слот на ${t.machine}`} /> : null);

/** Проба папки на машине: null — ответа ещё нет. */
export function useProbe(machine: string, body: Record<string, unknown> | null): Check | null {
  const app = useApp();
  const key = JSON.stringify([machine, body]);
  const { data, error, loading } = useLoad<Probe>(() => (body ? app.read<Probe>("points.raise", { machine, ...body, dryRun: true }) : new Promise(() => {})), [key]);
  if (loading) return null;
  return error ? { key: "error", text: refused(error, { target: machine }), tone: "bad" } : data ? checkOf(data, machine) : null;
}

/** Новая сессия встаёт в проект исходной. */
export function joinProject(app: App, from: string, callsign: string) {
  const project = app.mark("project.of", from) as { id: string } | null | undefined;
  if (project) app.run("board.assign", { callsign, project: project.id });
}
