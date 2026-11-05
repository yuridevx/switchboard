// Гейт манифестов: набор модулей годен или назван отказ. Один пакет для монорепо, сборки в «Выпусках», старта Host и старта страницы.
export type Manifest = {
  name: string;
  type: string;
  version: string;
  provides: Record<string, number>;
  /** Ключ — ссылка `имя@владелец`, значение — версия имени. */
  uses: Record<string, number>;
  config: Record<string, "secret" | "var" | "binding">;
  /** Корни сборки, в которые модуль входит. */
  into?: string[];
  pkg?: string;
  // Факты кода; их кладёт loadRepo, манифест из каталога или сборки их не несёт.
  /** Пакеты @switchboard, которые импортирует код. */
  imports?: string[];
  /** Чужие файлы, куда код идёт относительным путём: `модуль/путь`. */
  reach?: string[];
  /** Чужие файлы, куда тест или стенд идёт мимо контракта: `модуль/путь`. */
  testReach?: string[];
  /** Вызовы привязок Worker: `env.GATE.verify()` — `gate.verify`. */
  rpc?: string[];
};

const gone = (): never => {
  throw new Error("снесено");
};
export const nameOf = (_ref: string): string => gone();
export const ownerOf = (_ref: string): string => gone();
export const order = <T extends Manifest>(_mods: T[]): T[] => gone();
export const check = (_mods: Manifest[]): string[] => gone();
export const loadRepo = (_root: string): (Manifest & { dir: string })[] => gone();
