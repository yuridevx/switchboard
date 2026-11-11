// Документ сессии: что выбрать в каждом поле и сами поля — для ряда под полем ввода и для инспектора.
import { accountList, profileList, type SessionRow } from "@sb/protocol";
import { MultiSelect, Select, Stack } from "@mantine/core";
import { EFFORTS, MODES, useCall } from "../common.tsx";
import { seatOptions } from "../lib/accounts.ts";
import { laneOf } from "@sb/protocol";
import { SlotLine } from "../lib/AccountView.tsx";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { effectiveModel, modelsFor, patchDoc, useLater, useModels } from "./doc.ts";

const isLive = (s: SessionRow) => s.state !== "stopped" && s.state !== "failed";

export function useDoc(s: SessionRow, running?: string) {
  const machine = machineOfCall(s.callsign);
  const offline = useFleet((f) => f.machines[machine]?.online === false);
  const accounts = useCall(accountList, offline ? null : { to: "@" + machine });
  const pieces = useCall(profileList, offline ? null : { to: "@" + machine });
  // у сессии на ключе флота модель — та, что записана у ключа
  // аккаунт, на котором сессия идёт сейчас: вход очереди или ключ флота
  const mine = accounts.data?.accounts.find((a) => a.id === (s.account ?? s.spec.slot));
  const sdkModels = useModels(s, !offline && isLive(s));
  const models = modelsFor(mine, sdkModels);
  const model = effectiveModel(s.spec, models, running);
  const accountOptions = seatOptions(accounts.data, s.spec.model).map((o) => [o.value, o.label] as const);
  const list = pieces.data?.pieces ?? [];
  const title = (id: string) => list.find((p) => p.id === id)?.title ?? id;
  const efforts = model.efforts ? EFFORTS.filter(([e]) => model.efforts!.includes(e)) : EFFORTS;
  /** Очередь той же строкой, что на странице аккаунтов: аккаунт — тот, на котором стоит место модели сессии; ключ флота — словом. */
  const lane = laneOf(s.spec.model);
  const slotLine = (name: string) => { const q = accounts.data?.slots.find((x) => x.name === name); return q ? <SlotLine slot={q} lane={lane} account={accounts.data?.accounts.find((x) => x.id === q.lanes[lane].account)} /> : undefined; };
  const toSlot = (slot: string) => ({ slot });
  return { accountOptions, slotLine, toSlot, pieces: list, title, models, model, efforts, later: useLater(s) };
}

/** Документ сессии полями: на телефоне — в листе инспектора, при паре — в окошке шапки. */
export function DocFields({ s }: { s: SessionRow }) {
  const d = useDoc(s);
  return (
    <Stack gap="xs">
      <Select label="Модель" data={d.models.map((m) => ({ value: m.value, label: m.label }))} value={d.model.value || null} onChange={(model) => model && patchDoc(s, { model })} allowDeselect={false} />
      <Select label="Усилие" data={d.efforts.map(([value, label]) => ({ value, label }))} value={s.spec.effort ?? null} placeholder="как у модели" onChange={(effort) => effort && patchDoc(s, { effort: effort as never })} allowDeselect={false} />
      <Select label="Режим" data={MODES.map(([value, label]) => ({ value, label }))} value={s.spec.mode ?? "all"} onChange={(mode) => mode && patchDoc(s, { mode: mode as never })} allowDeselect={false} />
      <Select label="Очередь аккаунтов" data={d.accountOptions.map(([value, label]) => ({ value, label }))} value={s.spec.slot ?? null} onChange={(slot) => slot && patchDoc(s, d.toSlot(slot))} allowDeselect={false} />
      <MultiSelect label="Кусочки" data={d.pieces.map((p) => ({ value: p.id, label: p.title ?? p.id, disabled: !p.ok }))} value={s.spec.pieces ?? []} onChange={(pieces) => patchDoc(s, { pieces })} />
    </Stack>
  );
}
