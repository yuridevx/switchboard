// Аккаунты: карточка на почту со всех машин. Окна — запись Host одной машины как пришла: расход между машинами Host читает у Claude сам.
import { type ReactNode, useState } from "react";
import { type AccountInfo, type AccountsAnswer, Btn, H4, Hint, LIMIT_NAMES, LimitRow, machineLabel, type MachineAnswer, Note, okOf, Opts, OptsInline, Outcome, type OutcomeNote, PageHead, Pill, plural, Row, In, Sec, useApp, wordOf } from "@switchboard/web-ui";
import { RemoveDialog, SessionsDialog } from "./Dialogs.tsx";
import { LoginCardView } from "./LoginCard.tsx";
import { useAccounts } from "./state.ts";

type Answers = Readonly<Record<string, MachineAnswer<AccountsAnswer>>>;
export type Shared = { answers: Answers; machines: string[]; near: string[]; notes: Readonly<Record<string, OutcomeNote>>; say(key: string, text: string, tone?: OutcomeNote["tone"]): void };

type Dialog = { kind: "rm" | "sess"; card: string; machine: string; name: string };
type Line = { machine: string; name: string; info: AccountInfo };
type Card = { key: string; email?: string; plan?: string; lines: Line[] };

const NAME = /^[A-Za-z0-9_-]+$/;
const SOURCES: Record<string, string> = { event: "по ответу сессии", poll: "спросили claude" };

function cardsOf(answers: Answers): Card[] {
  const cards = new Map<string, Card>();
  for (const [machine, a] of Object.entries(answers)) {
    for (const [name, info] of Object.entries(okOf(a)?.accounts ?? {})) {
      const key = info.email ?? `name:${name}`;
      const card = cards.get(key) ?? { key, email: info.email, lines: [] };
      card.plan ??= info.plan;
      card.lines.push({ machine, name, info });
      cards.set(key, card);
    }
  }
  return [...cards.values()];
}

export const windowsOf = (info?: AccountInfo) => Object.entries(info?.limits ?? {});
export function Windows({ info }: { info?: AccountInfo }) {
  return windowsOf(info).map(([w, v]) => <LimitRow key={w} className="ac-w" data-window={w} label={LIMIT_NAMES[w] ?? w} used={v.utilization} resets={v.resetsAt} />);
}

/** signIn: пришли с машиной в адресе — сразу форма входа на ней. */
export function AccountsColumn({ answers, machines, near, notes, say, cur, tabs, signIn }: Shared & { cur: string; tabs: ReactNode; signIn: boolean }) {
  const app = useApp();
  const state = useAccounts();
  const logins = app.use(() => state.logins());
  const [adding, setAdding] = useState(signIn);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const cards = cardsOf(answers);
  const answered = machines.every((m) => answers[m] !== undefined);

  return (
    <>
      <PageHead title={tabs ? undefined : "Аккаунты"}>
        {tabs}
        <Btn pri onClick={() => setAdding(true)}>
          + Новый аккаунт
        </Btn>
      </PageHead>
      {Object.entries(answers).map(([m, a]) =>
        wordOf(a) ? (
          <Note key={m} tone="bad" data-refused={`${m} · machine.accounts`}>
            {`${m} · machine.accounts: ${wordOf(a)}`}
          </Note>
        ) : null,
      )}
      {adding ? <NewAccount machines={machines} cur={cur} close={() => setAdding(false)} /> : null}
      {Object.entries(logins).map(([key, card]) => (
        <LoginCardView key={key} id={key} card={card} />
      ))}
      {Object.keys(notes)
        .filter((k) => k.startsWith("rm:"))
        .map((k) => (
          <Outcome key={k} note={notes[k]} data-note={k} />
        ))}
      {!cards.length && !answered ? <Note>Загружаю аккаунты машин…</Note> : null}
      {!cards.length && answered && !Object.values(answers).some(wordOf) ? <Note>Аккаунтов нет — «+ Новый аккаунт».</Note> : null}
      <div className="ac-cards">
        {cards.map((c) => (
          <AccountCard key={c.key} card={c} answers={answers} machines={machines} near={near} act={(d) => setDialog({ ...d, card: c.key })}>
            {dialog?.card === c.key && dialog.kind === "rm" ? <RemoveDialog answers={answers} machine={dialog.machine} name={dialog.name} say={say} close={() => setDialog(null)} /> : null}
            {dialog?.card === c.key && dialog.kind === "sess" ? <SessionsDialog answers={answers} machine={dialog.machine} slot={dialog.name} notes={notes} say={say} close={() => setDialog(null)} /> : null}
          </AccountCard>
        ))}
      </div>
    </>
  );
}

function AccountCard({ card, answers, machines, near, act, children }: { card: Card; answers: Answers; machines: string[]; near: string[]; act(d: Omit<Dialog, "card">): void; children: ReactNode }) {
  const app = useApp();
  const state = useAccounts();
  const [picking, setPicking] = useState(false);
  const sessions = app.use(() => (app.roster()?.sessions ?? []).filter((s) => card.lines.some((l) => s.account === l.name && s.callsign.endsWith(`@${l.machine}`))).length);
  const source = card.lines.find((l) => windowsOf(l.info).length);
  const src = source && windowsOf(source.info)[0][1].src;
  const free = machines.filter((m) => !card.lines.some((l) => l.machine === m));
  const name = card.lines[0].name;

  return (
    <Sec data-account={card.key}>
      <div className="ac-hd">
        <b>{card.email ?? name}</b>
        {card.plan ? <Pill tone="busy">{card.plan}</Pill> : null}
        <Hint>{`${sessions} ${plural(sessions, "сессия", "сессии", "сессий")}`}</Hint>
      </div>
      <Windows info={source?.info} />
      {source && src ? <Note>{`${SOURCES[src] ?? `от ${src}`} · ${machineLabel(app, source.machine).text}`}</Note> : null}
      {card.lines.map((l) => {
        const slots = Object.entries(okOf(answers[l.machine])?.slots ?? {});
        const holding = slots.filter(([, s]) => s.account === l.name).map(([n]) => n);
        const reserve = slots.filter(([, s]) => s.account !== l.name && s.order.includes(l.name)).map(([n]) => n);
        const places = [holding.length ? `${holding.length > 1 ? "в слотах" : "в слоте"} ${holding.join(", ")}` : "", reserve.length ? `запас ${reserve.join(", ")}` : ""].filter(Boolean);
        return (
          <div key={l.machine} className="ac-m" data-machine={l.machine}>
            <b>{machineLabel(app, l.machine).text}</b>
            <span>
              <Hint tone={l.info.login === "ok" ? "ok" : l.info.login === "pending" ? "wait" : "bad"}>{l.info.login === "ok" ? "вошёл" : l.info.login === "pending" ? "вход идёт" : "нет входа"}</Hint>
              {places.length ? " " : ""}
              {places.join(" · ")}
            </span>
            <OptsInline>
              {l.info.login === "none" ? <Btn onClick={() => void state.beginLogin(l.machine, l.name)}>Войти</Btn> : null}
              {holding.map((slot) => (
                <Btn key={slot} data-sess={slot} onClick={() => act({ kind: "sess", machine: l.machine, name: slot })}>
                  {`Сессии${holding.length > 1 ? ` ${slot}` : ""} (${slots.find(([n]) => n === slot)![1].sessions.length})…`}
                </Btn>
              ))}
              <Btn onClick={() => act({ kind: "rm", machine: l.machine, name: l.name })}>Удалить…</Btn>
            </OptsInline>
          </div>
        );
      })}
      {free.length ? (
        picking ? (
          <Opts data-any-pick={card.key}>
            {free.map((m) => (
              <Btn
                key={m}
                onClick={() => {
                  setPicking(false);
                  void state.beginLogin(m, name);
                }}
              >
                {near.includes(m) ? `${m} ★` : m}
              </Btn>
            ))}
            <Btn onClick={() => setPicking(false)}>Отмена</Btn>
          </Opts>
        ) : (
          <Btn dash data-any="" onClick={() => setPicking(true)}>
            ＋ войти на машине…
          </Btn>
        )
      ) : null}
      {children}
    </Sec>
  );
}

function NewAccount({ machines, cur, close }: { machines: string[]; cur: string; close(): void }) {
  const state = useAccounts();
  const [machine, setMachine] = useState(cur);
  const [name, setName] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <Sec dlg>
      <H4>Новый аккаунт</H4>
      <Row label="Машина">
        <Opts>
          {machines.map((m) => (
            <Btn key={m} aria-pressed={m === machine ? "true" : "false"} onClick={() => setMachine(m)}>
              {m}
            </Btn>
          ))}
        </Opts>
      </Row>
      <Row label="Имя на машине">
        <In mono data-f="account" placeholder="corp" value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </Row>
      {bad ? <Note tone="bad">имя — латиница, цифры, - и _</Note> : null}
      <Opts>
        <Btn onClick={close}>Отмена</Btn>
        <Btn
          pri
          onClick={() => {
            if (!NAME.test(name)) return setBad(true);
            close();
            void state.beginLogin(machine, name);
          }}
        >
          Войти
        </Btn>
      </Opts>
    </Sec>
  );
}
