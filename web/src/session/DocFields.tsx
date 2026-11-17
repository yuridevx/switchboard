// Документ сессии: что выбрать в каждом значении ряда под полем ввода.
import { CLAUDE, profileList, type SessionRow } from "@sb/protocol";
import { EFFORTS, useCall } from "../common.tsx";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { patchDoc, useLater } from "./doc.ts";
import { useModelWord, type Offer } from "./ModelPicker.tsx";

export function useDoc(s: SessionRow) {
  const machine = machineOfCall(s.callsign);
  const offline = useFleet((f) => f.machines[machine]?.online === false);
  const pieces = useCall(profileList, offline ? null : { to: "@" + machine });
  const list = pieces.data?.pieces ?? [];
  const title = (id: string) => list.find((p) => p.id === id)?.title ?? id;
  return { pieces: list, title, efforts: EFFORTS, later: useLater(s) };
}

/** Провайдер и модель меняются вместе, одним запросом: сессия не остаётся с моделью одного провайдера на ключе другого. */
export const pickModel = (s: SessionRow, o: Offer) => patchDoc(s, { key: o.key, model: o.model });

/** Что стоит на кнопке модели: выбранная модель, провайдер — если не Claude, и модель, которая ответила вместо выбранной (её называет машина в строке сессии). */
export function ModelFace({ s }: { s: Pick<SessionRow, "answers"> & { spec: { key?: string; model?: string } } }) {
  const offerWord = useModelWord();
  const onKey = s.spec.key && s.spec.key !== CLAUDE ? s.spec.key : undefined;
  return <><span className="mp-word">{offerWord(s.spec.model)}</span>{onKey && <span className="mp-on"> · {onKey}</span>}{s.answers && <span className="mp-drift"> ≠ {offerWord(s.answers)}</span>}</>;
}
