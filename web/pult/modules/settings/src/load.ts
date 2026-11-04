// Ответы владельцев для открытой вкладки: читают при открытии, живут, пока вкладка открыта.
import { useApp, useLoad } from "@switchboard/web-ui";
import type { Listed } from "./rules.ts";
import { type Gh, type Pass, useSettings } from "./store.ts";

/** Каталог «Выпусков»; выкладка прошла — перечитать, даже если её начали на другой вкладке. */
export function useCatalog() {
  const app = useApp();
  const settings = useSettings();
  const deployed = app.use(() => {
    const d = settings.get().deployed;
    return d?.tone === "ok" ? d.text : "";
  });
  return useLoad<Listed>(() => app.read<Listed>("releases.list"), [], deployed);
}

/** Пропуска флота; отозванные не показываем (слово пользователя 3 нояб.). */
export function usePasses() {
  const app = useApp();
  return useLoad<Pass[]>(async () => {
    const r = await app.read<{ passes: Array<Omit<Pass, "state"> & { state: Pass["state"] | "revoked" }> }>("keys.list");
    return r.ok ? { ok: true, result: r.result.passes.filter((p): p is Pass => p.state !== "revoked") } : r;
  }, []);
}

/** Приложение GitHub флота. */
export function useGithub() {
  const app = useApp();
  return useLoad<Gh>(() => app.read<Gh>("github.app", { redirect: location.origin + location.pathname }), []);
}

/** Пропуск этого устройства: страница работает по действующему. */
export const thisDevice = (passes: readonly Pass[], name: string) => passes.find((p) => p.role === "client" && p.name === name && p.state === "ok");
