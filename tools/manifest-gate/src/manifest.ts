// Манифест модуля и ссылка «имя@владелец». Одно правило для гейта, ядра Host и ядра веба.
export type ConfigKind = "secret" | "var" | "binding";

export type Manifest = {
  name: string;
  type: string;
  version: string;
  /** имя контракта → версия */
  provides: Record<string, number>;
  /** "имя@владелец" → версия */
  uses: Record<string, number>;
  config: Record<string, ConfigKind>;
  /** приложения, в которые модуль входит: корни сборок — ядро Host или оболочка страницы */
  into?: string[];
  /** пакеты @switchboard/*, которые импортирует код модуля (без тестов) — заполняет loadRepo */
  imports?: string[];
  /** имя npm-пакета модуля — заполняет loadRepo */
  pkg?: string;
  /** имена контракта, которые код зовёт через привязку Worker'а: env.GATE.revoked → gate.revoked — заполняет loadRepo */
  calls?: string[];
  /** импорты, ушедшие в папку чужого модуля — заполняет loadRepo */
  reach?: Reach[];
};

/** Импорт в чужой модуль: куда, какой файл от его корня, из теста или стенда ли. */
export type Reach = { to: string; path: string; test: boolean };

export const nameOf = (ref: string) => ref.slice(0, ref.lastIndexOf("@"));
export const ownerOf = (ref: string) => ref.slice(ref.lastIndexOf("@") + 1);
