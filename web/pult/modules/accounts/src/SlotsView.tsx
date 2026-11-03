// Вид «Слоты»: слоты выбранной машины, запас по порядку, смена сейчас и новый слот.
import { useState } from "react";
import { useApp } from "@switchboard/web-core";
import { Btn, H4, Hint, hhmm, In, M, Note, Opts, PickOne, plural, Sec, Sel, LIMIT_NAMES } from "@switchboard/web-ui";
import { useAccounts, useScreen } from "./context.ts";
import { NoteLine, Refused, Shared, Windows } from "./parts.tsx";
import type { Account, Slot } from "./store.ts";

const NONE: Record<string, Account> = {};

function SlotCard({ m, name, s }: { m: string; name: string; s: Slot }) {
  const app = useApp();
  const store = useAccounts();
  const sc = useScreen();
  const a = app.use(() => store.accsOf(m)) ?? NONE;
  const [pick, setPick] = useState("");
  const others = s.order.filter((x) => x !== s.account);
  const now = others.includes(pick) ? pick : "";
  const free = Object.keys(a).filter((x) => !s.order.includes(x) && a[x].login === "ok");
  const move = (i: number, d: number) => {
    const o = [...s.order];
    const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    sc.setOrder(m, name, o);
  };
  return (
    <Sec data-slot={`${m}:${name}`}>
      {s.wait ? (
        <Sec tone="wait">
          <b>{`Слот ${name} ждёт сброса · ${hhmm(s.wait * 1000)}`}</b>
        </Sec>
      ) : null}
      <div className="ac-hd">
        <b>{`Слот ${name}`}</b>
        <Hint>{`${s.sessions.length} ${plural(s.sessions.length, "сессия", "сессии", "сессий")}${s.sessions.length ? ": " + s.sessions.map((c) => c.split("@")[0]).join(", ") : ""}`}</Hint>
      </div>
      <div data-current={s.account ?? ""}>
        <Hint>в слоте: </Hint>
        <M>
          <b>{s.account ?? "—"}</b>
        </M>
        {s.account ? <Shared m={m} account={s.account} except={name} /> : null}
      </div>
      <Windows a={s.account ? a[s.account] : undefined} />
      <H4>Запас — по порядку</H4>
      {s.order.map((x, i) => (
        <div key={x} className="ac-ord">
          <b>{x}</b>
          <Hint>{Object.entries(a[x]?.limits ?? {}).map(([k, w]) => `${LIMIT_NAMES[k] ?? k} ${Math.round(w.utilization * 100)} %`).join(" · ")}</Hint>
          <Shared m={m} account={x} except={name} />
          <Btn aria-label={`${x} выше`} disabled={i === 0} onClick={() => move(i, -1)}>
            ↑
          </Btn>
          <Btn aria-label={`${x} ниже`} disabled={i === s.order.length - 1} onClick={() => move(i, 1)}>
            ↓
          </Btn>
          {x !== s.account ? (
            <Btn aria-label={`убрать ${x}`} onClick={() => sc.setOrder(m, name, s.order.filter((y) => y !== x))}>
              ✕
            </Btn>
          ) : null}
        </div>
      ))}
      <Opts>
        <Sel data-f={`add:${name}`} value="" onChange={(e) => e.currentTarget.value && sc.setOrder(m, name, [...s.order, e.currentTarget.value])}>
          <option value="">+ аккаунт в запас</option>
          {free.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Sel>
        {!s.sessions.length ? (
          <Btn bad onClick={() => sc.setOrder(m, name, [])}>
            Удалить слот
          </Btn>
        ) : null}
      </Opts>
      <NoteLine k={`set:${m}:${name}`} />
      <Opts>
        <Sel data-f={`now:${name}`} value={now} onChange={(e) => setPick(e.currentTarget.value)}>
          <option value="">следующего по порядку — выберет Host</option>
          {others.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Sel>
        <Btn pri data-act="swap" onClick={() => sc.swap(m, name, now)}>
          Сменить сейчас
        </Btn>
      </Opts>
      <NoteLine k={`swap:${m}:${name}`} />
    </Sec>
  );
}

/** Новый слот на машине. */
function NewSlot({ m }: { m: string }) {
  const app = useApp();
  const store = useAccounts();
  const sc = useScreen();
  const a = app.use(() => store.accsOf(m)) ?? NONE;
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState("");
  const ready = Object.keys(a).filter((x) => a[x].login === "ok");
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
            sc.setOrder(m, name, [account]);
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
  const sc = useScreen();
  const ms = app.use(() => store.machines("machine.slots"));
  const m = sc.slotMachine;
  const list = app.use(() => store.slotsOf(m));
  return (
    <>
      {/* кнопками — выбранная и машины открытого проекта, остальные — списком */}
      <Opts data-slot-machines="">
        <PickOne all={ms} near={sc.near} cur={m} on={sc.pickSlotMachine} select={{ "data-f": "slotm", "aria-label": "Другая машина" }} />
      </Opts>
      <Refused only={(k) => k === `${m} · machine.slots`} />
      {Object.entries(list ?? {}).map(([name, s]) => (
        <SlotCard key={`${m}:${name}`} m={m} name={name} s={s} />
      ))}
      {m ? <NewSlot key={m} m={m} /> : null}
      {ms.length ? null : <Note>Нет машин со слотами на связи.</Note>}
    </>
  );
}
