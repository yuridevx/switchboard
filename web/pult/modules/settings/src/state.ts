// Состояние настроек: то, что переживает смену вкладки, — подвкладка, отмеченные машины, выданное приглашение и идущая выкладка, —
// и ответы keeper'ов для метки keeper.answers. Каталог, пропуска и GitHub читают сами вкладки (load.ts).
// Действия возвращают результат; слова на экран кладёт экран.
import type { App } from "@switchboard/web-core";
import { createStore, machineAnswers, type MachineAnswers, machinesWith, type OutcomeNote, plural, type Result, useModule } from "@switchboard/web-ui";
import { say, type Err, type KState, type Listed, type ReleaseData } from "./rules.ts";

export type Form = { action: string; manifest: Record<string, unknown> };
export type Kind = "device" | "program" | "machine";
export type Inviting = { kind: Kind; name: string; person: string };
export type Invited = { kind: Kind; invite: string; addr: string };
export type Pass = { id: string; role: "host" | "client"; name: string; person: string | null; addr: string; state: "wait" | "ok"; by: string; at: number };
export type Gh = { app: { slug: string } | null; repos?: string[]; install?: string; form?: Form };

export type State = {
  rtab: "machines" | "catalog";
  rsel: Record<string, true>;
  invited: Invited | null;
  busy: string;
  /** итог выкладки: она идёт десятки секунд и, как и busy, переживает смену вкладки */
  deployed: OutcomeNote | null;
};

/** Ответы keeper'ов для других модулей — только данные; держать свежими и перечитать — команды keeper.open, keeper.close, keeper.reload. */
export type KeeperAnswers = ReturnType<MachineAnswers<KState>["get"]>;

export type SettingsState = ReturnType<typeof createSettingsState>;
export const useSettings = (): SettingsState => useModule<SettingsState>();

export function createSettingsState(app: App) {
  const store = createStore<State>({ rtab: "machines", rsel: {}, invited: null, busy: "", deployed: null }, () => app.changed());
  /** Ответы keeper'ов: один владелец на все экраны; keeper машины отвечает сам, даже когда Host мёртв. */
  const keeper = machineAnswers<KState>(app, (m) => app.read<KState>("keeper.state", { to: `.keeper@${m}` }));
  const machines = () => machinesWith(app);
  const reload = (m: string) => keeper.reload(m);
  /** Открытые чужие экраны с ответами keeper: снятие каждого — команда keeper.close. */
  const foreign: Array<() => void> = [];

  return {
    get: store.get,
    /** GitHub вернул браузер с ?code= после создания приложения флота: сохранят «Настройки». */
    start() {
      if (app.wide && new URLSearchParams(location.search).has("code") && !location.hash) history.replaceState(null, "", `${location.pathname}${location.search}#settings?tab=general`);
    },
    /** Данные правил выпусков: выборка сравнивается по содержимому, ветви снимка — по ссылке. */
    releaseData: (list: Listed | Err | null): ReleaseData => ({ list, kst: keeper.get(), online: machines() }),
    machines,
    /** Машина вернулась, пришла или перезапустилась при открытом экране — её keeper. */
    onLink: keeper.onLink,
    keeperAnswers: (): KeeperAnswers => keeper.get(),
    openKeeper: () => void foreign.push(keeper.mount()),
    closeKeeper: () => foreign.pop()?.(),
    reloadKeeper: reload,
    /** Вкладка «Выпуски» открыта: ответы keeper'ов; возврат — закрыта. */
    mountKeeper: () => keeper.mount(),

    setReleasesTab: (rtab: State["rtab"]) => store.set((s) => void (s.rtab = rtab)),
    toggleSelected: (m: string) =>
      store.set((s) => {
        if (s.rsel[m]) delete s.rsel[m];
        else s.rsel[m] = true;
      }),
    clearSelected: () => store.set((s) => void (s.rsel = {})),

    /** Изменить план машины: закрепить версию, включить или выключить часть. */
    async setPlan(m: string, part: string, body: { pin: string | null } | { on: boolean }): Promise<Result<string>> {
      const r = await app.request<{ machine: string; rev: number }>("releases.set", { machine: m, part, ...body });
      if (!r.ok) return { ok: false, error: `@${m} ${part}: ${say(r.error)}` };
      await reload(m);
      return { ok: true, result: `@${m}: план rev ${r.result.rev}` };
    },
    /** Закрепить host у отмеченных; отказ хотя бы одной — словами. */
    async bulk(pin: string | null): Promise<Result<string>> {
      const ms = Object.keys(store.get().rsel);
      const refused = await Promise.all(ms.map((m) => app.request("releases.set", { machine: m, part: "host", pin }).then((r) => (r.ok ? null : `@${m} host: ${say(r.error)}`))));
      const ok = refused.filter((x) => !x).length;
      const changed = `${ok} ${plural(ok, "машина", "машины", "машин")}: план изменён`;
      store.set((s) => void (s.rsel = {}));
      await Promise.all(ms.map(reload));
      const last = refused.findLast(Boolean);
      return last ? { ok: false, error: `${changed}; ${last}` } : { ok: true, result: changed };
    },
    async deploy(part: string, version?: string) {
      store.set((s) => {
        s.busy = part;
        s.deployed = null;
      });
      const r = await app.request<{ parts: Record<string, { from: string | null; to: string }> }>("releases.deploy", version ? { part, version } : { part });
      store.set((s) => {
        s.busy = "";
        s.deployed = r.ok ? { text: `Выложено: ${Object.entries(r.result.parts).map(([p, x]) => `${p} ${x.from ?? "—"} → ${x.to}`).join(", ")}`, tone: "ok" } : { text: `Не выложен ${part}${version ? ` ${version}` : ""}: ${say(r.error)}`, tone: "bad" };
      });
      if (r.ok) await Promise.all(machines().map(reload));
    },

    closeInvited: () => store.set((s) => void (s.invited = null)),
    /** Пригласить: выданное показывается один раз и переживает смену вкладки. */
    async invite({ kind, name, person }: Inviting): Promise<Result<null>> {
      const role = kind === "machine" ? "host" : "client";
      const r = await app.request<{ kid: string; invite: string; addr: string }>("keys.invite", { role, name: name.trim(), ...(role === "client" ? { person: person.trim() } : {}) });
      if (!r.ok) return { ok: false, error: say(r.error) };
      store.set((s) => void (s.invited = { kind, invite: r.result.invite, addr: r.result.addr }));
      return { ok: true, result: null };
    },
    async revoke(p: Pass): Promise<Result<string>> {
      const r = await app.request<{ addr: string }>("keys.revoke", { kid: p.id });
      return r.ok ? { ok: true, result: `${p.addr} отозван — соединения закрыты` } : { ok: false, error: `${p.addr}: ${say(r.error)}` };
    },

    /** Сохранить приложение GitHub по коду из адреса. */
    async setup(code: string): Promise<Result<null>> {
      const r = await app.request<{ app: { slug: string }; install: string }>("github.setup", { code });
      if (!r.ok) return { ok: false, error: say(r.error) };
      history.replaceState(null, "", location.pathname + location.hash);
      return { ok: true, result: null };
    },
    /** Форма создания приложения у организации. */
    async create(org: string): Promise<Result<Form | undefined>> {
      const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname, org });
      return r.ok ? { ok: true, result: r.result.form } : { ok: false, error: say(r.error) };
    },
  };
}
