// Состояние настроек: ответы владельцев («Выпуски», keeper'ы, gate, github) и вид экрана, который переживает закрытие экрана
// (подвкладка, отмеченные машины, выданное приглашение). Каждая цифра — ответ владельца; своего модуль не считает.
import type { App, Roster } from "@switchboard/web-core";
import { createStore, machineAnswers, type MachineAnswers, plural, useModule, machinesWith, okOf } from "@switchboard/web-ui";
import { planOf, say, type Err, type KState, type Listed, type ReleaseData } from "./rules.ts";

export type Pass = { id: string; role: "host" | "client"; name: string; person: string | null; addr: string; state: "wait" | "ok"; by: string; at: number };
export type Form = { action: string; manifest: Record<string, unknown> };
export type Gh = { app: { slug: string } | null; repos?: string[]; install?: string; form?: Form };
export type Tone = "ok" | "bad" | "wait";
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
  notes: Record<string, { text: string; tone?: Tone }>;
};

/** Ответы keeper'ов для других модулей: читать и держать открытыми; перечитать — команда keeper.reload. */
export type KeeperAnswers = Pick<MachineAnswers<KState>, "get" | "mount">;

export type SettingsStore = ReturnType<typeof createSettingsStore>;
/** Стор модуля в экранах. */
export const useSettings = (): SettingsStore => useModule<SettingsStore>();

export function createSettingsStore(app: App) {
  const store = createStore<State>(
    { list: null, passes: null, gh: null, rtab: "machines", rsel: {}, invited: null, confirm: null, busy: "", notes: {} },
    () => app.changed(),
  );
  /** Ответы keeper'ов: один владелец на все экраны, «Машины» берут их меткой keeper.answers; keeper машины отвечает сам, даже когда Host мёртв. */
  const keeper: MachineAnswers<KState> = machineAnswers<KState>(app, (m) => app.request<KState>("keeper.state", { to: `.keeper@${m}` }));
  const note = (k: string, text: string, tone?: Tone) => store.set((s) => void (s.notes[k] = { text, tone }));
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
  async function setPlan(m: string, part: string, body: Record<string, unknown>, quiet = false) {
    const r = await app.request<{ machine: string; rev: number }>("releases.set", { machine: m, part, ...body });
    if (!r.ok) {
      note("rel", `@${m} ${part}: ${say(r.error)}`, "bad");
      return false;
    }
    if (!quiet) app.toast(`@${m}: план rev ${r.result.rev}`, "ok");
    return true;
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
    async pin(m: string, part: string, v: string | null) {
      if (await setPlan(m, part, { pin: v })) await Promise.all([loadList(), loadKeeper(m)]);
    },
    async togglePart(m: string, part: string) {
      const on = planOf(releaseData(), m)[part]?.on !== false;
      if (await setPlan(m, part, { on: !on })) await Promise.all([loadList(), loadKeeper(m)]);
    },
    async bulk(v: string | null) {
      const ms = Object.keys(store.get().rsel);
      const done = await Promise.all(ms.map((m) => setPlan(m, "host", { pin: v }, true)));
      const ok = done.filter(Boolean).length;
      app.toast(`${ok} ${plural(ok, "машина", "машины", "машин")}: план изменён`, ok === ms.length ? "ok" : "bad");
      store.set((s) => void (s.rsel = {}));
      await Promise.all([loadList(), ...ms.map(loadKeeper)]);
    },
    async deploy(part: string, version?: string) {
      store.set((s) => {
        s.busy = part;
        s.notes.deploy = { text: "" };
      });
      const r = await app.request<{ parts: Record<string, { from: string | null; to: string }> }>("releases.deploy", version ? { part, version } : { part });
      store.set((s) => void (s.busy = ""));
      if (!r.ok) return note("deploy", `Не выложен ${part}${version ? ` ${version}` : ""}: ${say(r.error)}`, "bad");
      const moved = Object.entries(r.result.parts).map(([p, x]) => `${p} ${x.from ?? "—"} → ${x.to}`);
      note("deploy", `Выложено: ${moved.join(", ")}`, "ok");
      await loadReleases();
    },

    // ───────── пропуска ─────────
    closeInvited: () => store.set((s) => void (s.invited = null)),
    /** Пригласить; возврат — удалось: форма закрывается. */
    async invite({ kind, name, person }: Inviting): Promise<boolean> {
      const role = kind === "machine" ? "host" : "client";
      const r = await app.request<{ kid: string; invite: string; addr: string }>("keys.invite", { role, name: name.trim(), ...(role === "client" ? { person: person.trim() } : {}) });
      if (!r.ok) {
        note("invite", say(r.error), "bad");
        return false;
      }
      store.set((s) => {
        s.invited = { kind, invite: r.result.invite, addr: r.result.addr };
        s.notes.invite = { text: "" };
      });
      await loadPasses();
      return true;
    },
    askRevoke: (id: string | null) => store.set((s) => void (s.confirm = id)),
    async revoke(p: Pass) {
      const r = await app.request<{ addr: string }>("keys.revoke", { kid: p.id });
      store.set((s) => void (s.confirm = null));
      if (!r.ok) return note("passes", `${p.addr}: ${say(r.error)}`, "bad");
      app.toast(`${p.addr} отозван — соединения закрыты`, "ok");
      await loadPasses();
    },

    // ───────── GitHub ─────────
    /** Сохранить приложение по коду из адреса; возврат — удалось. */
    async setup(code: string): Promise<boolean> {
      note("gh", "Сохраняю приложение…");
      const r = await app.request<{ app: { slug: string }; install: string }>("github.setup", { code });
      if (!r.ok) {
        note("gh", say(r.error), "bad");
        return false;
      }
      history.replaceState(null, "", location.pathname + location.hash);
      store.set((s) => {
        s.gh = { app: r.result.app, install: r.result.install, repos: [] };
        s.notes.gh = { text: "Приложение сохранено — установите его на репозитории.", tone: "ok" };
      });
      return true;
    },
    /** Форма создания приложения: своя у организации; отказ — строкой итога. */
    async create(org: string): Promise<Form | undefined> {
      if (!org) return okOf(store.get().gh)?.form;
      const r = await app.request<Gh>("github.app", { redirect: location.origin + location.pathname, org });
      if (r.ok) return r.result.form;
      note("gh", say(r.error), "bad");
      return undefined;
    },
  };
}
