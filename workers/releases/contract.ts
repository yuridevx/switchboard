// Контракт releases («выпуски»): каталог частей с edge и stable, планы машин и их rev, выкладка.
// Запросы — кадры с to: ".releases", ответ — reply через relay. План машины уходит её keeper кадром releases.plan.
//
// Часть машины — архивы в R2: <часть>/<версия>.tgz и <часть>/<версия>.sha256 (hex первым словом).
// Часть Cloudflare — версии Worker'а с меткой-номером. edge — новейшая версия, не хранится; stable — выложенная.

export const CONTRACT = { "releases.plan": 1, "releases.list": 1, "releases.upload": 1, "releases.deploy": 1, "releases.set": 1 } as const;

/** Запись плана машины: только отличия от «за stable, включено». */
export type PlanEntry = { pin?: string; on?: boolean; force?: boolean; env?: Record<string, string> };

/** Часть в плане, который исполняет keeper: stable уже раскрыт в версии, ссылка на архив живёт час. */
export type PlanPart = { part: string; version: string; sha256: string; url: string; on?: boolean; force?: boolean; env?: Record<string, string> };

/** Тело плана — одно в ответе на releases.plan и в кадре releases.plan на .keeper@машина. */
export type Plan = { rev: number; parts: PlanPart[] };

/** releases.plan — вопрос keeper при подключении: машина — из адреса .keeper@машина. Ответ — Plan. */
export type ReleasesPlan = { type: "releases.plan"; id: string; v?: 1; to: ".releases" };

/** releases.list — каталог и планы. part — только эта часть. */
export type ReleasesList = { type: "releases.list"; id: string; v?: 1; to: ".releases"; part?: string };
export type Listed = {
  parts: Record<string, { where: "machine" | "cloud"; edge: string | null; stable: string | null }>;
  machines: Array<{ machine: string; plan: Record<string, PlanEntry> }>;
  rev: number;
};

/** releases.upload — две ссылки на запись версии части машины: архив и хэш. Версия загружается один раз. */
export type ReleasesUpload = { type: "releases.upload"; id: string; v?: 1; to: ".releases"; part: string; version: string };
export type Upload = { tgz: string; sha256: string };

/**
 * releases.deploy — stable на версию (без version — edge). part "*" — части Cloudflare и части машины на edge.
 * Модуль сборки (into) — новая сборка каждого его приложения: текущий список + модуль, проверка набора флота
 * (check_failed с причинами); корень сборки с версией каталога — сборка с этим ядром, со сборкой «+n» — откат на неё.
 */
export type ReleasesDeploy = { type: "releases.deploy"; id: string; v?: 1; to: ".releases"; part: string; version?: string };
export type Deployed = { parts: Record<string, { from: string | null; to: string }> };

/** releases.set — единственная правка плана машины. pin: null — снять. У keeper — только pin. */
export type ReleasesSet = {
  type: "releases.set";
  id: string;
  v?: 1;
  to: ".releases";
  machine: string;
  part: string;
  pin?: string | null;
  on?: boolean;
  force?: boolean;
  env?: Record<string, string>;
  remove?: boolean;
};
export type SetResult = { machine: string; rev: number };

/** Слова отказа. */
export type Word = "bad_frame" | "unknown_request" | "contract_mismatch" | "no_release" | "no_part" | "version_exists" | "bad_version" | "cf_failed" | "check_failed" | "no_build";
