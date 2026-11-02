// Список сборки — build.json в корне сборки любого приложения (Host, пульт, телефон): одно описание и одна запись.
// Пишут «Выпуски» при сборке; читают ядро Host и ядро страницы на старте.
import type { TarFile } from "./tar.ts";

/** Список сборки: модули без корня в порядке зависимостей и адреса Worker'ов флота, которыми пользуется сборка. */
export type BuildList = {
  app: string;
  version: string;
  fleet: string;
  modules: Array<{ name: string; version: string }>;
  /** имя Worker-модуля → адрес https; relay — объекты машин (wss того же адреса, /m/<машина>), gate — список машин */
  workers: Record<string, string>;
};

export const BUILD_FILE = "build.json";

/** Запись build.json сборки. */
export function buildFile(list: BuildList): TarFile {
  return { path: BUILD_FILE, data: Buffer.from(JSON.stringify(list, null, 2) + "\n") };
}
