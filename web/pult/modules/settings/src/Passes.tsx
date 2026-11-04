// Вкладка «Пропуска»: машины и устройства, приглашение и отзыв. Это устройство не отзывается.
import { useState } from "react";
import { Btn, M, Note, Opts, Outcome, Pill, type Result, Sec, useApp, useOutcome } from "@switchboard/web-ui";
import { thisDevice, usePasses } from "./load.ts";
import { useSettings } from "./store.ts";
import { Invited, InviteForm } from "./Invite.tsx";
import type { Pass } from "./store.ts";

const WORD = { ok: ["действует", "ok"], wait: ["ждёт приёма", "wait"] } as const;

function PassRow({ p, mine, done }: { p: Pass; mine: boolean; done(r: Result<string>): void }) {
  const settings = useSettings();
  const [asking, setAsking] = useState(false);
  return (
    <tr data-pass={p.id}>
      <td>
        <M>{p.addr}</M>
      </td>
      <td>
        <Pill tone={WORD[p.state][1]}>{WORD[p.state][0]}</Pill>
      </td>
      <td>
        <M>{p.by}</M>
      </td>
      <td>{new Date(p.at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</td>
      <td>
        {mine ? (
          <Note>это устройство</Note>
        ) : asking ? (
          <Opts>
            <Btn
              bad
              onClick={() =>
                void settings.revoke(p).then((r) => {
                  setAsking(false);
                  done(r);
                })
              }
            >
              Отозвать
            </Btn>
            <Btn onClick={() => setAsking(false)}>Отмена</Btn>
          </Opts>
        ) : (
          <Btn bad onClick={() => setAsking(true)}>
            Отозвать…
          </Btn>
        )}
      </td>
    </tr>
  );
}

function PassTable({ title, rows, me, done }: { title: string; rows: Pass[]; me: Pass | undefined; done(r: Result<string>): void }) {
  if (!rows.length) return null;
  return (
    <Sec data-passes={title}>
      <b>{title}</b>
      <table className="st-tbl">
        <colgroup>
          <col className="st-w28" />
          <col className="st-w16" />
          <col className="st-w22" />
          <col className="st-w14" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>адрес</th>
            <th>состояние</th>
            <th>кто пригласил</th>
            <th>когда</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <PassRow key={p.id} p={p} mine={p.id === me?.id} done={done} />
          ))}
        </tbody>
      </table>
    </Sec>
  );
}

export function Passes() {
  const app = useApp();
  const settings = useSettings();
  const { data: ps = [], error, loading, reload } = usePasses();
  const [inviting, setInviting] = useState(false);
  const invited = app.use(() => settings.get().invited);
  const [notes, say] = useOutcome();
  const done = (r: Result<string>) => {
    if (!r.ok) return say("revoke", r.error, "bad");
    app.toast(r.result, "ok");
    reload();
  };
  const me = thisDevice(ps, app.name);
  return (
    <>
      <Opts>
        {inviting || invited ? null : (
          <Btn pri onClick={() => setInviting(true)}>
            Пригласить
          </Btn>
        )}
      </Opts>
      {inviting ? <InviteForm close={() => setInviting(false)} invited={reload} /> : invited ? <Invited x={invited} /> : null}
      {error ? <Note tone="bad" role="alert">{`keys.list: ${error}`}</Note> : !ps.length && loading ? <Note>…</Note> : null}
      <PassTable title="Машины" rows={ps.filter((p) => p.role === "host")} me={me} done={done} />
      <PassTable title="Устройства и программы" rows={ps.filter((p) => p.role === "client")} me={me} done={done} />
      <Outcome note={notes.revoke} />
    </>
  );
}
