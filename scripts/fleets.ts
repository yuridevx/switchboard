// Флоты разработки: адрес страницы приложения и файл пропуска агента. Секрет — только в файле, никогда не в argv.
import { homedir } from "node:os";
import { join } from "node:path";

export type Fleet = "test" | "prod";

/** Флоты и их подписи на вкладке страницы. */
export const FLEETS: Record<Fleet, string> = { test: "тест", prod: "прод" };

/** Адрес страницы приложения на флоте. */
export const pageOf = (fleet: Fleet, app: string): string => (fleet === "prod" ? `https://${app}.pfarm.app/` : `https://switchboard-${app}.yuridevx1608.workers.dev/`);

/** Файл пропуска агента флота: $SWITCHBOARD_DEV_DIR или ~/.switchboard-dev. */
export const passFile = (fleet: Fleet): string => join(process.env.SWITCHBOARD_DEV_DIR ?? join(homedir(), ".switchboard-dev"), `${fleet}-agent.pass`);
