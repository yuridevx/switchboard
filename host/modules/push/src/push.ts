// снесено
import { refuse, type Module } from "@switchboard/host";

export const make = (): Module => ({ requests: { notify: () => refuse("снесено") } });
