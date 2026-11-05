// web-inbox — «Вам»: карточки выводятся из roster и меток, своей очереди нет. Здесь помнится только то, чего там нет: «готово» и чьи сессии были на ушедшей машине.
import { machineOf } from "@switchboard/protocol";
import type { Roster } from "@switchboard/relay";
import { at, createStore, failText, isLive, lamp, machineLabel, sessionLabel, sessionOf, slotOf, type App } from "@switchboard/web-ui";
import type { AppModule } from "@switchboard/web-core";
import css from "./inbox.css";
import { InboxScreen } from "./screen.tsx";

export type Card = { kind: "q" | "msg" | "fail" | "wait" | "done" | "away" | "fire"; callsign?: string; machine?: string; name: string; dot: string; label: string; text: string };

export type InboxState = ReturnType<typeof createInboxState>;

function createInboxState(app: App) {
  /** done — закончили, пока их не смотрели; known — мои сессии, какими их видели на связи */
  const s = createStore({ done: [] as string[], known: [] as string[] }, app.changed);
  let states = new Map<string, unknown>();

  const mine = (cs: string) => !!app.mark("mine", cs);
  const viewing = () => app.current()?.params.callsign;
  const clearDone = (cs: string) => s.set((d) => void (d.done = d.done.filter((x) => x !== cs)));

  function onRoster(r: Roster) {
    const was = states;
    states = new Map(r.sessions.map((x) => [x.callsign, x.state]));
    const online = new Set(r.machines.map((m) => m.machine));
    s.set((d) => {
      for (const x of r.sessions) {
        if (x.state === "busy") d.done = d.done.filter((c) => c !== x.callsign);
        if (x.state === "idle" && was.get(x.callsign) === "busy" && viewing() !== x.callsign && mine(x.callsign) && !d.done.includes(x.callsign)) d.done.push(x.callsign);
      }
      // сессии машины на связи — из roster; ушедшей — как были
      d.known = [...d.known.filter((c) => !online.has(machineOf(c) ?? "")), ...r.sessions.filter((x) => mine(x.callsign)).map((x) => x.callsign)].filter((c, i, all) => all.indexOf(c) === i);
    });
  }

  function cards(): Card[] {
    const out: Card[] = [];
    const sessions = app.roster()?.sessions ?? [];
    const place = (cs: string) => (app.mark("project.of", cs) as { name: string } | null | undefined)?.name;
    const label = (word: string, cs: string) => [word, place(cs)].filter(Boolean).join(" · ");
    const name = (cs: string) => sessionLabel(app, cs).text;
    for (const x of sessions) {
      const cs = x.callsign;
      const unread = app.mark("unread", cs) as { count: number; text: string } | undefined;
      if (app.mark("asked", cs)) out.push({ kind: "q", callsign: cs, name: name(cs), dot: "wait", label: label("спрашивает", cs), text: "" });
      else if (unread?.count) out.push({ kind: "msg", callsign: cs, name: name(cs), dot: "wait", label: label("пишет вам", cs), text: unread.text });
    }
    for (const x of sessions) {
      const cs = x.callsign;
      if (!mine(cs)) continue;
      const wait = slotOf(x)?.wait;
      if (x.state === "failed") out.push({ kind: "fail", callsign: cs, name: name(cs), dot: "bad", label: label("не запустилась", cs), text: failText(x) });
      else if (wait) out.push({ kind: "wait", callsign: cs, name: name(cs), dot: "idle", label: label("ждёт сброса лимита", cs), text: `Аккаунты слота ${slotOf(x)?.name} у порога — продолжит после ${at(wait)}` });
    }
    const gone = (app.mark("machines.gone") as Record<string, number> | undefined) ?? {};
    for (const [m, when] of Object.entries(gone)) {
      const mineThere = s.get().known.filter((c) => machineOf(c) === m);
      if (mineThere.length) out.push({ kind: "away", machine: m, name: machineLabel(app, m).text, dot: "gone", label: `не на связи с ${at(when)}`, text: mineThere.join(", ") });
    }
    const fire = ((app.mark("fire") as string[] | undefined) ?? []).filter((m) => !(m in gone));
    if (fire.length) out.push({ kind: "fire", name: `машин не на связи: ${fire.length}`, dot: "gone", label: "", text: fire.join(", ") });
    for (const cs of s.get().done) {
      const x = sessionOf(app, cs);
      if (x && isLive(x.state)) out.push({ kind: "done", callsign: cs, name: name(cs), dot: lamp(x), label: label("готово", cs), text: "" });
    }
    return out;
  }

  return { onRoster, cards, clearDone, onCurrent: (c: { params: Record<string, string> }) => void (c.params.callsign && clearDone(c.params.callsign)) };
}

export function createInbox(app: App): AppModule {
  const inbox = createInboxState(app);
  return {
    state: inbox,
    on: { roster: inbox.onRoster, current: inbox.onCurrent },
    screens: {
      inbox: { nav: "Вам", mark: "you", label: "Вам", view: InboxScreen, head: () => ({ title: "Вам" }) },
    },
    marks: { you: () => inbox.cards().length },
    css,
  };
}
