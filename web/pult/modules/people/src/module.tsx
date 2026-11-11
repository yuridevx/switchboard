// pult-people: люди флота и их пропуска — единственное место пропусков в пульте; согласие на вход внешнего Claude (точка authorize OAuth).
// Только идентификация: прав нет, любой живой пропуск может всё. Человек — его почта: адрес ~ann@example.com, устройство pult~ann@example.com.
// Вид пропуска — форма адреса (kindOf протокола); владелец устройства — в адресе после ~, машины — поле owner.
// Данные — keys.list {passes: [{kid, addr, owner, wait}], you}; выдача — keys.invite {addr, owner?}; отзыв — keys.revoke; «на связи» —
// roster.clients и машины roster; отображаемые имена людей — fleet.labels.people с ключом-почтой. Отказ — словами. Одна форма за раз, Escape закрывает.
import { Users } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { kindOf, userOf } from "@switchboard/protocol";
import type { AppPart, ScreenProps } from "@switchboard/web-core";
import { Btn, Chip, Chips, Cmd, Confirm, CopyButton, Dot, In, M, machineLabel, Note, Opts, Page, PageHead, personal, Pill, Sec, useApp, useLoad, type App } from "@switchboard/web-ui";
import css from "./people.css";

/** Строка keys.list: owner — только у машины ("~почта"); wait — приглашение не принято. */
type Row = { kid: string; addr: string; owner: string | null; wait: boolean };
type List = { passes: Row[]; you: string };
type Names = { sessions?: Record<string, string>; machines?: Record<string, string>; people?: Record<string, string> };
type Made = { addr: string; invite: string; machine: boolean };

/** Человек — его почта: устройство — из адреса имя~почта, машина — из owner "~почта"; сессия ничья. */
const ownerOf = (r: Row): string | null => {
  const kind = kindOf(r.addr);
  const user = kind === "machine" ? r.owner : kind === "device" ? userOf(r.addr) : null;
  return user ? user.slice(1) : null;
};
/** Слова отказа gate и relay для людей; незнакомое — как есть. */
const WORDS: Record<string, string> = {
  name_taken: "у адреса уже есть живой пропуск — сначала отзовите прежний",
  unknown_key: "такого пропуска нет",
  bad_client: "клиент не назвал этот адрес возврата",
  bad_request: "адрес не того вида: латиница, цифры и дефис, почта после ~",
};
const said = (r: { ok: false; error: string }) => WORDS[r.error] ?? r.error;
const peopleOf = (rows: Row[]) => [...new Set(rows.flatMap((r) => (ownerOf(r) ? [ownerOf(r)!] : [])))].sort();
const meOf = (you: string | undefined) => (you ? (userOf(you)?.slice(1) ?? "") : "");
/** Имя устройства и машины. */
const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const EMAIL = /^[^~@\s]+@[^~@\s]+\.[^~@\s]+$/;

/** Склонение по числу: [один, два, пять]. */
const plural = (n: number, w: [string, string, string]) => (n % 10 === 1 && n % 100 !== 11 ? w[0] : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? w[1] : w[2]);

/** Одна открытая форма на экране: ключ формы или null; Escape закрывает. */
const Open = createContext<{ cur: string | null; set(k: string | null): void }>({ cur: null, set: () => {} });
function OpenOne({ children }: { children: ReactNode }) {
  const [cur, set] = useState<string | null>(null);
  useEffect(() => {
    if (!cur) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && set(null);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [cur]);
  return <Open.Provider value={{ cur, set }}>{children}</Open.Provider>;
}
const useOpen = (key: string) => {
  const o = useContext(Open);
  return [o.cur === key, (on: boolean) => o.set(on ? key : null)] as const;
};

function QR({ text }: { text: string }) {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  return <div className="pp-qr" data-qr={text} role="img" aria-label="QR ссылки для телефона" dangerouslySetInnerHTML={{ __html: code.createSvgTag({ scalable: true }) }} />;
}

/** Описание клиента OAuth по client_id: имя для людей и имя устройства по умолчанию. */
export const clientOf = (id: string) => (/claude-code/.test(id) ? { title: "Claude Code", device: "code" } : /claude\.ai/.test(id) ? { title: "claude.ai", device: "claude" } : { title: id, device: "client" });

/** Адрес возврата OAuth с параметрами: свой query адреса сохраняется. */
export function backTo(back: string, params: Record<string, string>): string {
  const u = new URL(back);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.href;
}

export const createPeople = ((app: App) => {
  const names = personal(app, "fleet", () => app.changed(), "global");
  const named = () => app.use(() => names.get<Names>("labels") ?? {});
  const rename = (key: string, text: string) =>
    names.edit<Names>("labels", (old) => {
      const { [key]: _o, ...rest } = old?.people ?? {};
      return { ...old, people: text.trim() ? { ...rest, [key]: text.trim() } : rest };
    });

  /** Имя человека: в списке — ссылка на карточку; в карточке — заголовок с «Назвать…». */
  function Title({ id, link }: { id: string; link: boolean }) {
    const n = named();
    const [open, setOpen] = useOpen(`rename-${id}`);
    const [edit, setEdit] = useState("");
    const text = n.people?.[id];
    if (open)
      return (
        <form
          className="pp-title"
          onSubmit={(e) => {
            e.preventDefault();
            rename(id, edit);
            setOpen(false);
          }}
        >
          <In data-f={`title-${id}`} aria-label="Имя" placeholder="имя" value={edit} autoFocus onInput={(e) => setEdit(e.currentTarget.value)} />
          <Btn pri type="submit">
            Сохранить
          </Btn>
          <Btn onClick={() => setOpen(false)}>Отмена</Btn>
        </form>
      );
    return (
      <span className="pp-title">
        {link && (
          <Btn ghost className="pp-name" data-goto={id} onClick={() => app.open("people", { who: id })}>
            {text ?? id}
          </Btn>
        )}
        {text && <M>{id}</M>}
        {!link && (
          <Btn
            ghost
            data-act={`rename-${id}`}
            onClick={() => {
              setEdit(text ?? "");
              setOpen(true);
            }}
          >
            Назвать…
          </Btn>
        )}
      </span>
    );
  }

  function Link({ title, url }: { title: string; url: string }) {
    return (
      <Opts data-link={title}>
        <b className="pp-ltitle">{title}</b>
        <Cmd className="pp-link">{url}</Cmd>
        <CopyButton text={url} label="Копировать" />
      </Opts>
    );
  }

  /** Одна выдача на все случаи: устройству — ссылки на пульт и телефон с QR и код для программы или CLI; машине — код для keeper install. */
  function Invited({ made, done }: { made: Made; done(): void }) {
    const worker = app.worker("phone");
    const phone = worker && `${worker.replace(/\/$/, "")}/#invite=${made.invite}`;
    return (
      <Sec tone="ok" data-invited={made.addr}>
        <span>
          {"Приглашение "}
          <M>{made.addr}</M>
        </span>
        <div className="pp-inv">
          <div className="pp-invl">
            {!made.machine && <Link title="Пульт" url={`${location.origin}${location.pathname}#invite=${made.invite}`} />}
            {!made.machine && phone && <Link title="Телефон" url={phone} />}
            <Link title="Код" url={made.invite} />
          </div>
          {!made.machine && phone && <QR text={phone} />}
        </div>
        <Opts>
          <Btn onClick={done}>Готово</Btn>
        </Opts>
      </Sec>
    );
  }

  function PassRow({ row, you, online, reload, say }: { row: Row; you: string; online: boolean; reload(): void; say(t: string): void }) {
    const [asking, setAsking] = useOpen(`revoke-${row.kid}`);
    const self = row.addr === you;
    async function revoke() {
      setAsking(false);
      say("");
      const r = await app.request("keys.revoke", { kid: row.kid });
      if (!r.ok) return say(`${row.addr}: ${said(r)}`);
      app.toast(`${row.addr} отозван`, "ok");
      reload();
    }
    return (
      <div className="pp-pass" data-pass={row.addr}>
        <span className="pp-addr">
          <Dot kind={online ? "idle" : "stop"} title={online ? "на связи" : "не на связи"} />
          <M>{kindOf(row.addr) === "machine" ? machineLabel(app, row.addr.slice(1)).text : row.addr}</M>
          {self && <Pill tone="ok">это устройство</Pill>}
          {row.wait && <Pill tone="wait">ждёт входа</Pill>}
        </span>
        <span className="pp-act">
          {!asking && (
            <Btn ghost data-act={`revoke-${row.kid}`} onClick={() => setAsking(true)}>
              Отозвать…
            </Btn>
          )}
        </span>
        {asking && (
          <div className="pp-confirm">
            <Confirm text={self ? `Отозвать ${row.addr}? Это устройство выйдет из флота.` : `Отозвать ${row.addr}?`} act="Отозвать" run={() => void revoke()} cancel={() => setAsking(false)} />
          </div>
        )}
      </div>
    );
  }

  /** Приглашение в карточке: устройство или машина этого человека. */
  function InviteHere({ p, done }: { p: string; done(r: Made): void }) {
    const [open, setOpen] = useOpen(`invite-${p}`);
    const [machine, setMachine] = useState(false);
    const [name, setName] = useState("");
    const [word, setWord] = useState("");
    async function invite() {
      const n = name.trim();
      const body = machine ? { addr: `@${n}`, owner: `~${p}` } : { addr: `${n}~${p}` };
      const r = await app.request<{ kid: string; addr: string; invite: string }>("keys.invite", body);
      if (!r.ok) return setWord(said(r));
      setOpen(false);
      setName("");
      setWord("");
      done({ ...r.result, machine });
    }
    if (!open)
      return (
        <Btn data-act={`invite-${p}`} onClick={() => setOpen(true)}>
          ＋ пригласить
        </Btn>
      );
    return (
      <Sec data-invite={p} className="pp-form">
        <Opts>
          <Chips>
            <Chip on={!machine} onClick={() => setMachine(false)}>
              устройство
            </Chip>
            <Chip on={machine} onClick={() => setMachine(true)}>
              машина
            </Chip>
          </Chips>
          <In mono data-f="name" aria-label="Имя" placeholder={machine ? "laptop" : "pult"} value={name} autoFocus onInput={(e) => setName(e.currentTarget.value.toLowerCase())} />
        </Opts>
        {word && (
          <Note tone="bad" role="alert">
            {word}
          </Note>
        )}
        <Opts>
          <Btn pri disabled={!NAME.test(name.trim())} onClick={() => void invite()}>
            Пригласить
          </Btn>
          <Btn onClick={() => setOpen(false)}>Отмена</Btn>
        </Opts>
      </Sec>
    );
  }

  /** Новый человек: почта и его первое устройство. */
  function InvitePerson({ taken, done }: { taken: string[]; done(r: Made): void }) {
    const [open, setOpen] = useOpen("invite-person");
    const [who, setWho] = useState("");
    const [device, setDevice] = useState("");
    const [word, setWord] = useState("");
    const w = who.trim();
    const busy = taken.includes(w);
    async function invite() {
      const r = await app.request<{ kid: string; addr: string; invite: string }>("keys.invite", { addr: `${device.trim() || "pult"}~${w}` });
      if (!r.ok) return setWord(said(r));
      setOpen(false);
      setWho("");
      setDevice("");
      done({ ...r.result, machine: false });
    }
    if (!open)
      return (
        <Opts>
          <Btn pri data-act="invite-person" onClick={() => setOpen(true)}>
            Пригласить человека
          </Btn>
        </Opts>
      );
    return (
      <Sec data-invite="" className="pp-form">
        <Opts>
          <In mono type="email" data-f="who" aria-label="Почта" placeholder="почта" value={who} autoFocus onInput={(e) => setWho(e.currentTarget.value.replace(/^~/, "").trim().toLowerCase())} />
          <In mono data-f="device" aria-label="Устройство" placeholder="pult" value={device} onInput={(e) => setDevice(e.currentTarget.value.toLowerCase())} />
        </Opts>
        {busy && <Note tone="wait">{`${w} уже во флоте`}</Note>}
        {word && (
          <Note tone="bad" role="alert">
            {word}
          </Note>
        )}
        <Opts>
          <Btn pri disabled={!EMAIL.test(w) || busy || (!!device.trim() && !NAME.test(device.trim()))} onClick={() => void invite()}>
            Пригласить
          </Btn>
          <Btn onClick={() => setOpen(false)}>Отмена</Btn>
        </Opts>
      </Sec>
    );
  }

  /** Человек: устройства и машины; в карточке — приглашение и удаление (отзыв устройств, машины остаются). */
  function Person({ p, rows, you, card, reload }: { p: string; rows: Row[]; you: string; card: boolean; reload(): void }) {
    const roster = app.use(() => app.roster());
    const clients = new Set(roster?.clients ?? []);
    const machinesOn = new Set((roster?.machines ?? []).map((m) => `@${m.machine}`));
    const [made, setMade] = useState<Made | null>(null);
    const [word, setWord] = useState("");
    const [asking, setAsking] = useOpen(`remove-${p}`);
    const own = rows.filter((r) => ownerOf(r) === p);
    const devices = own.filter((r) => kindOf(r.addr) === "device");
    const machines = own.filter((r) => kindOf(r.addr) === "machine");
    const me = p === meOf(you);
    async function remove() {
      setAsking(false);
      for (const r of devices) {
        const x = await app.request("keys.revoke", { kid: r.kid });
        if (!x.ok) return setWord(said(x));
      }
      app.toast(`${p} удалён из флота`, "ok");
      app.open("people");
    }
    const group = (label: string, list: Row[], on: Set<string>) =>
      list.length
        ? [
            <b key={`${label}-l`} className="pp-lbl">
              {label}
            </b>,
            <div key={label} className="pp-members">
              {list.map((r) => (
                <PassRow key={r.kid} row={r} you={you} online={on.has(r.addr)} reload={reload} say={setWord} />
              ))}
            </div>,
          ]
        : [];
    const kept = machines.map((r) => r.addr).join(", ");
    return (
      <Sec data-person={p}>
        <div className="pp-head">
          <Title id={p} link={!card} />
          {me && <Pill tone="ok">вы</Pill>}
        </div>
        <div className="pp-grid">
          {group("Устройства", devices, clients)}
          {group("Машины", machines, machinesOn)}
        </div>
        {made && <Invited made={made} done={() => setMade(null)} />}
        {word && (
          <Note tone="bad" role="alert">
            {word}
          </Note>
        )}
        {card && (
          <Opts>
            <InviteHere p={p} done={(r) => (setMade(r), reload())} />
            {!me && !asking && (
              <Btn bad data-act={`remove-${p}`} onClick={() => setAsking(true)}>
                Удалить из флота…
              </Btn>
            )}
          </Opts>
        )}
        {asking && (
          <div className="pp-confirm">
            <Confirm
              text={`Удалить ${p}: отозвать ${devices.length} ${plural(devices.length, ["устройство", "устройства", "устройств"])}?${kept ? ` Машины ${kept} остаются.` : ""}`}
              act="Удалить"
              run={() => void remove()}
              cancel={() => setAsking(false)}
            />
          </div>
        )}
      </Sec>
    );
  }

  /** «Люди»: все люди флота; с параметром who — карточка одного с возвратом к списку. */
  function PeopleScreen({ params }: ScreenProps) {
    const list = useLoad(() => app.read<List>("keys.list"), []);
    const [made, setMade] = useState<Made | null>(null);
    const rows = list.data?.passes ?? [];
    const you = list.data?.you ?? "";
    const me = meOf(you);
    const all = peopleOf(rows).sort((a, b) => (a === me ? -1 : b === me ? 1 : a.localeCompare(b)));
    const who = params.who;
    const n = named();
    return (
      <Page>
        {who ? (
          <PageHead title={n.people?.[who] ?? who}>
            <Btn data-act="back" onClick={() => app.open("people")}>
              ← Люди
            </Btn>
          </PageHead>
        ) : (
          <PageHead title="Люди" />
        )}
        <OpenOne>
          {list.error && <Note tone="bad">{`Список не загрузился: ${list.error}`}</Note>}
          {!list.data && !list.error && <Note>…</Note>}
          {list.data && !who && <InvitePerson taken={all} done={(r) => (setMade(r), list.reload())} />}
          {made && <Invited made={made} done={() => setMade(null)} />}
          {list.data && who && !all.includes(who) && <Note>{`${who} во флоте нет`}</Note>}
          {(who ? all.filter((p) => p === who) : all).map((p) => (
            <Person key={p} p={p} rows={rows} you={you} card={!!who} reload={list.reload} />
          ))}
        </OpenOne>
      </Page>
    );
  }

  /** Точка authorize: client_id, redirect_uri, state, code_challenge — из адреса. «Разрешить» — отзыв прежнего пропуска с этим адресом, keys.invite с challenge, возврат в клиент с кодом. */
  function ConsentScreen({ params }: ScreenProps) {
    const list = useLoad(() => app.read<List>("keys.list"), []);
    const client = clientOf(params.client_id ?? "");
    const [name, setName] = useState(client.device);
    const [busy, setBusy] = useState(false);
    const [word, setWord] = useState("");
    const me = meOf(list.data?.you);
    const addr = `${name.trim()}~${me}`;
    const was = list.data?.passes.find((r) => r.addr === addr);
    const asked = !!(params.client_id && params.redirect_uri && params.code_challenge);
    const leave = (to: string) => location.assign(to);
    async function allow() {
      setBusy(true);
      setWord("");
      if (was) {
        const x = await app.request("keys.revoke", { kid: was.kid });
        if (!x.ok) return setBusy(false), setWord(said(x));
      }
      const r = await app.request<{ kid: string; addr: string; invite: string }>("keys.invite", { addr, challenge: params.code_challenge, client: params.client_id, back: params.redirect_uri });
      if (!r.ok) return setBusy(false), setWord(said(r));
      leave(backTo(params.redirect_uri!, { code: r.result.invite, ...(params.state ? { state: params.state } : {}) }));
    }
    return (
      <Page>
        <PageHead title="Доступ к флоту" />
        {!asked && <Note>Запроса нет.</Note>}
        {list.error && <Note tone="bad">{`Список не загрузился: ${list.error}`}</Note>}
        {asked && list.data && (
          <Sec data-consent={client.device}>
            <div className="pp-consent">
              <b>{client.title}</b>
              <span>просит вход во флот как</span>
              <In mono data-f="device" aria-label="Имя устройства" className="pp-dname" value={name} onInput={(e) => setName(e.currentTarget.value.toLowerCase())} />
              <M>{`~${me}`}</M>
              {was && <Pill tone="wait">заменит прежний</Pill>}
            </div>
            <span>получит те же возможности, что ваши устройства</span>
            {word && (
              <Note tone="bad" role="alert">
                {word}
              </Note>
            )}
            <Opts>
              <Btn pri data-act="allow" disabled={busy || !NAME.test(name.trim())} onClick={() => void allow()}>
                Разрешить
              </Btn>
              <Btn data-act="deny" disabled={busy} onClick={() => leave(backTo(params.redirect_uri!, { error: "access_denied", ...(params.state ? { state: params.state } : {}) }))}>
                Отказать
              </Btn>
            </Opts>
          </Sec>
        )}
      </Page>
    );
  }

  return {
    css,
    on: { link: names.onLink },
    stop: names.stop,
    screens: {
      people: { nav: "Люди", icon: Users, group: "Флот", label: "Люди", view: PeopleScreen, head: (p) => ({ title: p.who ? (names.get<Names>("labels")?.people?.[p.who] ?? p.who) : "Люди" }) },
      consent: { label: "Доступ к флоту", view: ConsentScreen, head: () => ({ title: "Доступ к флоту" }) },
    },
  };
}) satisfies AppPart["module"];
