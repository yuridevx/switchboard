// Экран новой сессии: имя, машина и адрес, профиль и модель в окнах, задача. «Открыть» — один запрос: решает машина.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ScreenProps } from "@switchboard/web-core";
import { Area, Btn, Chip, Chips, DisclosureBtn, EFFORTS, effortName, IconBtn, In, machineLabel, machinesWith, MODELS, profileName, RowBtn, slotChoice, SlotPick, slotWait, Switch, useApp, useMachineLoad, useModule, type AccountsAnswer, type ProfilesAnswer } from "@switchboard/web-ui";
import { byLoad, dirOf, profileHere, pushRecent, refusal, shownDirs, splitAddress, startPlace, type Place } from "./form.ts";
import type { OpenState } from "./module.tsx";

const cx = (...names: unknown[]) => names.filter(Boolean).join(" ");
type Pop = "prof" | "model" | null;

export function OpenScreen({ params }: ScreenProps) {
  const app = useApp();
  const recent = useModule<OpenState>();
  const sessions = app.use(() => app.roster()?.sessions ?? []);
  const machines = app.use(() => byLoad(machinesWith(app, "session.open"), app.roster()?.sessions ?? []));
  const places = app.use(() => recent.get<Place[]>("recent") ?? []);
  const ready = app.use(() => recent.ready() || app.link() !== "open");
  const canR2Of = app.use(() => machinesWith(app, "session.r2"));

  const [machine, setMachine] = useState(params.machine ?? "");
  const [addr, setAddr] = useState(params.dir ?? "");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [pop, setPop] = useState<Pop>(null);
  const [picking, setPicking] = useState(false);
  const [chosenProfile, setChosenProfile] = useState<string | null>(null);
  const [pq, setPq] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [slot, setSlot] = useState("");
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
  const address = addr || "~";
  const { parent, tail } = splitAddress(address);
  const dirs = useMachineLoad<{ dirs: string[] }>(machine, "machine.dirs", { machine, path: parent }, here);
  const accounts = useMachineLoad<AccountsAnswer>(machine, "machine.accounts", { machine }, here);
  const profiles = useMachineLoad<ProfilesAnswer>(machine, "machine.profiles", { machine }, here);
  const slots = accounts.stale ? undefined : accounts.data?.slots;
  const profileList = profiles.stale ? undefined : profiles.data?.profiles;
  const slotNames = Object.keys(slots ?? {});
  const slotNow = slotChoice(slotNames, slot) || slotNames[0] || "";
  const dir = dirOf(address);
  const profile = chosenProfile ?? profileHere(sessions, machine, dir);
  const profileOk = profile && profileList?.[profile] ? profile : "";
  const info = profileOk ? profileList![profileOk] : undefined;
  const modelShown = model || info?.model || "";
  const effortShown = effort || info?.effort || "";
  const canR2 = canR2Of.includes(machine);
  const list = dirs.stale ? [] : shownDirs(dirs.data?.dirs ?? [], tail);
  const dirWord = dirs.stale ? "" : dirs.error;
  const isNew = !!addr && !dirs.stale && !dirs.loading && (dirWord === "not_found" || (!dirWord && !!tail && !dirs.data?.dirs.includes(tail)));
  const wide = app.wide;

  function goMachine(m: string) {
    setMachine(m);
    setAddr("~");
    setPicking(false);
    setSlot("");
    setChosenProfile(null);
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

  async function open() {
    if (busy || !here) return;
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
      ...(slotChoice(slotNames, slot) ? { slot: slotChoice(slotNames, slot) } : {}),
      ...(profileOk ? { profile: profileOk } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
    if (!asked.ok) {
      setBusy(false);
      const r = refusal(asked.error, asked.why, machine, clean);
      if (r.field === "name") setNameErr(r.text);
      else setErr(r.text);
      if (r.field === "slot") {
        accounts.reload();
        setPop("model");
      }
      return;
    }
    const callsign = asked.result.callsign;
    recent.edit<Place[]>("recent", (old) => pushRecent(old, { m: machine, dir }));
    for (const p of app.placed("open.after", { ...params, callsign })) app.run(p.name, { ...params, callsign });
    if (r2) {
      const r = await app.request("session.r2", { callsign, on: true });
      if (!r.ok) app.toast(`${callsign}: «в R2» не включилось — ${r.error}`);
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
      {dirWord === "no_access" ? <div className="op-new">нет доступа к этой папке</div> : null}
      {dirWord && dirWord !== "no_access" && dirWord !== "not_found" ? <span className="op-err" role="alert">{`machine.dirs: ${dirWord}`}</span> : null}
      <div className="op-dl">
        {list.map((d) => (
          <RowBtn key={d} data-dir={d} onClick={() => enter(d)}>
            <span>{`▸ ${d}`}</span>
          </RowBtn>
        ))}
      </div>
    </div>
  );
  const shade = !wide && pop ? <div className="op-shade" onClick={() => setPop(null)} /> : null;
  const done = !wide ? (
    <Btn pri className="op-done" onClick={() => setPop(null)}>
      Готово
    </Btn>
  ) : null;
  const needle = pq.trim().toLowerCase();
  const profileRows = Object.entries(profileList ?? {}).filter(([id, p]) => `${profileName(id)} ${p.about ?? ""}`.toLowerCase().includes(needle));
  const pickProfile = (id: string) => {
    setChosenProfile(id);
    setPop(null);
  };
  const slotLine = slotWait(slots) || slotNow;

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
      </div>
      <div className="op-cmp">
        {shade}
        {pop === "prof" ? (
          <div className="op-pop" role="dialog" aria-label="Выбор">
            <div className="lb">{`Профиль · ${machineLabel(app, machine).text} · ${Object.keys(profileList ?? {}).length}`}</div>
            {profiles.error && !profiles.stale ? <div className="op-err" role="alert">{`machine.profiles: ${profiles.error}`}</div> : null}
            <In className="op-flt" data-f="pq" aria-label="Найти профиль" placeholder="Найти профиль" autoComplete="off" value={pq} onChange={() => {}} onInput={(e) => setPq(e.currentTarget.value)} />
            {profileRows.map(([id, p]) => (
              <RowBtn key={id} className="op-pr" role="radio" aria-checked={profileOk === id} data-profile={id} onClick={() => pickProfile(id)}>
                <span className="r1">
                  <b>{profileName(id)}</b>
                  {p.model ? <span className="sp">{[p.model, p.effort ? effortName(p.effort) : ""].filter(Boolean).join(" · ")}</span> : null}
                </span>
                {p.about ? <span className="r2">{p.about}</span> : null}
              </RowBtn>
            ))}
            <RowBtn className="op-pr" role="radio" aria-checked={!profileOk} data-profile="" onClick={() => pickProfile("")}>
              <span className="r1">
                <b>без профиля</b>
              </span>
            </RowBtn>
            {done}
          </div>
        ) : null}
        {pop === "model" ? (
          <div className="op-pop" role="dialog" aria-label="Выбор">
            <div className="lb">Модель</div>
            <Chips className="op-opts">
              {MODELS.map((m) => (
                <Chip key={m} on={modelShown === m} data-model={m} onClick={() => setModel(m)}>
                  {m}
                </Chip>
              ))}
            </Chips>
            <div className="lb">Усилие</div>
            <Chips className="op-opts">
              {EFFORTS.map(([k, label]) => (
                <Chip key={k} on={effortShown === k} data-effort={k} onClick={() => setEffort(k)}>
                  {label}
                </Chip>
              ))}
            </Chips>
            {accounts.error && !accounts.stale ? <div className="op-err" role="alert">{`machine.accounts: ${accounts.error}`}</div> : null}
            <SlotPick slots={slots ?? {}} value={slotNow} on={setSlot} />
            {canR2 ? (
              <div className="op-sw">
                <span>Точки в R2</span>
                <Switch on={r2} data-r2="1" aria-label="Точки в R2" onClick={() => setR2(!r2)} />
              </div>
            ) : null}
            {done}
          </div>
        ) : null}
        <div className="op-ctx">
          <Btn className="op-cx" data-pop="prof" disabled={!here} aria-expanded={pop === "prof"} onClick={() => setPop(pop === "prof" ? null : "prof")}>
            {profileOk ? <span className="k">Профиль</span> : null}
            <b>{profileOk ? profileName(profileOk) : "без профиля"}</b>
          </Btn>
          <Btn className="op-cx" data-pop="model" disabled={!here} aria-expanded={pop === "model"} onClick={() => setPop(pop === "model" ? null : "model")}>
            {modelShown ? <b>{modelShown}</b> : null}
            <span className="k">{[modelShown ? "" : "Модель", effortShown ? effortName(effortShown) : "", slotLine, r2 ? "R2" : ""].filter(Boolean).join(" · ")}</span>
          </Btn>
        </div>
        <Area data-f="text" aria-label="Задача" placeholder="Что сделать?" rows={3} value={text} onChange={() => {}} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={keyRun} />
        {err ? (
          <span className="op-err" role="alert">
            {err}
          </span>
        ) : null}
        <div className="op-foot">
          <Btn pri data-act="open" disabled={busy || !here} onClick={() => void open()}>
            {isNew ? "Создать и открыть" : text.trim() ? "Начать" : "Открыть"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
