// Выбор машины подъёма: цель — сразу, её слоты и проверка папки — когда машина ответит.
import type { Dispatch, SetStateAction } from "react";
import { usePoints, type PointsStore } from "./store.ts";

type Probe = Awaited<ReturnType<PointsStore["probe"]>>;
type Raises = Parameters<PointsStore["probe"]>[1];

export function useTargetPick<D extends { target: string }>(set: Dispatch<SetStateAction<D | null>>) {
  const points = usePoints();
  return async (target: string, raises: Raises, apply: (d: D, p: Probe) => D) => {
    set((d) => d && { ...d, target });
    const p = await points.probe(target, raises);
    // выбрали другую машину, пока шёл ответ — он устарел
    set((d) => (d && d.target === target ? apply(d, p) : d));
  };
}
