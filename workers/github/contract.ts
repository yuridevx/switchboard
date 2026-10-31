// Контракт github: приложение GitHub флота и токены установки для git.
// Запросы — кадры с to: "github", ответ — reply через relay.

export const CONTRACT = { "github.app": 1, "github.setup": 1, "github.token": 1 } as const;

export type AppInfo = { id: number; slug: string; owner: string };

/**
 * github.app — что есть и как создать. redirect — адрес пульта: туда GitHub вернёт браузер с code.
 * org есть — приложение организации, нет — личного аккаунта того, кто подтвердит форму.
 */
export type GithubApp = { type: "github.app"; id: string; v?: 1; to: "github"; redirect: string; org?: string };
/** Приложение есть: репозитории всех установок и ссылка установки. Нет — форма manifest для браузера пульта. */
export type GithubAppResult =
  | { app: AppInfo; repos: string[]; install: string }
  | { app: null; form: { action: string; manifest: Record<string, unknown> } };

/** github.setup — одноразовый code из возврата GitHub меняется на приложение. replace: true заменяет прежнее. */
export type GithubSetup = { type: "github.setup"; id: string; v?: 1; to: "github"; code: string; replace?: boolean };
export type GithubSetupResult = { app: AppInfo; install: string };

/** github.token — токен установки на час: только к repo (владелец/имя) и только на содержимое. */
export type GithubToken = { type: "github.token"; id: string; v?: 1; to: "github"; repo: string };
export type GithubTokenResult = { token: string; expires_at: string };

/**
 * Слова отказа github. not_installed несёт install — ссылку установки;
 * app_exists — app { id, slug }.
 */
export type GithubWord = "no_app" | "not_installed" | "app_exists" | "github_failed";
