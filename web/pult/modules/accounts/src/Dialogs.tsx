// Диалоги аккаунтов: новый аккаунт, сессии слота, удаление.
import { nameOf } from "@switchboard/protocol";
import { useState } from "react";
import { Btn, Check, H4, In, Note, Opts, OptsLabel, Row, Sec, Sel, useApp } from "@switchboard/web-ui";
import { NoteLine } from "./parts.tsx";
import { useScreen } from "./screen.tsx";
import { slotsWith, type Slot, useAccounts } from "./store.ts";

const NAME = /^[A-Za-z0-9_-]+$/;
const HOST_PICKS = "следующего по порядку — выберет Host";

export function NewAccountDialog({ first }: { first: string }) {
  const app = useApp();
  const store = useAccounts();
  const screen = useScreen();
  const [machine, setMachine] = useState(first);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const machines = app.use(() => store.machines("machine.login"));
  function enter() {
    if (!NAME.test(name)) return setError("имя — латиница, цифры, - и _");
    screen.setDialog(null);
    void store.login(machine, name);
  }
  return (
    <Sec dlg>
      <H4>Новый аккаунт</H4>
      <Row label="Машина">
        <Opts>
          {machines.map((m) => (
            <Btn key={m} aria-pressed={machine === m ? "true" : "false"} onClick={() => setMachine(m)}>
              {m}
            </Btn>
          ))}
        </Opts>
      </Row>
      <Row label="Имя на машине">
        <In mono data-f="account" placeholder="corp" value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </Row>
      {error ? <Note tone="bad">{error}</Note> : null}
      <Opts>
        <Btn onClick={() => screen.setDialog(null)}>Отмена</Btn>
        <Btn pri onClick={enter}>
          Войти
        </Btn>
      </Opts>
    </Sec>
  );
}

export function SessionsDialog({ m, name, slot, targets }: { m: string; name: string; slot: Slot; targets: string[] }) {
  const screen = useScreen();
  const reserve = slot.order.filter((x) => x !== slot.account);
  const [next, setNext] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const account = reserve.includes(next) ? next : "";
  const target = chosen ?? targets[0] ?? "";
  return (
    <Sec dlg data-dlg="sess">
      <H4>{`Сессии слота ${name} на ${m} · сейчас ${slot.account ?? "—"}`}</H4>
      <b>Сменить аккаунт всему слоту</b>
      <Opts>
        <Sel data-f="swap" value={account} onChange={(e) => setNext(e.currentTarget.value)}>
          <option value="">{HOST_PICKS}</option>
          {reserve.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Sel>
        <Btn pri onClick={() => screen.swap(m, name, account)}>
          Сменить сейчас
        </Btn>
      </Opts>
      <NoteLine k={`swap:${m}:${name}`} />
      <b>Перевести выбранные в другой слот</b>
      <Opts>
        {slot.sessions.map((c) => (
          <OptsLabel key={c}>
            <Check
              value={c}
              checked={selected.includes(c)}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setSelected((old) => (on ? [...old, c] : old.filter((x) => x !== c)));
              }}
            />
            {c}
          </OptsLabel>
        ))}
        <Sel data-f="target" value={target} onChange={(e) => setChosen(e.currentTarget.value)}>
          {targets.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
          <option value="">без слота — вход машины</option>
        </Sel>
        <Btn onClick={() => screen.moveSessions(m, slot.sessions.filter((c) => selected.includes(c)), target)}>Перевести</Btn>
      </Opts>
      <NoteLine k={`move:${m}`} />
      <Opts>
        <Btn onClick={() => screen.setDialog(null)}>Закрыть</Btn>
      </Opts>
    </Sec>
  );
}

export function RemoveDialog({ m, account, slots }: { m: string; account: string; slots: Record<string, Slot> }) {
  const screen = useScreen();
  const [picked, setPicked] = useState("");
  const inSlots = slotsWith(slots, account);
  const many = inSlots.length > 1;
  const reserve = [...new Set(inSlots.flatMap((name) => slots[name].order.filter((x) => x !== account)))];
  const sessions = inSlots.flatMap((name) => slots[name].sessions.map(nameOf));
  const next = reserve.includes(picked) ? picked : "";
  return (
    <Sec dlg data-dlg="rm">
      <H4>{`Удалить ${account} с ${m}`}</H4>
      {inSlots.length ? (
        <>
          <div>
            <b>{`${account} сейчас ${many ? "в слотах" : "в слоте"} ${inSlots.join(", ")}`}</b>
            <Note>{`Сначала ${many ? "каждый слот сменит" : "слот сменит"} аккаунт — ${sessions.join(", ") || "сессии слота"} продолжат на новом, — потом ${account} уйдёт из порядка слотов и удалится.`}</Note>
          </div>
          <Row label={`Кого положить в ${many ? "слоты" : `слот ${inSlots[0]}`}`}>
            <Sel data-f="next" value={next} onChange={(e) => setPicked(e.currentTarget.value)}>
              <option value="">{HOST_PICKS}</option>
              {reserve.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Sel>
          </Row>
        </>
      ) : null}
      <Note>{`Стирается только папка ${account} на ${m}. Вход машины и другие аккаунты не трогаются.`}</Note>
      <Opts>
        <Btn onClick={() => screen.setDialog(null)}>Отмена</Btn>
        <Btn bad onClick={() => screen.remove(m, account, next)}>
          {inSlots.length ? "Сменить и удалить" : "Удалить"}
        </Btn>
      </Opts>
    </Sec>
  );
}
