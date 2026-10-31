// Контракт модуля Host machine v1: папки и состояние машины.
//   machine.dirs { machine, path } → { path, dirs }      только папки, по имени; путь — от ~ или полный
//   machine.mkdir { machine, path } → { path }          одна папка в существующей
//   machine.state { machine } → { host, sdk, node, os, started, processes }   processes — ответ keeper list как есть
// Слова: bad_frame, not_found, no_access, exists.
import { machine } from "./src/machine.ts";

export default machine();
