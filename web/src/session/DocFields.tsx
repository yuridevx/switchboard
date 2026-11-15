// Документ сессии: что выбрать в каждом поле и сами поля — для ряда под полем ввода и для инспектора.
import { CLAUDE, profileList, type SessionRow } from "@sb/protocol";
import { MultiSelect, Select, Stack } from "@mantine/core";
import { EFFORTS, MODES, useCall } from "../common.tsx";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { patchDoc, useLater } from "./doc.ts";
import { ModelPicker, useModelWord, type Offer } from "./ModelPicker.tsx";

export function useDoc(s: SessionRow) {
  const machine = machineOfCall(s.callsign);
  const offline = useFleet((f) => f.machines[machine]?.online === false);
  const pieces = useCall(profileList, offline ? null : { to: "@" + machine });
  const list = pieces.data?.pieces ?? [];
  const title = (id: string) => list.find((p) => p.id === id)?.title ?? id;
  return { pieces: list, title, efforts: EFFORTS, later: useLater(s) };
}

/** Провайдер и модель меняются вместе, одним запросом: сессия не остаётся с моделью одного провайдера на ключе другого. */
export const pickModel = (s: SessionRow, o: Offer) => patchDoc(s, { key: o.key, model: o.doc });

/** Что стоит на кнопке модели: выбранная модель, провайдер — если не Claude, и модель, которая ответила вместо выбранной (её называет машина в строке сессии). */
export function ModelFace({ s }: { s: Pick<SessionRow, "answers"> & { spec: { key?: string; model?: string } } }) {
  const offerWord = useModelWord();
  const onKey = s.spec.key && s.spec.key !== CLAUDE ? s.spec.key : undefined;
  return <>{offerWord(s.spec.model)}{onKey && <span className="mp-on"> · {onKey}</span>}{s.answers && <span className="mp-drift"> ≠ {offerWord(s.answers)}</span>}</>;
}

/** Документ сессии полями: на телефоне — в листе инспектора. */
export function DocFields({ s }: { s: SessionRow }) {
  const d = useDoc(s);
  return (
    <Stack gap="xs">
      <ModelPicker field value={s.spec} onPick={(o) => pickModel(s, o)} face={<ModelFace s={s} />} />
      <Select label="Усилие" data={d.efforts.map(([value, label]) => ({ value, label }))} value={s.spec.effort ?? null} placeholder="как у модели" onChange={(effort) => effort && patchDoc(s, { effort: effort as never })} allowDeselect={false} />
      <Select label="Режим" data={MODES.map(([value, label]) => ({ value, label }))} value={s.spec.mode ?? "all"} onChange={(mode) => mode && patchDoc(s, { mode: mode as never })} allowDeselect={false} />
      <MultiSelect label="Кусочки" data={d.pieces.map((p) => ({ value: p.id, label: p.title ?? p.id, disabled: !p.ok }))} value={s.spec.pieces ?? []} onChange={(pieces) => patchDoc(s, { pieces })} />
    </Stack>
  );
}
