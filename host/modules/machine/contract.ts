// Контракт модуля Host machine v1: папки машины. Что стоит и работает на машине — keeper.state.
//   machine.dirs { machine, path } → { path, dirs }      только папки, по имени; путь — от ~ или полный
//   machine.mkdir { machine, path } → { path }          одна папка в существующей
// Слова: bad_frame, not_found, no_access, exists.
import { machine } from "./src/machine.ts";

export default machine();
