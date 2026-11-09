// «Вам»: что ждёт человека. Вопросы отвечаются прямо в строке; законченное — итог и быстрый ответ; сбои — с тем, что на них стояло.
import { incidentList, message, sessionRead, sessionStart, type SessionRow } from "@sb/protocol";
import { ActionIcon, Badge, Button, Group, TextInput, Tooltip } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { IconCheck, IconSend } from "@tabler/icons-react";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { act, api } from "../api.ts";
import { Lamp } from "../common.tsx";
import { ago } from "../lib/time.ts";
import { AskCard } from "../session/Ask.tsx";
import { Conversation } from "../session/Conversation.tsx";
import { inboxOf, type InboxItem, machineOfCall, useFleet } from "../store/fleet.ts";

function QuickReply({ callsign }: { callsign: string }) {
  const [text, setText] = useState("");
  const send = async () => text.trim() && (await act(message, { to: callsign, text: text.trim() })) && setText("");
  return (
    <Group gap={6} wrap="nowrap" mt={6} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <TextInput size="xs" style={{ flex: 1 }} placeholder="Ответить" aria-label={`Ответить ${callsign}`} value={text} onChange={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
      <ActionIcon size="md" variant="default" aria-label="Отправить" disabled={!text.trim()} onClick={send}><IconSend size={14} /></ActionIcon>
      <Tooltip label="Прочитано (E)"><ActionIcon size="md" variant="default" aria-label="Прочитано" onClick={() => api.call(sessionRead, { to: callsign }).catch(() => {})}><IconCheck size={14} /></ActionIcon></Tooltip>
    </Group>
  );
}

function Item({ it, s, selected, onPick }: { it: InboxItem; s?: SessionRow; selected: boolean; onPick: () => void }) {
  const sessions = useFleet((f) => f.sessions);
  if (it.kind === "machine") {
    const stood = Object.values(sessions).filter((x) => machineOfCall(x.callsign) === it.machine);
    return (
      <div className="row" style={{ cursor: "default" }}>
        <span className="lamp off" />
        <div style={{ minWidth: 0 }}>
          <div className="t">Машина <span className="mono">{it.machine}</span> без связи</div>
          <Group gap={4} mt={4}>{stood.map((x) => <Badge key={x.callsign} variant="default" className="mono">{x.callsign}</Badge>)}</Group>
        </div>
        <span className="when">{ago(it.at)}</span>
      </div>
    );
  }
  if (!s) return null;
  return (
    <div className={`row${selected ? " sel" : ""}`} role="button" tabIndex={0} data-call={s.callsign} onClick={onPick} onKeyDown={(e) => e.key === "Enter" && onPick()}>
      <Lamp state={s.state} />
      <div style={{ minWidth: 0 }}>
        <div className="t trunc">{s.title ?? s.spec.name}</div>
        <div className="sub trunc mono">{s.callsign}</div>
        {it.kind === "ask" && s.ask && <AskCard callsign={s.callsign} ask={s.ask} inline />}
        {it.kind === "done" && <><div className="sub clamp2" style={{ marginTop: 3, color: "var(--mantine-color-text)" }}>{s.result ?? "Ход закончен"}</div><QuickReply callsign={s.callsign} /></>}
        {it.kind === "failed" && <><div className="sub clamp2" style={{ marginTop: 3, color: "var(--st-failed)" }}>{s.error ?? "сбой"}</div><Button mt={6} size="compact-xs" variant="default" onClick={(e) => (e.stopPropagation(), void act(sessionStart, { to: s.callsign }))}>Запустить заново</Button></>}
      </div>
      <span className="when">{ago(it.at)}</span>
    </div>
  );
}

export function Inbox() {
  const { callsign } = useParams();
  const go = useNavigate();
  const picture = useFleet();
  const inbox = useMemo(() => inboxOf(picture), [picture.sessions, picture.machines, picture.you]);
  const machines = Object.values(picture.machines).filter((m) => m.online).map((m) => m.name);
  const inc = useQueries({ queries: machines.map((m) => ({ queryKey: ["incident.list", m], queryFn: () => api.call(incidentList, { to: "@" + m }), retry: false })) });
  const incidents = inc.flatMap((q, i) => (q.data?.incidents ?? []).filter((x) => x.state === "pending").map((x) => ({ ...x, machine: machines[i] })));
  const order = [...inbox.asks, ...inbox.done, ...inbox.fails].filter((i) => i.callsign).map((i) => i.callsign!);
  const move = (d: number) => {
    const at = callsign ? order.indexOf(callsign) : -1;
    const next = order[Math.max(0, Math.min(order.length - 1, at + d))];
    if (next) go(`/inbox/${next}`);
  };
  useHotkeys([["j", () => move(1)], ["k", () => move(-1)], ["e", () => callsign && api.call(sessionRead, { to: callsign }).catch(() => {})]]);
  const empty = !inbox.asks.length && !inbox.done.length && !inbox.fails.length && !incidents.length;
  const group = (title: string, items: InboxItem[]) => items.length > 0 && (
    <>
      <div className="grp">{title}</div>
      {items.map((it) => <Item key={it.key} it={it} s={it.callsign ? picture.sessions[it.callsign] : undefined} selected={it.callsign === callsign} onPick={() => go(`/inbox/${it.callsign}`)} />)}
    </>
  );
  return (
    <div className={`panes${callsign ? " has-detail" : ""}`}>
      <section className="pane list" aria-label="Вам">
        <div className="pane-head"><h1>Вам</h1></div>
        <div className="scroll">
          {empty && <div className="hole" style={{ height: "60%" }}>Всё разобрано</div>}
          {group("Ждут ответа", inbox.asks)}
          {group("Закончили", inbox.done)}
          {group("Сбои", inbox.fails)}
          {incidents.length > 0 && <div className="grp">Обращения</div>}
          {incidents.map((x) => (
            <div key={x.id} className="row" style={{ cursor: "default" }}>
              <span className="lamp waiting" />
              <div style={{ minWidth: 0 }}><div className="t">{x.text}</div><div className="sub mono">{x.machine}</div></div>
              <span className="when">{ago(x.at)}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="pane detail">
        {callsign ? <Conversation callsign={callsign} onBack={() => go("/inbox")} /> : <div className="hole wide-only">Выберите строку слева</div>}
      </section>
    </div>
  );
}
