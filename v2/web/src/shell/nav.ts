// Разделы страницы: адрес, слово, значок — для панели, нижней панели, страниц «Найти» и «Ещё».
import { IconActivityHeartbeat, IconArchive, IconChartBar, IconLayoutList, IconServer2, IconSettings } from "@tabler/icons-react";

export const NAV = [
  ["/work", "Работа", IconLayoutList], ["/archive", "Архив", IconArchive], ["/spend", "Расход", IconChartBar],
  ["/fleet", "Флот", IconServer2], ["/observe", "Наблюдение", IconActivityHeartbeat], ["/settings", "Настройки", IconSettings],
] as const;

/** Цвет лампы связи с флотом. */
export const LAMP: Record<string, string> = { open: "idle", connecting: "waiting", closed: "failed", stopped: "failed" };
