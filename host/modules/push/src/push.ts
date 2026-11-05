// Снесено: заглушка на время сноса.
import { refuse, type Module } from "@switchboard/host";
export const make = (): Module => ({ requests: { notify() { throw refuse("removed", "снесено"); } } });
