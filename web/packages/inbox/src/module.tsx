// Снесено: вход отказывает словом.
import type { AppPart } from "@switchboard/web-core";

export const createInbox = ((): never => {
  throw new Error("снесено");
}) satisfies AppPart["module"];
