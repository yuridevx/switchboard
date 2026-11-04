// Вид «Аккаунты»: идущие входы, диалог нового аккаунта и карточка на почту со всех машин.
import { useMemo } from "react";
import { machineOf } from "@switchboard/protocol";
import { ago, Btn, Hint, machineLabel, Note, Opts, OptsInline, Pill, plural, Sec, useApp } from "@switchboard/web-ui";
import { NewAccountDialog, RemoveDialog, SessionsDialog } from "./Dialogs.tsx";
import { LoginCard } from "./LoginCard.tsx";
import { NoteLine, Refused, Windows } from "./parts.tsx";
import { useScreen } from "./screen.tsx";
import { slotsWith, type Account, useAccounts } from "./store.ts";

/** Аккаунт на одной машине. */
type Entry = { machine: string; name: string; account: Account };

/** Откуда окно: событие сессии, опрос claude или расход с другой машины. */
const SOURCE: Record<string, string> = { event: "по ответу сессии", poll: "спросили claude" };
const LOGIN_WORD: Record<Account["login"], string> = { ok: "вошёл", pending: "вход идёт", none: "нет входа" };

/** «＋ войти на машине…»: любая машина на связи, где этой почты ещё нет; имя на машине — то же, что на других. */
function LoginElsewhere({ id, entries }: { id: string; entries: Entry[] }) {
  const app = useApp();
  const store = useAccounts();
  const screen = useScreen();
  const all = app.use(() => store.machines("machine.login"));
  const free = all.filter((m) => !entries.some((e) => e.machine === m));
  if (!free.length) return null;
  if (screen.pickFor !== id) {
    return (
      <Opts>
        <Btn dash data-any={id} onClick={() => screen.setPickFor(id)}>
          ＋ войти на машине…
        </Btn>
      </Opts>
    );
  }
  return (
    <Opts data-any-pick={id}>
      {free.map((m) => (
        <Btn
          key={m}
          data-m={m}
          onClick={() => {
            screen.setPickFor("");
            void store.login(m, entries[0].name);
          }}
        >
          {screen.near.includes(m) ? `${m} ★` : m}
        </Btn>
      ))}
      <Btn onClick={() => screen.setPickFor("")}>Отмена</Btn>
    </Opts>
  );
}

function MachineRow({ machine: m, name, account }: Entry) {
  const app = useApp();
  const store = useAccounts();
  const screen = useScreen();
  const slots = app.use(() => store.slotsOf(m)) ?? {};
  const label = app.use(() => machineLabel(app, m).text);
  const can = app.use(() => ({ swap: app.can(m, "slot.swap"), login: app.can(m, "machine.login"), remove: app.can(m, "machine.account_remove") }));
  const inSlots = slotsWith(slots, name);
  const reserveOf = Object.keys(slots).find((slot) => slots[slot].account !== name && slots[slot].order.includes(name));
  const place = inSlots.length ? `${inSlots.length > 1 ? "в слотах" : "в слоте"} ${inSlots.join(", ")}` : reserveOf ? `запас ${reserveOf}` : "";
  return (
    <div className="ac-m" data-machine={m}>
      <b>{label}</b>
      <span>
        <Hint tone={account.login === "ok" ? "ok" : "wait"}>{LOGIN_WORD[account.login]}</Hint> {place}
      </span>
      <OptsInline>
        {can.swap
          ? inSlots.map((slot) => (
              <Btn key={slot} data-sess={slot} onClick={() => screen.setDialog({ kind: "sess", machine: m, slot })}>
                {`Сессии${inSlots.length > 1 ? ` ${slot}` : ""} (${slots[slot].sessions.length})…`}
              </Btn>
            ))
          : null}
        {account.login !== "ok" && can.login ? (
          <Btn pri onClick={() => void store.login(m, name)}>
            Войти
          </Btn>
        ) : null}
        {can.remove ? <Btn onClick={() => screen.setDialog({ kind: "rm", machine: m, account: name })}>Удалить…</Btn> : null}
      </OptsInline>
    </div>
  );
}

function AccountCard({ id, entries, sessions }: { id: string; entries: Entry[]; sessions: number }) {
  const app = useApp();
  const store = useAccounts();
  const { dialog } = useScreen();
  const slots = app.use(store.allSlots);
  const first = entries[0].account;
  // окна — запись одной машины, как пришла: первая машина, у которой они есть
  const source = entries.find((e) => Object.keys(e.account.limits ?? {}).length);
  const sourceName = app.use(() => (source ? machineLabel(app, source.machine).text : ""));
  const w = source ? Object.values(source.account.limits ?? {})[0] : undefined;
  return (
    <Sec data-account={id}>
      <div className="ac-hd">
        <b>{first.email ?? entries[0].name}</b>
        {first.plan ? <Pill tone="busy">{first.plan}</Pill> : null}
        <Hint>{`${sessions} ${plural(sessions, "сессия", "сессии", "сессий")}`}</Hint>
      </div>
      {source ? <Windows account={source.account} /> : null}
      {w && (w.src || w.at) ? <Note>{[w.src ? (SOURCE[w.src] ?? `от ${w.src}`) : null, sourceName, w.at ? ago(w.at * 1000) : ""].filter(Boolean).join(" · ")}</Note> : null}
      {entries.map((e) => (
        <MachineRow key={e.machine} {...e} />
      ))}
      <LoginElsewhere id={id} entries={entries} />
      {entries.map((e) => (
        <NoteLine key={e.machine} k={`rm:${e.machine}:${e.name}`} />
      ))}
      {entries.map((e) => (dialog?.kind === "rm" && dialog.machine === e.machine && dialog.account === e.name ? <RemoveDialog key={e.machine} m={e.machine} account={e.name} slots={slots[e.machine] ?? {}} /> : null))}
      {entries.map((e) => {
        if (dialog?.kind !== "sess" || dialog.machine !== e.machine) return null;
        const here = slots[e.machine] ?? {};
        const slot = here[dialog.slot];
        return slot?.account === e.name ? <SessionsDialog key={e.machine} m={e.machine} name={dialog.slot} slot={slot} targets={Object.keys(here).filter((x) => x !== dialog.slot)} /> : null;
      })}
    </Sec>
  );
}

export function AccountsView() {
  const app = useApp();
  const store = useAccounts();
  const { dialog } = useScreen();
  const all = app.use(store.allAccounts);
  const logins = app.use(store.logins);
  const loaded = app.use(store.loaded);
  const refused = app.use(() => Object.keys(store.refused()).some((k) => k.endsWith("machine.accounts")));
  const running = app.use(() => app.roster()?.sessions ?? []);
  /** Карточка на почту; без почты — на имя. */
  const cards = useMemo(() => {
    const out = new Map<string, Entry[]>();
    for (const [machine, accounts] of Object.entries(all)) {
      for (const [name, account] of Object.entries(accounts)) {
        const key = account.email ?? `name:${name}`;
        out.set(key, [...(out.get(key) ?? []), { machine, name, account }]);
      }
    }
    return [...out];
  }, [all]);
  return (
    <>
      {Object.entries(logins).map(([k, login]) => (
        <LoginCard key={k} k={k} login={login} />
      ))}
      {dialog?.kind === "new" ? <NewAccountDialog key={dialog.id} first={dialog.machine} /> : null}
      <div className="ac-cards">
        {cards.map(([id, entries]) => (
          <AccountCard key={id} id={id} entries={entries} sessions={running.filter((s) => entries.some((e) => e.machine === machineOf(s.callsign) && e.name === s.account)).length} />
        ))}
      </div>
      <Refused only={(k) => k.endsWith("machine.accounts")} />
      {!cards.length && !refused ? <Note>{loaded ? "Аккаунтов нет — «+ Новый аккаунт»." : "Загружаю аккаунты машин…"}</Note> : null}
    </>
  );
}
