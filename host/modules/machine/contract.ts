// Контракт модуля Host machine v1: папки машины. Что стоит и работает на машине — keeper.state.
//   machine.dirs { machine, path } → { path, dirs }      только папки, по имени; путь — от ~ или полный
// Слова: bad_frame, not_found, no_access. Папку создаёт session.open по просьбе: решает машина при открытии.
import { refuse } from "@switchboard/host";
import type { Module } from "@switchboard/host";

export function make(_o: { home?: string } = {}): Module {
  return {
    requests: {
      "machine.dirs": () => {
        throw refuse("demolished", "снесено");
      },
    },
  };
}
export default make();
