// Снесено: вход отказывает словом.
import type { AppPart } from "@switchboard/web-core";

export const createSettings = ((): never => {
  throw new Error("снесено");
}) satisfies AppPart["module"];
