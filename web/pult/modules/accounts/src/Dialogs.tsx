// Диалоги аккаунтов: новый аккаунт, сессии слота, удаление.
import { nameOf } from "@switchboard/protocol";
import { useState } from "react";
import { Btn, Check, H4, In, Note, Opts, OptsLabel, Row, Sec, Sel, useApp } from "@switchboard/web-ui";
import { useScreen } from "./context.ts";
import { useAccounts } from "./store.ts";
import { NoteLine } from "./parts.tsx";
import { slotsWith, type Slot } from "./store.ts";

const NAME = /^[A-Za-z0-9_-]+$/;

export function NewDlg({ first }: { first: string }) {
  const app = useApp();
  const store = useAccounts();
  const sc = useScreen();
  const [machine, setMachine] = useState(first);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const ms = app.use(() => store.machines("machine.login"));
  const enter = () => {
    if (!NAME.test(name)) return setErr("имя — латиница, цифры, - и _");
    sc.setDlg(null);
    void store.login(machine, name);
  };
  return (
    <Sec dlg>
      <H4>Новый аккаунт</H4>
      <Row label="Машина">
        <Opts>
          {ms.map((m) => (
            <Btn key={m} aria-pressed={machine === m ? "true" : "false"} onClick={() => setMachine(m)}>
              {m}
            </Btn>
          ))}
        </Opts>
      </Row>
      <Row label="Имя на машине">
        <In mono data-f="account" placeholder="corp" value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </Row>
      {err ? <Note tone="bad">{err}</Note> : null}
      <Opts>
        <Btn onClick={() => sc.setDlg(null)}>Отмена</Btn>
        <Btn pri onClick={enter}>
          Войти
        </Btn>
      </Opts>
    </Sec>
  );
}

export function SessDlg({ m, slot, s, targets }: { m: string; slot: string; s: Slot; targets: string[] }) {
  const sc = useScreen();
  const other = s.order.filter((x) => x !== s.account);
  const [account, setAccount] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const target = chosen ?? targets[0] ?? "";
  return (
    <Sec dlg data-dlg="sess">
      <H4>{`Сессии слота ${slot} на ${m} · сейчас ${s.account ?? "—"}`}</H4>
      <b>Сменить аккаунт всему слоту</b>
      <Opts>
        <Sel data-f="swap" value={other.includes(account) ? account : ""} onChange={(e) => setAccount(e.currentTarget.value)}>
          <option value="">следующего по порядку — выберет Host</option>
          {other.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </Sel>
        <Btn pri onClick={() => sc.swap(m, slot, other.includes(account) ? account : "")}>
          Сменить сейчас
        </Btn>
      </Opts>
      <NoteLine k={`swap:${m}:${slot}`} />
      <b>Перевести выбранные в другой слот</b>
      <Opts>
        {s.sessions.map((c) => (
          <OptsLabel key={c}>
            <Check
              value={c}
              checked={checked.includes(c)}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setChecked((old) => (on ? [...old, c] : old.filter((x) => x !== c)));
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
        <Btn onClick={() => sc.moveSessions(m, s.sessions.filter((c) => checked.includes(c)), target)}>Перевести</Btn>
      </Opts>
      <NoteLine k={`move:${m}`} />
      <Opts>
        <Btn onClick={() => sc.setDlg(null)}>Закрыть</Btn>
      </Opts>
    </Sec>
  );
}

export function RmDlg({ m, account, list }: { m: string; account: string; list: Record<string, Slot> }) {
  const sc = useScreen();
  const [next, setNext] = useState("");
  const inSlots = slotsWith(list, account);
  const others = [...new Set(inSlots.flatMap((sl) => list[sl].order.filter((x) => x !== account)))];
  const sess = inSlots.flatMap((sl) => list[sl].sessions.map(nameOf));
  return (
    <Sec dlg data-dlg="rm">
      <H4>{`Удалить ${account} с ${m}`}</H4>
      {inSlots.length ? (
        <div>
          <b>{`${account} сейчас ${inSlots.length > 1 ? "в слотах" : "в слоте"} ${inSlots.join(", ")}`}</b>
          <Note>{`Сначала ${inSlots.length > 1 ? "каждый слот сменит" : "слот сменит"} аккаунт — ${sess.join(", ") || "сессии слота"} продолжат на новом, — потом ${account} уйдёт из порядка слотов и удалится.`}</Note>
        </div>
      ) : null}
      {inSlots.length ? (
        <Row label={`Кого положить в ${inSlots.length > 1 ? "слоты" : `слот ${inSlots[0]}`}`}>
          <Sel data-f="next" value={others.includes(next) ? next : ""} onChange={(e) => setNext(e.currentTarget.value)}>
            <option value="">следующего по порядку — выберет Host</option>
            {others.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Sel>
        </Row>
      ) : null}
      <Note>{`Стирается только папка ${account} на ${m}. Вход машины и другие аккаунты не трогаются.`}</Note>
      <Opts>
        <Btn onClick={() => sc.setDlg(null)}>Отмена</Btn>
        <Btn bad onClick={() => sc.remove(m, account, others.includes(next) ? next : "")}>
          {inSlots.length ? "Сменить и удалить" : "Удалить"}
        </Btn>
      </Opts>
    </Sec>
  );
}
