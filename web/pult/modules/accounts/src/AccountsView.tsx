// Вид «Аккаунты»: идущие входы, диалог нового аккаунта и карточка на почту со всех машин.
import { useMemo } from "react";
import { machineOf } from "@switchboard/protocol";
import { ago, Btn, Hint, Note, Opts, OptsInline, Pill, plural, Sec, useApp } from "@switchboard/web-ui";
import { useAccounts, useScreen } from "./context.ts";
import { NewDlg, RmDlg, SessDlg } from "./Dialogs.tsx";
import { LoginCard } from "./LoginCard.tsx";
import { NoteLine, Refused, Windows } from "./parts.tsx";
import { slotsWith, type Account } from "./store.ts";

type Entry = { machine: string; name: string; a: Account };

/** Откуда окно: событие сессии, опрос claude или расход с другой машины. */
const SRC: Record<string, string> = { event: "по ответу сессии", poll: "спросили claude" };

/** «＋ войти на машине…»: любая машина на связи, где этой почты ещё нет; имя на машине — то же, что на других. */
function AnyMachine({ id, list }: { id: string; list: Entry[] }) {
  const app = useApp();
  const store = useAccounts();
  const sc = useScreen();
  const all = app.use(() => store.machines("machine.login"));
  const free = all.filter((m) => !list.some((x) => x.machine === m));
  if (!free.length) return null;
  const name = list[0].name;
  if (sc.pickFor !== id) {
    return (
      <Opts>
        <Btn dash data-any={id} onClick={() => sc.setPickFor(id)}>
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
            sc.setPickFor("");
            void store.login(m, name);
          }}
        >
          {sc.near.includes(m) ? `${m} ★` : m}
        </Btn>
      ))}
      <Btn onClick={() => sc.setPickFor("")}>Отмена</Btn>
    </Opts>
  );
}

function MachineRow({ m, name, a }: Entry & { m: string }) {
  const app = useApp();
  const store = useAccounts();
  const sc = useScreen();
  const list = app.use(() => store.slotsOf(m)) ?? {};
  const can = app.use(() => ({ swap: app.can(m, "slot.swap"), login: app.can(m, "machine.login"), remove: app.can(m, "machine.account_remove") }));
  const inSlots = slotsWith(list, name);
  const reserve = Object.entries(list).find(([, s]) => s.account !== name && s.order.includes(name))?.[0];
  const st = a.login === "ok" ? "вошёл" : a.login === "pending" ? "вход идёт" : "нет входа";
  return (
    <div className="ac-m" data-machine={m}>
      <b>{m}</b>
      <span>
        <Hint tone={a.login === "ok" ? "ok" : "wait"}>{st}</Hint> {inSlots.length ? `${inSlots.length > 1 ? "в слотах" : "в слоте"} ${inSlots.join(", ")}` : reserve ? `запас ${reserve}` : ""}
      </span>
      <OptsInline>
        {can.swap
          ? inSlots.map((sl) => (
              <Btn key={sl} data-sess={sl} onClick={() => sc.setDlg({ kind: "sess", machine: m, slot: sl })}>
                {`Сессии${inSlots.length > 1 ? ` ${sl}` : ""} (${list[sl].sessions.length})…`}
              </Btn>
            ))
          : null}
        {a.login !== "ok" && can.login ? (
          <Btn pri onClick={() => void store.login(m, name)}>
            Войти
          </Btn>
        ) : null}
        {can.remove ? <Btn onClick={() => sc.setDlg({ kind: "rm", machine: m, account: name })}>Удалить…</Btn> : null}
      </OptsInline>
    </div>
  );
}

function AccountCard({ id, list, sessions }: { id: string; list: Entry[]; sessions: number }) {
  const app = useApp();
  const store = useAccounts();
  const { dlg } = useScreen();
  const slots = app.use(store.allSlots);
  const first = list[0].a;
  // окна — запись одной машины, как пришла: первая машина, у которой они есть
  const src = list.find((x) => Object.keys(x.a.limits ?? {}).length);
  const w0 = src ? Object.values(src.a.limits ?? {})[0] : undefined;
  const inN = list.filter((x) => x.a.login === "ok").length;
  return (
    <Sec data-account={id}>
      <div className="ac-hd">
        <b>{first.email ?? list[0].name}</b>
        {first.plan ? <Pill tone="busy">{first.plan}</Pill> : first.email ? null : <Hint>почта — после входа</Hint>}
        <Hint>{`${sessions} ${plural(sessions, "сессия", "сессии", "сессий")}`}</Hint>
      </div>
      {src ? <Windows a={src.a} /> : null}
      {src && w0 ? <Note>{[w0.src ? (SRC[w0.src] ?? `от ${w0.src}`) : null, src.machine, w0.at ? ago(w0.at * 1000) : ""].filter(Boolean).join(" · ")}</Note> : null}
      <div className="ac-sum" data-in={inN}>{`вошёл на ${inN} ${plural(inN, "машине", "машинах", "машинах")}`}</div>
      {list.map((x) => (
        <MachineRow key={x.machine} m={x.machine} machine={x.machine} name={x.name} a={x.a} />
      ))}
      <AnyMachine id={id} list={list} />
      {list.map((x) => (
        <NoteLine key={x.machine} k={`rm:${x.machine}:${x.name}`} />
      ))}
      {list
        .filter((x) => dlg?.kind === "rm" && dlg.machine === x.machine && dlg.account === x.name)
        .map((x) => (
          <RmDlg key={x.machine} m={x.machine} account={x.name} list={slots[x.machine] ?? {}} />
        ))}
      {list.flatMap((x) =>
        Object.entries(slots[x.machine] ?? {})
          .filter(([n, s]) => s.account === x.name && dlg?.kind === "sess" && dlg.machine === x.machine && dlg.slot === n)
          .map(([n, s]) => <SessDlg key={`${x.machine}:${n}`} m={x.machine} slot={n} s={s} targets={Object.keys(slots[x.machine]).filter((y) => y !== n)} />),
      )}
    </Sec>
  );
}

export function AccountsView() {
  const app = useApp();
  const store = useAccounts();
  const { dlg } = useScreen();
  const accs = app.use(store.allAccs);
  const logins = app.use(() => store.state().logins);
  const loaded = app.use(store.loaded);
  const refused = app.use(() => Object.keys(store.refused()).some((k) => k.endsWith("machine.accounts")));
  const sessions = app.use(() => app.roster()?.sessions ?? []);
  const groups = useMemo(() => {
    const out = new Map<string, Entry[]>();
    for (const [machine, list] of Object.entries(accs)) {
      for (const [name, a] of Object.entries(list)) {
        const key = a.email ?? `name:${name}`;
        out.set(key, [...(out.get(key) ?? []), { machine, name, a }]);
      }
    }
    return [...out];
  }, [accs]);
  return (
    <>
      {Object.entries(logins).map(([k, l]) => (
        <LoginCard key={k} k={k} l={l} />
      ))}
      {dlg?.kind === "new" ? <NewDlg key={dlg.id} first={dlg.machine} /> : null}
      <div className="ac-cards">
        {groups.map(([key, list]) => (
          <AccountCard key={key} id={key} list={list} sessions={sessions.filter((s) => list.some((x) => x.machine === machineOf(s.callsign) && x.name === s.account)).length} />
        ))}
      </div>
      <Refused only={(k) => k.endsWith("machine.accounts")} />
      {!groups.length && !refused ? <Note>{loaded ? "Аккаунтов нет — «+ Новый аккаунт»." : "Загружаю аккаунты машин…"}</Note> : null}
    </>
  );
}
