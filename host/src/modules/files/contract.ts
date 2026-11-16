// Договор модуля файлов для соседей: обмен с хранилищем по ссылкам (его же зовёт архив точек), разбор строки уведомления о файлах сообщения
// и то, что модуль отдаёт через host.module("host-files").
export { split, type FilesApi } from "./files.ts";
export { sha256, storeFetch, storeGet, storePut } from "./store.ts";
