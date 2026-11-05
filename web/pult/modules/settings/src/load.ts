// Ответы владельцев для открытой вкладки: читают при открытии, живут, пока вкладка открыта.
import { useApp, useLoad } from "@switchboard/web-ui";
import type { Listed } from "./rules.ts";
import { useSettings, type Gh, type Pass } from "./state.ts";

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

/** Пропуска флота: отзыв удаляет строку у gate. */
export function usePasses() {
  const app = useApp();
  return useLoad<Pass[]>(async () => {
    const r = await app.read<{ passes: Pass[] }>("keys.list");
    return r.ok ? { ok: true, result: r.result.passes } : r;
  }, []);
}

/** Машины флота: их знает gate, на связи или нет. */
export function useHosts() {
  const app = useApp();
  return useLoad<string[]>(async () => {
    const r = await app.read<{ passes: Array<{ name: string }> }>("keys.list", { role: "host" });
    return r.ok ? { ok: true, result: r.result.passes.map((p) => p.name) } : r;
  }, []);
}

/** Приложение GitHub флота. */
export function useGithub() {
  const app = useApp();
  return useLoad<Gh>(() => app.read<Gh>("github.app", { redirect: location.origin + location.pathname }), []);
}

/** Пропуск этого устройства: страница работает по действующему. */
export const thisDevice = (passes: readonly Pass[], name: string) => passes.find((p) => p.role === "client" && p.name === name && p.state === "ok");
