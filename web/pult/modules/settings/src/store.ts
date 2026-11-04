// Состояние настроек: ответы владельцев («Выпуски», keeper'ы, gate, github) и вид экрана, который переживает закрытие экрана
// (подвкладка, отмеченные машины, выданное приглашение). Каждая цифра — ответ владельца; своего модуль не считает.
import type { App, Roster } from "@switchboard/web-core";
import { createStore, machineAnswers, type MachineAnswers, type OutcomeNote, plural, useModule, machinesWith, okOf } from "@switchboard/web-ui";
import { planOf, say, type Err, type KState, type Listed, type ReleaseData } from "./rules.ts";

export type Pass = { id: string; role: "host" | "client"; name: string; person: string | null; addr: string; state: "wait" | "ok"; by: string; at: number };
export type Form = { action: string; manifest: Record<string, unknown> };
export type Gh = { app: { slug: string } | null; repos?: string[]; install?: string; form?: Form };
export type Kind = "device" | "program" | "machine";
export type Inviting = { kind: Kind; name: string; person: string };
export type Invited = { kind: Kind; invite: string; addr: string };

export type State = {
  list: Listed | Err | null;
  passes: Pass[] | Err | null;
  gh: Gh | Err | null;
  rtab: "machines" | "catalog";
  rsel: Record<string, true>;
  invited: Invited | null;
  confirm: string | null;
  busy: string;
  /** итог выкладки: она идёт десятки секунд и, как и busy, переживает смену вкладки */
  deployed: OutcomeNote | null;
};

/** Ответы keeper'ов для других модулей: читать и держать открытыми; перечитать — команда keeper.reload. */
export type KeeperAnswers = Pick<MachineAnswers<KState>, "get" | "mount">;

export type SettingsStore = ReturnType<typeof createSettingsStore>;
/** Стор модуля в экранах. */
export const useSettings = (): SettingsStore => useModule<SettingsStore>();

export function createSettingsStore(app: App) {
  const store = createStore<State>(
    { list: null, passes: null, gh: null, rtab: "machines", rsel: {}, invited: null, confirm: null, busy: "", deployed: null },
    () => app.changed(),
  );
  /** Ответы keeper'ов: один владелец на все экраны, «Машины» берут их меткой keeper.answers; keeper машины отвечает сам, даже когда Host мёртв. */
  const keeper: MachineAnswers<KState> = machineAnswers<KState>(app, (m) => app.request<KState>("keeper.state", { to: `.keeper@${m}` }));
  const machines = () => machinesWith(app);
  /** Данные правил выпусков: выборка сравнивается по содержимому, ветви снимка — по ссылке. */
  const releaseData = (): ReleaseData => ({ list: store.get().list, kst: keeper.get(), online: machines() });

  // ───────── данные ─────────
  async function loadList() {
    if (!app.worker("releases")) return;
    const r = await app.request<Listed>("releases.list");
    store.set((s) => void (s.list = r.ok ? r.result : { error: r.error }));
  }
  const loadKeeper = (m: string) => keeper.reload(m);
  async function loadReleases() {
    await Promise.all([loadList(), ...machines().map(loadKeeper)]);
  }
  async function loadPasses() {
    const r = await app.request<{ passes: Array<Omit<Pass, "state"> & { state: Pass["state"] | "revoked" }> }>("keys.list");
    // отозванные не показываем (слово пользователя 3 нояб.)
    store.set((s) => void (s.passes = r.ok ? r.result.passes.filter((p): p is Pass => p.state !== "revoked") : { error: r.error }));
  }
  async function loadGithub() {
    if (!app.worker("github")) return;
    const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname });
    store.set((s) => void (s.gh = r.ok ? r.result : { error: r.error }));
  }

  // ───────── выпуски ─────────
  /** Изменить план; возврат — слова отказа или null. */
  async function setPlan(m: string, part: string, body: Record<string, unknown>, quiet = false): Promise<string | null> {
    const r = await app.request<{ machine: string; rev: number }>("releases.set", { machine: m, part, ...body });
    if (!r.ok) return `@${m} ${part}: ${say(r.error)}`;
    if (!quiet) app.toast(`@${m}: план rev ${r.result.rev}`, "ok");
    return null;
  }

  return {
    get: store.get,
    releaseData,
    machines,
    /** Машина пришла или вернулась при открытом экране — её keeper. */
    onRoster: (r: Roster) => keeper.onRoster(r),
    /** Метка keeper.answers. */
    keeperAnswers: { get: keeper.get, mount: keeper.mount } satisfies KeeperAnswers,
    /** Команда keeper.reload. */
    reloadKeeper: loadKeeper,

    // ───────── экран ─────────
    /** Вкладка открыта: ответы её владельцев. Возврат — вкладка закрыта. */
    openTab(tab: "releases" | "passes" | "general"): () => void {
      if (tab === "releases") {
        void loadList();
        return keeper.mount();
      }
      void loadPasses();
      if (tab === "general" && app.wide) void loadGithub();
      return () => {};
    },
    setReleasesTab: (rtab: State["rtab"]) => store.set((s) => void (s.rtab = rtab)),
    toggleSelected: (m: string) =>
      store.set((s) => {
        if (s.rsel[m]) delete s.rsel[m];
        else s.rsel[m] = true;
      }),
    clearSelected: () => store.set((s) => void (s.rsel = {})),

    // ───────── выпуски ─────────
    /** Закрепить версию; возврат — слова отказа или null. */
    async pin(m: string, part: string, v: string | null) {
      const refused = await setPlan(m, part, { pin: v });
      if (!refused) await Promise.all([loadList(), loadKeeper(m)]);
      return refused;
    },
    /** Включить или выключить часть; возврат — слова отказа или null. */
    async togglePart(m: string, part: string) {
      const on = planOf(releaseData(), m)[part]?.on !== false;
      const refused = await setPlan(m, part, { on: !on });
      if (!refused) await Promise.all([loadList(), loadKeeper(m)]);
      return refused;
    },
    /** Закрепить host у отмеченных; возврат — слова последнего отказа или null. */
    async bulk(v: string | null) {
      const ms = Object.keys(store.get().rsel);
      const done = await Promise.all(ms.map((m) => setPlan(m, "host", { pin: v }, true)));
      const ok = done.filter((x) => !x).length;
      app.toast(`${ok} ${plural(ok, "машина", "машины", "машин")}: план изменён`, ok === ms.length ? "ok" : "bad");
      store.set((s) => void (s.rsel = {}));
      await Promise.all([loadList(), ...ms.map(loadKeeper)]);
      return done.findLast(Boolean) ?? null;
    },
    async deploy(part: string, version?: string) {
      store.set((s) => {
        s.busy = part;
        s.deployed = null;
      });
      const r = await app.request<{ parts: Record<string, { from: string | null; to: string }> }>("releases.deploy", version ? { part, version } : { part });
      store.set((s) => void (s.busy = ""));
      if (!r.ok) return store.set((s) => void (s.deployed = { text: `Не выложен ${part}${version ? ` ${version}` : ""}: ${say(r.error)}`, tone: "bad" }));
      const moved = Object.entries(r.result.parts).map(([p, x]) => `${p} ${x.from ?? "—"} → ${x.to}`);
      store.set((s) => void (s.deployed = { text: `Выложено: ${moved.join(", ")}`, tone: "ok" }));
      await loadReleases();
    },

    // ───────── пропуска ─────────
    closeInvited: () => store.set((s) => void (s.invited = null)),
    /** Пригласить; возврат — слова отказа или null: выдано, форма закрывается. */
    async invite({ kind, name, person }: Inviting): Promise<string | null> {
      const role = kind === "machine" ? "host" : "client";
      const r = await app.request<{ kid: string; invite: string; addr: string }>("keys.invite", { role, name: name.trim(), ...(role === "client" ? { person: person.trim() } : {}) });
      if (!r.ok) return say(r.error);
      store.set((s) => void (s.invited = { kind, invite: r.result.invite, addr: r.result.addr }));
      await loadPasses();
      return null;
    },
    askRevoke: (id: string | null) => store.set((s) => void (s.confirm = id)),
    /** Отозвать пропуск; возврат — слова отказа или null. */
    async revoke(p: Pass): Promise<string | null> {
      const r = await app.request<{ addr: string }>("keys.revoke", { kid: p.id });
      store.set((s) => void (s.confirm = null));
      if (!r.ok) return `${p.addr}: ${say(r.error)}`;
      app.toast(`${p.addr} отозван — соединения закрыты`, "ok");
      await loadPasses();
      return null;
    },

    // ───────── GitHub ─────────
    /** Сохранить приложение по коду из адреса; возврат — слова отказа или null. */
    async setup(code: string): Promise<string | null> {
      const r = await app.request<{ app: { slug: string }; install: string }>("github.setup", { code });
      if (!r.ok) return say(r.error);
      history.replaceState(null, "", location.pathname + location.hash);
      store.set((s) => void (s.gh = { app: r.result.app, install: r.result.install, repos: [] }));
      return null;
    },
    /** Форма создания приложения: своя у организации; отказ — словами. */
    async create(org: string): Promise<{ form?: Form; refused?: string }> {
      if (!org) return { form: okOf(store.get().gh)?.form };
      const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname, org });
      return r.ok ? { form: r.result.form } : { refused: say(r.error) };
    },
  };
}
