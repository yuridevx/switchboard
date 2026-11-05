// Слоты машины: кто в слоте, запас по порядку, новый слот. Подмену делает Host; отсюда — порядок и «Сменить сейчас».
import { useState } from "react";
import { at, Btn, type AccountInfo, type AccountsAnswer, H4, IconBtn, In, LIMIT_NAMES, Note, okOf, Opts, Outcome, PageHead, PickOne, plainSession, plural, Sec, Sel, type SlotInfo, useApp } from "@switchboard/web-ui";
import { type Shared, Windows, windowsOf } from "./AccountsColumn.tsx";
import { SwapChoice, swapSlot } from "./Dialogs.tsx";
import { refusal, useAccounts } from "./state.ts";

const usage = (info?: AccountInfo) => windowsOf(info).map(([w, v]) => `${LIMIT_NAMES[w] ?? w} ${Math.round(v.utilization * 100)} %`).join(" · ");

export function SlotsColumn({ answers, machines, near, notes, say, cur, pick, wide }: Shared & { cur: string; pick(m: string): void; wide: boolean }) {
  const app = useApp();
  const state = useAccounts();
  const [fresh, setFresh] = useState("");
  const answer = okOf(answers[cur]);
  const listKey = `slots:${cur}`;

  /** Отказ — у слота; итог, который переживёт карточку слота, — над списком. */
  async function save(slot: string, order: string[], done = "порядок сохранён", doneKey = `set:${cur}:${slot}`) {
    const key = `set:${cur}:${slot}`;
    say(key, "Сохраняю…");
    const r = await app.request("slot.set", { machine: cur, slot, order });
    if (!r.ok) {
      say(doneKey === listKey && !answer?.slots?.[slot] ? listKey : key, refusal(r, cur), "bad");
      return false;
    }
    say(key, doneKey === key ? done : "");
    say(doneKey, done, "ok");
    void state.answers.reload(cur);
    return true;
  }

  async function create() {
    const name = fresh.trim();
    const first = Object.entries(answer?.accounts ?? {}).find(([, a]) => a.login === "ok")?.[0];
    if (!name) return;
    if (!first) return say(listKey, "На машине нет вошедшего аккаунта", "bad");
    if (await save(name, [first], `слот ${name} создан`, listKey)) setFresh("");
  }

  return (
    <>
      <PageHead title={wide ? "Слоты" : undefined} />
      {!machines.length ? <Note>Нет машин со слотами на связи.</Note> : null}
      {machines.length ? (
        <Opts data-slot-machines="">
          <PickOne all={machines} near={near} cur={cur} on={pick} select={{ "data-f": "slotm", "aria-label": "Другая машина" } as never} />
        </Opts>
      ) : null}
      {machines.length && !answer ? (
        answers[cur] === undefined ? <Note data-slots-wait="">…</Note> : null
      ) : null}
      <Outcome note={notes[listKey]} data-note={listKey} />
      {answer
        ? Object.entries(answer.slots ?? {}).map(([name, slot]) => (
            <SlotCard key={name} machine={cur} name={name} slot={slot} answer={answer} notes={notes} say={say} save={save} remove={() => void save(name, [], `слот ${name} удалён`, listKey)} />
          ))
        : null}
      {answer ? (
        <Sec>
          <H4>{`+ Новый слот на ${cur}`}</H4>
          <Opts>
            <In mono data-f="newslot" placeholder="имя слота" value={fresh} onInput={(e) => setFresh(e.currentTarget.value)} />
            <Btn onClick={() => void create()}>Создать</Btn>
          </Opts>
        </Sec>
      ) : null}
    </>
  );
}

type CardProps = Pick<Shared, "notes" | "say"> & { machine: string; name: string; slot: SlotInfo; answer: AccountsAnswer; save(slot: string, order: string[]): Promise<boolean>; remove(): void };

function SlotCard({ machine, name, slot, answer, notes, say, save, remove }: CardProps) {
  const app = useApp();
  const state = useAccounts();
  const [swapTo, setSwapTo] = useState("");
  const count = slot.sessions.length;
  const shared = Object.entries(answer.slots).filter(([n, s]) => n !== name && s.account && s.account === slot.account).map(([n]) => n);
  const addable = Object.entries(answer.accounts).filter(([n, a]) => a.login === "ok" && !slot.order.includes(n)).map(([n]) => n);
  const swapKey = `swap:${machine}:${name}`;
  const setKey = `set:${machine}:${name}`;
  const up = (i: number) => {
    const order = [...slot.order];
    [order[i - 1], order[i]] = [order[i], order[i - 1]];
    return order;
  };

  return (
    <Sec data-slot={`${machine}:${name}`}>
      <div className="ac-hd">
        <b>{`Слот ${name}`}</b>
        <span>{`${count} ${plural(count, "сессия", "сессии", "сессий")}${count ? `: ${slot.sessions.map((c) => plainSession(c).text).join(", ")}` : ""}`}</span>
      </div>
      {slot.wait ? <Note tone="wait">{`Слот ${name} ждёт сброса · ${at(slot.wait)}`}</Note> : null}
      <div data-current="">
        {`в слоте: ${slot.account ?? "никого"}`}
        {shared.length ? <span data-shared={shared.join(", ")}>{` · сейчас и в слоте ${shared.join(", ")}`}</span> : null}
      </div>
      <Windows info={slot.account ? answer.accounts[slot.account] : undefined} />
      <Note>Запас — по порядку</Note>
      {slot.order.map((n, i) => (
        <div key={n} className="ac-ord">
          <b>{n}</b>
          <span>{usage(answer.accounts[n])}</span>
          {i ? (
            <IconBtn aria-label={`${n} выше`} onClick={() => void save(name, up(i))}>
              ↑
            </IconBtn>
          ) : null}
          {n !== slot.account ? (
            <IconBtn aria-label={`убрать ${n}`} onClick={() => void save(name, slot.order.filter((x) => x !== n))}>
              ×
            </IconBtn>
          ) : null}
        </div>
      ))}
      <Outcome note={notes[setKey]} data-note={setKey} />
      <Opts>
        <Sel data-f={`add:${name}`} value="" onChange={(e) => e.currentTarget.value && void save(name, [...slot.order, e.currentTarget.value])}>
          <option value="">+ аккаунт в запас</option>
          {addable.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Sel>
      </Opts>
      <Opts>
        <SwapChoice field={`now:${name}`} order={slot.order} account={slot.account} value={swapTo} on={setSwapTo} />
        <Btn data-act="swap" onClick={() => void swapSlot(app, state, machine, name, slot.account, swapTo, say)}>
          Сменить сейчас
        </Btn>
        {!count && !slot.wait ? <Btn onClick={remove}>Удалить слот</Btn> : null}
      </Opts>
      <Outcome note={notes[swapKey]} data-note={swapKey} />
    </Sec>
  );
}
