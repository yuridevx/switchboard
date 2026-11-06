// Ответы запросов Host, которые читают несколько модулей страниц: одно описание на ответ. Только типы:
// контракты модулей Host страница не импортирует.

/** Окно лимита аккаунта: как прислал accounts машины. */
export type AccountWindow = { utilization: number; resetsAt?: number; at?: number };
/** Запись аккаунта на машине; имя записи — почта. expires — конец входа, секунды. */
export type AccountInfo = { login: "ok" | "none"; plan?: string; expires?: number; limits?: Record<string, AccountWindow> };
export type SlotInfo = { account: string | null; order: string[]; wait: number | null };
/** Ответ machine.accounts: аккаунты и слоты машины. */
export type AccountsAnswer = { accounts: Record<string, AccountInfo>; slots: Record<string, SlotInfo> };

export type ProfileInfo = { about?: string; use?: string[]; kind?: "set" | "style" | "piece"; names?: ProfileName[] };
/** Имя внутри кусочка для поиска: только имена, содержимого файлов здесь нет. */
export type ProfileName = { kind: "skill" | "agent" | "rule" | "memory"; name: string; path: string };
/** Файл кусочка в просмотре: без текста; его читает profile.file по нажатию. */
export type PieceFile = { path: string; size: number; meta?: Record<string, string>; head?: string };
/** Узел развёртки профиля: набор → его состав. */
export type ProfileTreeNode = { id: string; set: boolean; children?: ProfileTreeNode[] };
/** Память кусочка в итоге. */
export type ProfileMemory = { from: string; files: number; bytes: number; indexLines: number; indexBytes: number; types: Record<string, number> };
/** Ответ profile.view: что получит сессия с этим списком — тем же кодом, что собирает запуск. Настройки env — ключами env.ИМЯ. */
export type ProfileView = {
  pieces: string[];
  tree: ProfileTreeNode[];
  settings: Record<string, { value: unknown; from: string; lost: Array<{ value: unknown; from: string }> }>;
  /** rule — файл правила: действует по paths или всегда */
  instructions: Array<{ from: string; path: string; head: string; rule: boolean; paths?: string }>;
  /** extra — сопутствующие файлы папки скила */
  skills: Array<{ from: string; name: string; description: string; path: string; extra: string[] }>;
  agents: Array<{ from: string; name: string; description: string; path: string; model?: string; effort?: string; main: boolean }>;
  /** домашняя одна, остальные — индексом в промпте */
  memory: { home?: ProfileMemory; near: ProfileMemory[] };
  /** path нет — файла в кусочках не нашлось; текст добавки флота — запрос fleet.prompt */
  prompt: { agent?: { name: string; from: string; path?: string }; style?: { name: string; from: string; found: boolean; path?: string } };
  /** config — запись сервера или хука как она написана в кусочке */
  mcp: Array<{ from: string; kind: "server" | "hook"; name: string; detail: string; config: unknown }>;
  /** файлы кусочков, которых Claude не подключит ни одним путём */
  other: Array<{ from: string; path: string }>;
  files: Record<string, PieceFile[]>;
};
/** Ключ флота: слот на любой машине; значения ключа в ответе нет. */
export type FleetKey = { env: Record<string, string>; settings: Record<string, unknown> };
export type FleetKeysAnswer = { keys: Record<string, FleetKey> };
/** wait — машина ещё не сводила этот репозиторий; at — время последнего сведения, мс */
export type ProfileRepo = { state: "ok" | "wait" | "error" | "conflict"; op?: string; files?: string[]; error?: string; dir?: string; at?: number };
/** Ответ machine.profiles. */
export type ProfilesAnswer = { profiles: Record<string, ProfileInfo>; repos: Record<string, ProfileRepo> };

export type JournalRecord = { t: string; part?: string; who?: string; kind?: string; ev?: string; word?: string; why?: string; id?: string };
/** Ответ machine.journal. */
export type JournalAnswer = { records: JournalRecord[]; more: boolean };

/** Модель из ответа supportedModels. */
export type ModelInfo = { value: string; displayName?: string; supportsAutoMode?: boolean };
