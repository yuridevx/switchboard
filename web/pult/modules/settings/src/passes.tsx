// «Пропуска»: машины и клиенты флота, приглашение и отзыв.
import { useState } from "react";
import qrcode from "qrcode-generator";
import { Btn, Chips, Cmd, CopyButton, day, In, M, Note, Opts, Pill, Sec, useApp, useLoad, useModule } from "@switchboard/web-ui";
import { isMine, wordFor } from "./rules.ts";
import type { Invited, SettingsState } from "./state.ts";

type Pass = { id: string; role: string; name: string; person: string | null; addr: string; state: string; by: string; at: number };
type Kind = Invited["kind"];

const KINDS: Array<[Kind, string]> = [["device", "устройство"], ["program", "программа"], ["host", "машина"]];

function QR({ text }: { text: string }) {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return <div className="st-qr" data-qr={text} role="img" aria-label="QR ссылки для телефона" dangerouslySetInnerHTML={{ __html: code.createSvgTag({ scalable: true }) }} />;
}

function Link({ title, url }: { title: string; url: string }) {
  return (
    <Opts data-link={title}>
      {title && <b className="st-lbl">{title}</b>}
      <Cmd className="st-link">{url}</Cmd>
      <CopyButton text={url} label="Копировать" />
    </Opts>
  );
}

function InvitedBox({ invited, done }: { invited: Invited; done(): void }) {
  const app = useApp();
  const { kind, addr, invite } = invited;
  const worker = app.worker("phone");
  const phone = worker && `${worker.replace(/\/$/, "")}/`;
  return (
    <Sec tone="ok" data-invited="">
      <span>
        {kind === "device" ? "Ссылка для " : kind === "program" ? "Приглашение для " : "Приглашение машины "}
        <M>{addr}</M>
      </span>
      {kind === "device" ? (
        <div className="st-inv">
          <div className="st-invl">
            <Link title="Пульт" url={`${location.origin}${location.pathname}#invite=${invite}`} />
            {phone && <Link title="Телефон" url={`${phone}#invite=${invite}`} />}
          </div>
          {phone && <QR text={`${phone}#invite=${invite}`} />}
        </div>
      ) : (
        <Link title="" url={invite} />
      )}
      <Opts>
        <Btn onClick={done}>Готово</Btn>
      </Opts>
    </Sec>
  );
}

function InviteForm({ done, reload }: { done(): void; reload(): void }) {
  const app = useApp();
  const s = useModule<SettingsState>();
  const [kind, setKind] = useState<Kind>("device");
  const [name, setName] = useState("");
  const [person, setPerson] = useState("");
  const [word, setWord] = useState("");
  async function invite() {
    const body = kind === "host" ? { role: "host", name } : { role: "client", name, person };
    const r = await app.request<{ invite: string; addr: string }>("keys.invite", body);
    if (!r.ok) return setWord(wordFor(r.error));
    s.local.set((l) => void (l.invited = { kind, addr: r.result.addr, invite: r.result.invite }));
    done();
    reload();
  }
  return (
    <Sec data-invite="">
      <Chips>
        {KINDS.map(([k, label]) => (
          <Btn key={k} aria-pressed={k === kind} onClick={() => setKind(k)}>
            {label}
          </Btn>
        ))}
      </Chips>
      <In data-f="iname" aria-label="Имя" placeholder={kind === "host" ? "имя машины" : "laptop"} value={name} onInput={(e) => setName(e.currentTarget.value)} />
      {kind !== "host" && <In data-f="iwho" aria-label="Почта" placeholder="почта" value={person} onInput={(e) => setPerson(e.currentTarget.value)} />}
      {word && (
        <Note tone="bad" role="alert">
          {word}
        </Note>
      )}
      <Opts>
        <Btn pri onClick={() => void invite()}>
          Пригласить
        </Btn>
        <Btn onClick={done}>Отмена</Btn>
      </Opts>
    </Sec>
  );
}

function PassRow({ pass, me, reload, say }: { pass: Pass; me: boolean; reload(): void; say(text: string): void }) {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  async function revoke() {
    setAsking(false);
    say("");
    const r = await app.request("keys.revoke", { kid: pass.id });
    if (!r.ok) return say(`${pass.addr}: ${wordFor(r.error)}`);
    app.toast(`${pass.addr} отозван — соединения закрыты`, "ok");
    reload();
  }
  return (
    <tr data-pass={pass.id}>
      <td>
        <M>{pass.addr}</M>
      </td>
      <td>{pass.state === "ok" ? <Pill tone="ok">действует</Pill> : <Pill tone="wait">ждёт приёма</Pill>}</td>
      <td>
        <M>{pass.by}</M>
      </td>
      <td>{day(pass.at)}</td>
      <td>
        {me && <Note>это устройство</Note>}
        {!me && !asking && <Btn bad onClick={() => setAsking(true)}>Отозвать…</Btn>}
        {asking && (
          <Opts className="st-nowrap">
            <Btn bad onClick={() => void revoke()}>
              Отозвать
            </Btn>
            <Btn onClick={() => setAsking(false)}>Отмена</Btn>
          </Opts>
        )}
      </td>
    </tr>
  );
}

function Table({ title, list, reload, say }: { title: string; list: Pass[]; reload(): void; say(text: string): void }) {
  const app = useApp();
  const me = app.use(() => app.address());
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
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <PassRow key={p.id} pass={p} me={isMine({ address: () => me, name: app.name }, p)} reload={reload} say={say} />
          ))}
        </tbody>
      </table>
    </Sec>
  );
}

export function PassesTab() {
  const app = useApp();
  const s = useModule<SettingsState>();
  const passes = useLoad(() => app.read<{ passes: Pass[] }>("keys.list"), []);
  const invited = app.use(() => s.local.get().invited);
  const [form, setForm] = useState(false);
  const [word, setWord] = useState("");
  const list = passes.data?.passes ?? [];
  return (
    <>
      {!form && !invited && (
        <Opts>
          <Btn pri onClick={() => setForm(true)}>
            Пригласить
          </Btn>
        </Opts>
      )}
      {form && <InviteForm done={() => setForm(false)} reload={passes.reload} />}
      {invited && <InvitedBox invited={invited} done={() => s.local.set((l) => void (l.invited = null))} />}
      {passes.error && <Note tone="bad">{`keys.list: ${passes.error}`}</Note>}
      {word && (
        <Note tone="bad" role="alert">
          {word}
        </Note>
      )}
      {passes.data && <Table title="Машины" list={list.filter((p) => p.role === "host")} reload={passes.reload} say={setWord} />}
      {passes.data && <Table title="Устройства и программы" list={list.filter((p) => p.role !== "host")} reload={passes.reload} say={setWord} />}
      {!passes.data && !passes.error && <Note>…</Note>}
    </>
  );
}
