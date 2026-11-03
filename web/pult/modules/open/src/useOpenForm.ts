// Логика формы новой сессии. В снимке — только ввод человека; ответы машины читает useLoad, профиль, модель и слот вычисляются из них.
import { useState } from "react";
import { useApp, type Params, type Result } from "@switchboard/web-core";
import { machineOf } from "@switchboard/protocol";
import { profileIdOf, useLoad } from "@switchboard/web-ui";
import { useOpen } from "./context.ts";
import { dirOf, dirOfAddr, EMPTY, HOME, splitAddr, type Form, type FormView, type Listing, type Profiles, type Slots } from "./form.ts";

export type OpenForm = ReturnType<typeof useOpenForm>;

/** Машина такого запроса не умеет: не спрашиваем, данных нет. */
const notAsked = <T,>(): Promise<Result<T>> => Promise.resolve({ ok: false, error: "" });

/** Ответ машины этой формы. Ответ прежней машины не считается: выбранных там слотов и профилей здесь может не быть; пока идёт новый ответ — данных нет. */
function useMachineAnswer<T>(machine: string, name: string) {
  const app = useApp();
  const open = useOpen();
  const q = useLoad<{ m: string; value: T }>(() => (open.can(machine, name) ? app.request<T>(name, { machine }).then((r) => (r.ok ? { ok: true as const, result: { m: machine, value: r.result } } : r)) : notAsked()), [machine]);
  return { data: q.data?.m === machine ? q.data.value : null, error: q.loading ? "" : q.error };
}

export function useOpenForm(params: Params) {
  const app = useApp();
  const open = useOpen();
  const [input, setInput] = useState<Form>(EMPTY);
  const set = (patch: Partial<Form>) => setInput((v) => ({ ...v, ...patch }));
  const online = app.use(open.machines);
  // первый ответ о своих местах нужен, чтобы выбрать место старта
  const known = app.use(open.known);

  /** Откуда старт: адрес страницы, иначе последнее своё место, иначе машина с наибольшим числом сессий и домашняя папка. Машина может прийти своим соединением позже первого roster. */
  function startPlace() {
    if (params.machine) return online.includes(params.machine) ? { m: params.machine, dir: params.dir || HOME } : null;
    if (!known) return null;
    const last = open.recents().find((x) => online.includes(x.m));
    if (last) return last;
    const m = open.byUse(online)[0];
    return m ? { m, dir: HOME } : null;
  }
  // выбирается один раз, когда есть из чего: поправка при рисовании, эффект не нужен
  const start0 = input.machine ? null : startPlace();
  if (start0) setInput({ ...input, machine: start0.m, addr: start0.dir });

  const machine = start0?.m ?? input.machine;
  const addr = start0?.dir ?? input.addr;
  const { parent } = splitAddr(addr);

  const slotsQ = useMachineAnswer<{ slots: Slots }>(machine, "machine.slots");
  const profilesQ = useMachineAnswer<{ profiles: Profiles }>(machine, "machine.profiles");
  // список — один запрос на родителя: буквы хвоста новых запросов не дают
  const listQ = useLoad<NonNullable<Listing>>(
    () =>
      machine
        ? app.request<{ path: string; dirs: string[] }>("machine.dirs", { machine, path: parent }).then((r) => ({ ok: true as const, result: { m: machine, parent, dirs: r.ok ? r.result.dirs : [], word: r.ok ? "" : r.error } }))
        : notAsked(),
    [machine, parent],
  );

  const slots = slotsQ.data ? (slotsQ.data.slots ?? {}) : null;
  const profiles = profilesQ.data ? (profilesQ.data.profiles ?? {}) : null;

  /** Профиль по умолчанию — только от сессии в этой же папке: имя папки ничего не значит. */
  const autoProfile = app.use(() => {
    const have = profiles ?? {};
    const dir = dirOfAddr(addr);
    const used = open.sessions().find((x) => machineOf(x.callsign) === machine && dirOf(x) === dir && profileIdOf(x) && have[profileIdOf(x)!]);
    return used ? profileIdOf(used)! : null;
  });
  const profile = input.profile !== undefined ? input.profile : autoProfile;
  const chosen = profile ? profiles?.[profile] : undefined;

  const f: FormView = {
    ...input,
    machine,
    addr,
    profile,
    model: input.modelSet ? input.model : (chosen?.model ?? ""),
    effort: input.modelSet ? input.effort : (chosen?.effort ?? ""),
    slot: input.slot || Object.keys(slots ?? {})[0] || "",
    slots,
    profiles,
    list: listQ.data ?? null,
    refused: { ...(slotsQ.error ? { "machine.slots": slotsQ.error } : {}), ...(profilesQ.error ? { "machine.profiles": profilesQ.error } : {}) },
  };

  function setAddr(next: string) {
    set({ addr: next, err: "" });
  }

  /** Другая машина — снова профиль и слот по умолчанию: выбранных там может не быть. */
  function pick(m: string, dir: string) {
    set({ ...(m === machine ? {} : { machine: m, slot: "", profile: undefined }), addr: dir, pickM: false, err: "" });
  }

  /** Модель или усилие выбраны человеком: дальше оба не следуют за профилем. */
  function chooseModel(patch: { model?: string; effort?: string }) {
    set({ model: f.model, effort: f.effort, ...patch, modelSet: true });
  }

  async function start() {
    const { name, slot, modelSet, model, effort, r2, text } = f;
    set({ nameErr: name ? "" : "нужно имя", err: "" });
    if (!name) return;
    set({ sending: true });
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

  return { f, set, online, setProfile: (id: string | null) => set({ profile: id }), chooseModel, setAddr, pick, start };
}
