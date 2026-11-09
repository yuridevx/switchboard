// Экран новой сессии: имя, машина и адрес, таблица участников, задача. «Открыть» — запрос на участника: решает машина.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { Area, Btn, Chip, Chips, DisclosureBtn, IconBtn, In, machineLabel, machinesWith, RowBtn, slotChoice, Switch, useApp, useLoad, useMachineLoad, useModule, type AccountsAnswer, type FleetKeysAnswer, type ProfilesAnswer } from "@switchboard/web-ui";
import { PartyTable, type PartySide, type PartyValue } from "@switchboard/web-party";
import { byLoad, dirOf, profileHere, pushRecent, refusal, shownDirs, splitAddress, startPlace, type Place } from "./form.ts";
import type { OpenState } from "./module.tsx";

const cx = (...names: unknown[]) => names.filter(Boolean).join(" ");
/** Выбор участника: list — null, пока не тронут: как у этой папки. */
type Pick = Omit<PartyValue, "list"> & { list: string[] | null };
const EMPTY: Pick = { list: null, model: "", effort: "", slot: "" };

export function OpenScreen({ params }: ScreenProps) {
  const app = useApp();
  const recent = useModule<OpenState>();
  const sessions = app.use(() => app.roster()?.sessions ?? []);
  const machines = app.use(() => byLoad(machinesWith(app, "session.open"), app.roster()?.sessions ?? []));
  const places = app.use(() => recent.get<Place[]>("recent") ?? []);
  const ready = app.use(() => recent.ready() || app.link() !== "open");
  const canR2Of = app.use(() => machinesWith(app, "session.archive"));

  const [machine, setMachine] = useState(params.machine ?? "");
  const [addr, setAddr] = useState(params.dir ?? "");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [picking, setPicking] = useState(false);
  const [lead, setLead] = useState<Pick>(EMPTY);
  const [wing, setWing] = useState<Pick>(EMPTY);
  const [paired, setPaired] = useState(false);
  const [r2, setR2] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nameErr, setNameErr] = useState("");
  const [err, setErr] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);

  // место выбирается один раз: новый roster выбор не меняет
  const started = useRef(!!params.machine);
  useEffect(() => {
    if (started.current || !ready) return;
    const place = startPlace(machines, sessions, places);
    if (!place) return;
    started.current = true;
    setMachine(place.m);
    setAddr(place.dir);
  }, [ready, machines, sessions, places]);
  useEffect(() => nameInput.current?.focus(), []);

  const here = machines.includes(machine);
  const address = here ? addr || "~" : "~";
  const { parent, tail } = splitAddress(address);
  const dirs = useMachineLoad<{ dirs: string[] }>(machine, "machine.dirs", { machine, path: parent }, here);
  const accounts = useMachineLoad<AccountsAnswer>(machine, "machine.accounts", { machine }, here);
  const profiles = useMachineLoad<ProfilesAnswer>(machine, "machine.profiles", { machine }, here);
  const fleet = useLoad<FleetKeysAnswer>(() => app.read<FleetKeysAnswer>("fleetkeys.list", {}), []);
  const keys = fleet.data?.keys ?? {};
  const keyNames = Object.keys(keys);
  const slots = accounts.stale ? undefined : accounts.data?.slots;
  const profileList = profiles.stale ? undefined : profiles.data?.profiles;
  const slotNames = Object.keys(slots ?? {});
  const noSlots = !!slots && !slotNames.length && !keyNames.length;
  /** Слот участника: ключ флота — только названный; иначе правило слотов машины. */
  const slotNow = (p: Pick) => (keyNames.includes(p.slot) ? p.slot : slotChoice(slotNames, p.slot) || slotNames[0] || "");
  const dir = dirOf(address);
  const listOf = (p: Pick) => (p.list ?? profileHere(sessions, machine, dir)).filter((id) => profileList?.[id]);
  const canR2 = canR2Of.includes(machine);
  const list = dirs.stale ? [] : shownDirs(dirs.data?.dirs ?? [], tail);
  const dirWord = dirs.stale ? "" : dirs.error;
  const isNew = here && !!addr && !dirs.stale && !dirs.loading && (dirWord === "not_found" || (!dirWord && !!tail && !dirs.data?.dirs.includes(tail)));
  const wide = app.wide;

  function goMachine(m: string) {
    setMachine(m);
    setAddr("~");
    setPicking(false);
    setLead(EMPTY);
    setWing(EMPTY);
    setErr("");
  }
  function enter(sub: string) {
    setAddr(`${parent === "/" ? "" : parent}/${sub}/`);
    setErr("");
  }
  function keyAddr(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Tab" && tail && list[0]) {
      e.preventDefault();
      enter(list[0]);
    }
  }

  /** Что уходит в запрос от участника: только выбранное; слот — если выбирать есть из чего. */
  const sideBody = (p: Pick) => {
    const slot = keyNames.includes(p.slot) ? p.slot : slotChoice(slotNames, p.slot);
    return { ...(slot ? { slot } : {}), ...(listOf(p).length ? { profile: listOf(p) } : {}), ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) };
  };
  /** Включить пару: ведомый начинает со значений ведущего, дальше они независимы. */
  function togglePair() {
    if (!paired) setWing({ ...lead, list: listOf(lead), slot: slotNow(lead) });
    setPaired(!paired);
  }

  async function open() {
    if (busy || !here || noSlots) return;
    const clean = name.trim();
    if (!clean) return setNameErr("нужно имя");
    setBusy(true);
    setNameErr("");
    setErr("");
    const asked = await app.request<{ callsign: string }>("session.open", {
      machine,
      name: clean,
      dir,
      mkdir: true,
      ...sideBody(lead),
    });
    if (!asked.ok) {
      setBusy(false);
      const r = refusal(asked.error, asked.why, machine, clean);
      if (r.field === "name") setNameErr(r.text);
      else setErr(r.text);
      if (r.field === "slot") accounts.reload();
      return;
    }
    const callsign = asked.result.callsign;
    if (paired) {
      const r = await app.request("session.open", { machine, wing_of: callsign, ...sideBody(wing) });
      if (!r.ok) app.toast(`${callsign}: ведомый не открылся — ${r.error}`);
    }
    recent.edit<Place[]>("recent", (old) => pushRecent(old, { m: machine, dir }));
    for (const p of app.placed("open.after", { ...params, callsign })) app.run(p.name, { ...params, callsign });
    if (r2 && canR2) {
      const r = await app.request("session.archive", { callsign, on: true });
      if (!r.ok) app.toast(`${callsign}: архив не включился — ${r.error}`);
    }
    if (text.trim()) {
      const r = await app.request("session.prompt", { callsign, text: text.trim() });
      if (!r.ok) app.toast(`${callsign}: задача не ушла — ${r.error}`);
    }
    app.open("card", { callsign });
  }
  const keyRun = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void open();
    }
  };

  const machineList = (
    <div className="op-bl" role="listbox" aria-label="Машины">
      {machines.length ? (
        machines.map((m) => {
          const shown = machineLabel(app, m);
          return (
            <RowBtn key={m} role="option" aria-selected={m === machine ? "true" : "false"} data-machine={m} onClick={() => goMachine(m)}>
              <b className={shown.human ? "hum" : undefined}>{shown.text}</b>
            </RowBtn>
          );
        })
      ) : (
        <span className="op-none">машин нет</span>
      )}
    </div>
  );
  const recentChips = [{ m: machine, dir: "~" }, ...places.filter((p) => machines.includes(p.m) && !(p.m === machine && p.dir === "~"))];
  const browser = (
    <div className="op-bf">
      {!wide ? (
        <DisclosureBtn open={picking} className="op-bk" data-act="pick-machine" onClick={() => setPicking(!picking)}>
          {machineLabel(app, machine).text}
        </DisclosureBtn>
      ) : null}
      {!wide && picking ? machineList : null}
      {recentChips.length > 1 ? (
        <Chips className="op-rec" aria-label="Последние места">
          {recentChips.map((p) => (
            <Chip
              key={`${p.m}:${p.dir}`}
              on={p.m === machine && p.dir === dir}
              data-place={p.dir}
              data-place-machine={p.m}
              onClick={() => {
                if (p.m !== machine) goMachine(p.m);
                setAddr(p.dir);
              }}
            >
              {p.m === machine ? p.dir : `${machineLabel(app, p.m).text} ${p.dir}`}
            </Chip>
          ))}
        </Chips>
      ) : null}
      <In data-f="addr" aria-label="Адрес папки" autoComplete="off" spellCheck={false} disabled={!here} value={address} onChange={() => {}} onInput={(e) => setAddr(e.currentTarget.value)} onKeyDown={keyAddr} />
      {dirWord && dirWord !== "not_found" ? <div className="op-new">{dirWord === "no_access" ? "нет доступа к этой папке" : `machine.dirs: ${dirWord}`}</div> : null}
      <div className="op-dl">
        {list.map((d) => (
          <RowBtn key={d} data-dir={d} onClick={() => enter(d)}>
            <span>{`▸ ${d}`}</span>
          </RowBtn>
        ))}
        {!dirs.stale && dirs.data && !dirs.data.dirs.length ? <span className="op-none">пусто</span> : null}
      </div>
    </div>
  );
  const sideOf = (p: Pick, set: (p: Pick) => void): PartySide => ({ value: { ...p, list: listOf(p), slot: slotNow(p) }, set: (change) => set({ ...p, ...change }) });
  const settings = (
    <PartyTable lead={sideOf(lead, setLead)} wing={sideOf(wing, setWing)} paired={paired} togglePair={togglePair} data={{ machine, ready: here, profiles: profileList, slots, keys }}>
      {profiles.error && !profiles.stale ? <div className="op-err all" role="alert">{`machine.profiles: ${profiles.error}`}</div> : null}
      {accounts.error && !accounts.stale ? <div className="op-err all" role="alert">{`machine.accounts: ${accounts.error}`}</div> : null}
      {noSlots ? <div className="op-err all" role="alert" data-no-slots="">{`На ${machine} нет слотов: войдите в аккаунт на этой машине`}</div> : null}
    </PartyTable>
  );

  return (
    <div className={wide ? "op wide" : "op"}>
      {wide ? (
        <div className="op-h">
          <b>Новая сессия</b>
          <IconBtn className="op-x" aria-label="Закрыть" onClick={() => app.back()}>
            ✕
          </IconBtn>
        </div>
      ) : null}
      <div className="op-body">
        <div className={cx("op-nm", nameErr && "bad")}>
          <label htmlFor="op-name">Имя</label>
          <In ref={nameInput} id="op-name" data-f="name" required aria-required="true" autoComplete="off" spellCheck={false} value={name} onChange={() => {}} onInput={(e) => setName(e.currentTarget.value)} onKeyDown={keyRun} />
        </div>
        {nameErr ? (
          <span className="op-err" data-err="name" role="alert">
            {nameErr}
          </span>
        ) : null}
        {wide ? (
          <div className="op-brw">
            <div className="op-bm">{machineList}</div>
            {browser}
          </div>
        ) : (
          <div className="op-brw one">{browser}</div>
        )}
        {here ? settings : null}
      </div>
      <div className="op-cmp">
        <Area data-f="text" aria-label="Задача" placeholder="Что сделать?" rows={2} value={text} onChange={() => {}} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={keyRun} />
        {err ? (
          <span className="op-err" role="alert">
            {err}
          </span>
        ) : null}
        <div className="op-foot">
          <span className="op-sw">
            <span>Хранить в архиве</span>
            <Switch on={r2} data-r2="1" aria-label="Хранить в архиве" disabled={!canR2} onClick={() => setR2(!r2)} />
          </span>
          <Btn pri data-act="open" disabled={busy || !here || noSlots} onClick={() => void open()}>
            {isNew ? "Создать и открыть" : text.trim() ? "Начать" : "Открыть"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
