// Снесено: вход отказывает словом.
import type { AppPart } from "@switchboard/web-core";

export const createCard = ((): never => {
  throw new Error("снесено");
}) satisfies AppPart["module"];
