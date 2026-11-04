// Вид «Слоты»: слоты выбранной машины, запас по порядку, смена сейчас и новый слот.
import { nameOf } from "@switchboard/protocol";
import { useState } from "react";
import { Btn, H4, Hint, hhmm, In, LIMIT_NAMES, M, Note, Opts, PickOne, plural, Sec, Sel, useApp } from "@switchboard/web-ui";
import { NoteLine, Refused, Shared, Windows } from "./parts.tsx";
import { useScreen } from "./screen.tsx";
import { type Account, type Slot, useAccounts } from "./store.ts";

const NONE: Record<string, Account> = {};
const usageWord = (a: Account | undefined) => Object.entries(a?.limits ?? {}).map(([name, w]) => `${LIMIT_NAMES[name] ?? name} ${Math.round(w.utilization * 100)} %`).join(" · ");

function SlotCard({ m, name, slot }: { m: string; name: string; slot: Slot }) {
  const app = useApp();
  const store = useAccounts();
  const screen = useScreen();
  const accounts = app.use(() => store.accountsOf(m)) ?? NONE;
  const [picked, setPicked] = useState("");
  const reserve = slot.order.filter((x) => x !== slot.account);
  const next = reserve.includes(picked) ? picked : "";
  const free = Object.keys(accounts).filter((x) => !slot.order.includes(x) && accounts[x].login === "ok");
  const setOrder = (order: string[]) => screen.setOrder(m, name, order);
  function move(i: number, j: number) {
    const order = [...slot.order];
    [order[i], order[j]] = [order[j], order[i]];
    setOrder(order);
  }
  const count = slot.sessions.length;
  return (
    <Sec data-slot={`${m}:${name}`}>
      {slot.wait ? (
        <Sec tone="wait">
          <b>{`Слот ${name} ждёт сброса · ${hhmm(slot.wait * 1000)}`}</b>
        </Sec>
      ) : null}
      <div className="ac-hd">
        <b>{`Слот ${name}`}</b>
        <Hint>{`${count} ${plural(count, "сессия", "сессии", "сессий")}${count ? `: ${slot.sessions.map(nameOf).join(", ")}` : ""}`}</Hint>
      </div>
      <div data-current={slot.account ?? ""}>
        <Hint>в слоте: </Hint>
        <M>
          <b>{slot.account ?? "—"}</b>
        </M>
        {slot.account ? <Shared m={m} account={slot.account} except={name} /> : null}
      </div>
      <Windows account={slot.account ? accounts[slot.account] : undefined} />
      <H4>Запас — по порядку</H4>
      {slot.order.map((x, i) => (
        <div key={x} className="ac-ord">
          <b>{x}</b>
          <Hint>{usageWord(accounts[x])}</Hint>
          <Shared m={m} account={x} except={name} />
          <Btn aria-label={`${x} выше`} disabled={i === 0} onClick={() => move(i, i - 1)}>
            ↑
          </Btn>
          <Btn aria-label={`${x} ниже`} disabled={i === slot.order.length - 1} onClick={() => move(i, i + 1)}>
            ↓
          </Btn>
          {x !== slot.account ? (
            <Btn aria-label={`убрать ${x}`} onClick={() => setOrder(slot.order.filter((y) => y !== x))}>
              ✕
            </Btn>
          ) : null}
        </div>
      ))}
      <Opts>
        <Sel data-f={`add:${name}`} value="" onChange={(e) => e.currentTarget.value && setOrder([...slot.order, e.currentTarget.value])}>
          <option value="">+ аккаунт в запас</option>
          {free.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Sel>
        {count ? null : (
          <Btn bad onClick={() => setOrder([])}>
            Удалить слот
          </Btn>
        )}
      </Opts>
      <NoteLine k={`set:${m}:${name}`} />
      <Opts>
        <Sel data-f={`now:${name}`} value={next} onChange={(e) => setPicked(e.currentTarget.value)}>
          <option value="">следующего по порядку — выберет Host</option>
          {reserve.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Sel>
        <Btn pri data-act="swap" onClick={() => screen.swap(m, name, next)}>
          Сменить сейчас
        </Btn>
      </Opts>
      <NoteLine k={`swap:${m}:${name}`} />
    </Sec>
  );
}

function NewSlot({ m }: { m: string }) {
  const app = useApp();
  const store = useAccounts();
  const screen = useScreen();
  const accounts = app.use(() => store.accountsOf(m)) ?? NONE;
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState("");
  const ready = Object.keys(accounts).filter((x) => accounts[x].login === "ok");
  const account = ready.includes(chosen) ? chosen : (ready[0] ?? "");
  return (
    <Sec>
      <H4>{`+ Новый слот на ${m}`}</H4>
      <Opts>
        <In mono data-f="newslot" placeholder="имя слота" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <Sel value={account} onChange={(e) => setChosen(e.currentTarget.value)}>
          {ready.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Sel>
        <Btn
          onClick={() => {
            if (!name || !account) return;
            setName("");
            screen.setOrder(m, name, [account]);
          }}
        >
          Создать
        </Btn>
      </Opts>
    </Sec>
  );
}

export function SlotsView() {
  const app = useApp();
  const store = useAccounts();
  const screen = useScreen();
  const machines = app.use(() => store.machines("machine.accounts"));
  const m = screen.slotMachine;
  const slots = app.use(() => store.slotsOf(m));
  const waiting = app.use(() => !!m && store.waiting(m));
  return (
    <>
      {/* кнопками — выбранная и машины открытого проекта, остальные — списком */}
      <Opts data-slot-machines="">
        <PickOne all={machines} near={screen.near} cur={m} on={screen.pickSlotMachine} select={{ "data-f": "slotm", "aria-label": "Другая машина" }} />
      </Opts>
      <Refused only={(k) => k === `${m} · machine.accounts`} />
      {waiting ? <Note data-slots-wait="">…</Note> : null}
      {Object.entries(slots ?? {}).map(([name, slot]) => (
        <SlotCard key={`${m}:${name}`} m={m} name={name} slot={slot} />
      ))}
      {m && !waiting ? <NewSlot key={m} m={m} /> : null}
      {machines.length ? null : <Note>Нет машин со слотами на связи.</Note>}
    </>
  );
}
