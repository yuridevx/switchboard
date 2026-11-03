// Логика формы новой сессии: снимок формы и запросы к машине. Ответы приходят позже отрисовки — читают последний снимок, а не тот, что был при запросе.
import { useEffect, useRef, useState } from "react";
import { useApp, type Params } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { useOpen } from "./context.ts";
import { dirOf, dirOfAddr, EMPTY, HOME, splitAddr, type Form, type Profiles, type Slots } from "./form.ts";
import { profileIdOf } from "@switchboard/web-ui";

/** Снимок формы и чтение последнего из отложенных ответов. */
function useSnapshot(initial: Form) {
  const [value, setValue] = useState(initial);
  const latest = useRef(value);
  const set = (patch: Partial<Form>) => {
    latest.current = { ...latest.current, ...patch };
    setValue(latest.current);
  };
  return [value, () => latest.current, set] as const;
}

export type OpenForm = ReturnType<typeof useOpenForm>;

export function useOpenForm(params: Params) {
  const app = useApp();
  const open = useOpen();
  const [f, s, set] = useSnapshot(EMPTY);
  const online = app.use(open.machines);
  // первый ответ о своих местах нужен, чтобы выбрать место старта
  const known = app.use(open.known);

  function setProfile(id: string | null) {
    if (s().modelSet) return set({ profile: id });
    const pr = id ? s().profiles?.[id] : undefined;
    set({ profile: id, model: pr?.model ?? "", effort: pr?.effort ?? "" });
  }

  /** Профиль по умолчанию — только от сессии в этой же папке: имя папки ничего не значит. */
  function defaultProfile() {
    const { profileSet, profiles, machine, addr } = s();
    if (profileSet) return;
    const have = profiles ?? {};
    const dir = dirOfAddr(addr);
    const used = open.sessions().find((x) => machineOf(x.callsign) === machine && dirOf(x) === dir && profileIdOf(x) && have[(x.profile as { id: string }).id]);
    setProfile(used ? (used.profile as { id: string }).id : null);
  }

  async function loadMachine() {
    const m = s().machine;
    set({ slots: null, profiles: null, refused: {}, slot: "" });
    const jobs: Array<Promise<void>> = [];
    if (open.can(m, "machine.slots"))
      jobs.push(
        app.request<{ slots: Slots }>("machine.slots", { machine: m }).then((r) => {
          if (m !== s().machine) return;
          if (!r.ok) return set({ refused: { ...s().refused, "machine.slots": r.error } });
          const slots = r.result.slots ?? {};
          set({ slots, slot: s().slot || (Object.keys(slots)[0] ?? "") });
        }),
      );
    if (open.can(m, "machine.profiles"))
      jobs.push(
        app.request<{ profiles: Profiles }>("machine.profiles", { machine: m }).then((r) => {
          if (m !== s().machine) return;
          if (!r.ok) return set({ refused: { ...s().refused, "machine.profiles": r.error } });
          set({ profiles: r.result.profiles ?? {} });
          defaultProfile();
        }),
      );
    await Promise.all(jobs);
  }

  /** Список — один запрос на родителя: буквы хвоста новых запросов не дают. */
  async function listParent() {
    const m = s().machine;
    const { parent } = splitAddr(s().addr);
    if (!m || (s().list?.m === m && s().list?.parent === parent)) return;
    set({ list: { m, parent, dirs: [], word: "" } });
    const r = await app.request<{ path: string; dirs: string[] }>("machine.dirs", { machine: m, path: parent });
    if (s().machine !== m || splitAddr(s().addr).parent !== parent) return;
    set({ list: { m, parent, dirs: r.ok ? r.result.dirs : [], word: r.ok ? "" : r.error } });
  }

  function setAddr(addr: string) {
    set({ addr, err: "" });
    void listParent();
    defaultProfile();
  }

  function pick(m: string, dir: string) {
    const same = m === s().machine;
    set({ machine: m, pickM: false, err: "" });
    setAddr(dir);
    if (!same) void loadMachine();
  }

  async function start() {
    const { name } = s();
    set({ nameErr: name ? "" : "нужно имя", err: "" });
    if (!name) return;
    set({ sending: true });
    const { machine, addr, slot, profile, modelSet, model, effort, r2, text } = s();
    const dir = dirOfAddr(addr);
    // создать или нет — решает машина: просьба уходит всегда, агентов это не касается
    const body: Record<string, unknown> = { machine, name, dir, mkdir: true };
    if (slot) body.slot = slot;
    if (profile) body.profile = profile;
    if (modelSet && model) body.model = model;
    if (modelSet && effort) body.effort = effort;
    const r = await app.request<{ callsign: string }>("session.open", body);
    if (!r.ok) {
      const atName = r.error === "name_taken" ? `на ${machine} уже есть ${name}` : r.error === "bad_name" ? "латиница, цифры, точка, - и _" : "";
      set({ sending: false, ...(atName ? { nameErr: atName } : { err: `session.open: ${r.error}` }) });
      return;
    }
    const callsign = r.result.callsign;
    open.remember({ m: machine, dir });
    for (const it of app.placed("open.after", params)) app.open(it.screen, { ...params, callsign });
    // пометку «в R2» держит host-points машины новой сессии; manage о ней не знает
    if (r2 && open.can(machine, "session.r2")) {
      const m = await app.request("session.r2", { callsign, on: true });
      if (!m.ok) app.toast(`${callsign}: «в R2» не включилось — ${m.error}`);
    }
    // задача — необязательно: без неё сессия открыта и ждёт ввода
    if (text.trim()) {
      const t = await app.request("session.prompt", { callsign, text: text.trim(), attachments: [] });
      if (!t.ok) app.toast(`${callsign}: задача не ушла — ${t.error}`);
    }
    set({ sending: false });
    app.open("card", { callsign });
  }

  /** Откуда старт: адрес страницы, иначе последнее своё место, иначе машина с наибольшим числом сессий и домашняя папка. Машина может прийти своим соединением позже первого roster. */
  useEffect(() => {
    if (s().machine) return;
    if (params.machine) {
      if (online.includes(params.machine)) pick(params.machine, params.dir || HOME);
      return;
    }
    if (!known) return;
    const last = open.recents().find((x) => online.includes(x.m));
    if (last) return pick(last.m, last.dir);
    const m = open.byUse(online)[0];
    if (m) pick(m, HOME);
    // выбирается один раз, когда есть из чего: остальное читается на этот момент
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, known]);

  return { f, set, online, setProfile, setAddr, pick, start };
}
