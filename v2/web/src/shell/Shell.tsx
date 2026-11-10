// Оболочка: панель разделов слева (на телефоне — снизу), палитра команд, горячие клавиши, полоса «нет связи».
import { peopleList } from "@sb/protocol";
import { ActionIcon, Button, Drawer, Modal, Stack, Table, Text, Tooltip, useMantineColorScheme } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { Spotlight, spotlight, type SpotlightActionData } from "@mantine/spotlight";
import {
  IconActivityHeartbeat, IconArchive, IconChartBar, IconDots, IconInbox, IconLayoutList, IconMoon, IconPlus, IconSearch, IconServer2, IconSettings, IconSun,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Boundary, personWord, STATE_WORD, useCall, useLabels, useUi } from "../common.tsx";
import { hhmm } from "../lib/time.ts";
import { projectOf } from "../lib/work.ts";
import { inboxOf, machineOfCall, useFleet } from "../store/fleet.ts";
import { linkWord, openPage, useLink } from "./link.ts";
import { NewSession } from "./NewSession.tsx";
import { Missed } from "./Missed.tsx";
import { PushBar } from "./PushBar.tsx";

const NAV = [
  ["/inbox", "Вам", IconInbox, "в"], ["/work", "Работа", IconLayoutList, "р"], ["/archive", "Архив", IconArchive, "а"], ["/spend", "Расход", IconChartBar, "х"],
  ["/fleet", "Флот", IconServer2, "ф"], ["/observe", "Наблюдение", IconActivityHeartbeat, "н"], ["/settings", "Настройки", IconSettings, "с"],
] as const;
const GO: Record<string, string> = { i: "/inbox", w: "/work", a: "/archive", s: "/spend", f: "/fleet", o: "/observe", t: "/settings", в: "/inbox", р: "/work", а: "/archive", х: "/spend", ф: "/fleet", н: "/observe", с: "/settings" };

const KEYS: Array<[string, string]> = [
  ["Ctrl K", "Палитра: сессии, машины, папки, проекты, действия"], ["N", "Новая сессия"], ["J  K", "Вниз и вверх по списку"], ["E", "Прочитано"], ["I", "Инспектор"],
  ["G затем I W A S F O T", "Разделы: Вам, Работа, Архив, Расход, Флот, Наблюдение, Настройки"], ["Enter", "Отправить сообщение"], ["Shift Enter", "Новая строка"], ["Esc", "Отменить перетаскивание"], ["?", "Этот список"],
];

function useGoKeys() {
  const go = useNavigate();
  const armed = useRef(0);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "g" || k === "п") return void (armed.current = Date.now());
      if (Date.now() - armed.current < 1200 && GO[k]) (armed.current = 0, e.preventDefault(), go(GO[k]));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [go]);
}

/** Полоса «нет связи»: на какое время данные, когда следующая попытка, «Сейчас». */
export function offlineLine(o: { seen: number; retryAt?: number; now: number; connecting: boolean }): string {
  const data = o.seen ? `данные на ${hhmm(o.seen)}` : "данных ещё нет";
  const left = o.retryAt ? Math.max(0, Math.ceil((o.retryAt - o.now) / 1000)) : 0;
  return `Нет связи с флотом · ${data} · ${o.connecting || !left ? "подключаюсь" : `снова через ${left} с`}`;
}

function OfflineBar() {
  const link = useLink();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="banner" role="status" style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ flex: 1, minWidth: 0 }}>{offlineLine({ seen: link.seen, retryAt: link.retryAt, now, connecting: link.state === "connecting" })}</span>
      <Button size="compact-xs" variant="default" onClick={openPage}>Сейчас</Button>
    </div>
  );
}

const LAMP: Record<string, string> = { open: "idle", connecting: "waiting", closed: "failed", stopped: "failed" };

export function Shell() {
  const go = useNavigate();
  const loc = useLocation();
  const picture = useFleet();
  const ui = useUi();
  const labels = useLabels();
  const projects = useCall(peopleList, {});
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [moreOpen, setMoreOpen] = useState(false);
  const inbox = useMemo(() => inboxOf(picture), [picture.sessions, picture.machines, picture.you]);
  const waiting = inbox.asks.length + inbox.done.length > 0;
  useGoKeys();
  useHotkeys([
    ["n", () => ui.set({ newOpen: true })], ["т", () => ui.set({ newOpen: true })],
    ["i", () => ui.set({ inspector: !ui.inspector })], ["ш", () => ui.set({ inspector: !ui.inspector })],
    ["shift+/", () => ui.set({ keysOpen: true })],
  ]);
  const inTalk = /^\/(inbox|work|archive)\/.+/.test(loc.pathname);
  // экран машины — часть «Флота»: раздел в панели остаётся подсвеченным
  const section = loc.pathname.startsWith("/machine") ? "/fleet" : "/" + (loc.pathname.split("/")[1] ?? "");
  const projectNames = Object.fromEntries((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  const actions: SpotlightActionData[] = useMemo(() => [
    { id: "new", label: "Новая сессия", description: "N", onClick: () => ui.set({ newOpen: true }) },
    ...Object.values(picture.sessions).map((s) => {
      const project = projectNames[projectOf(picture, s)];
      return {
        id: "s:" + s.callsign, label: labels[s.callsign] ?? s.title ?? s.spec.name,
        description: `${s.callsign} · ${picture.machines[machineOfCall(s.callsign)]?.online === false ? "нет связи, последнее известное" : STATE_WORD[s.state]} · ${s.spec.cwd}${project ? ` · ${project}` : ""}`,
        // находится по папке, проекту и по обращению, которое сессия разбирает (вид и ключ инцидента)
        keywords: [s.spec.cwd, project ?? "", s.spec.name, ...(s.incident ? [s.incident.kind, s.incident.key, "инцидент"] : [])],
        onClick: () => go(`/work/${s.callsign}`),
      };
    }),
    ...Object.values(picture.machines).map((m) => ({ id: "m:" + m.name, label: `Машина ${labels["@" + m.name] ?? m.name}`, description: m.online ? `на связи · сборка ${m.build ?? "—"}` : "без связи", keywords: [m.name], onClick: () => go(`/machine/${m.name}`) })),
    ...NAV.map(([to, word]) => ({ id: "n:" + to, label: word, description: "Раздел", onClick: () => go(to) })),
    { id: "a:deploy", label: "Выпуски: назначить или откатить сборку", onClick: () => go("/fleet/releases") },
    { id: "a:accounts", label: "Войти в аккаунт Claude на машине", onClick: () => go("/fleet/accounts") },
    { id: "a:people", label: "Люди и проекты: дать доступ", onClick: () => go("/settings/people") },
    { id: "a:passes", label: "Пропуска: отозвать устройство", onClick: () => go("/settings/passes") },
    { id: "a:alerts", label: "Уведомления на этом устройстве", onClick: () => go("/settings/alerts") },
    { id: "a:fails", label: "Наблюдение: почему запрос отказал", onClick: () => go("/observe/requests") },
    { id: "a:theme", label: colorScheme === "dark" ? "Светлая тема" : "Тёмная тема", onClick: () => setColorScheme(colorScheme === "dark" ? "light" : "dark") },
  ], [picture.sessions, picture.machines, colorScheme, labels, projects.data]);
  const lamp = LAMP[picture.link] ?? "failed";

  return (
    <div className={`app${inTalk ? " in-talk" : ""}`}>
      <nav className="rail" aria-label="Разделы">
        <Tooltip label="Новая сессия (N)" position="right"><ActionIcon size={40} radius="md" variant="filled" aria-label="Новая сессия" onClick={() => ui.set({ newOpen: true })} mb={6}><IconPlus size={20} /></ActionIcon></Tooltip>
        {NAV.map(([to, word, I]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive || section === to ? "active" : "")}>
            <I size={21} stroke={1.6} />{word}
            {to === "/inbox" && waiting && <span className="dot" aria-label="есть новое" />}
          </NavLink>
        ))}
        <div style={{ flex: 1 }} />
        <Tooltip label="Палитра команд (Ctrl K)" position="right"><ActionIcon variant="subtle" size="lg" aria-label="Палитра команд" onClick={spotlight.open}><IconSearch size={18} /></ActionIcon></Tooltip>
        <Tooltip label={colorScheme === "dark" ? "Светлая тема" : "Тёмная тема"} position="right"><ActionIcon variant="subtle" size="lg" aria-label="Сменить тему" onClick={() => setColorScheme(colorScheme === "dark" ? "light" : "dark")}>{colorScheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}</ActionIcon></Tooltip>
        <Tooltip label={`${personWord(picture.you?.person ?? "")} · ${linkWord(picture.link)}`} position="right">
          <div style={{ padding: 8 }} role="img" aria-label={linkWord(picture.link)}><span className={`lamp ${lamp}`} style={{ marginTop: 0 }} /></div>
        </Tooltip>
      </nav>
      <main className="main">
        {picture.link !== "open" && picture.rev > 0 && <OfflineBar />}
        {picture.link === "open" && <PushBar />}
        {picture.link === "open" && <Missed />}
        <Boundary name={NAV.find(([to]) => to === section)?.[1] ?? "Экран"} key={loc.pathname.split("/")[1]}><Outlet /></Boundary>
      </main>
      <nav className="tabbar" aria-label="Разделы">
        <NavLink to="/inbox" className={({ isActive }) => (isActive ? "active" : "")}><IconInbox size={21} stroke={1.6} />Вам{waiting && <span className="dot" />}</NavLink>
        <NavLink to="/work" className={({ isActive }) => (isActive ? "active" : "")}><IconLayoutList size={21} stroke={1.6} />Работа</NavLink>
        <button type="button" aria-label="Новая сессия" onClick={() => ui.set({ newOpen: true })}><IconPlus size={24} />Новая</button>
        <NavLink to="/archive" className={({ isActive }) => (isActive ? "active" : "")}><IconArchive size={21} stroke={1.6} />Архив</NavLink>
        {/* лампа связи на телефоне — у «Ещё»: зелёная, жёлтая при подключении, красная без связи */}
        <button type="button" onClick={() => setMoreOpen(true)}><IconDots size={21} />Ещё<span className={`linklamp lamp ${lamp}`} role="img" aria-label={linkWord(picture.link)} /></button>
      </nav>
      <Drawer opened={moreOpen} onClose={() => setMoreOpen(false)} position="bottom" size="auto" title="Ещё">
        <Stack gap={4} pb="md">
          {NAV.slice(3).map(([to, word, I]) => <NavLink key={to} to={to} onClick={() => setMoreOpen(false)} className="row morerow"><I size={20} stroke={1.6} /><span>{word}</span></NavLink>)}
          <button type="button" className="row morerow" onClick={() => (spotlight.open(), setMoreOpen(false))}><IconSearch size={20} stroke={1.6} /><span>Найти</span></button>
          <button type="button" className="row morerow" onClick={() => setColorScheme(colorScheme === "dark" ? "light" : "dark")}>{colorScheme === "dark" ? <IconSun size={20} stroke={1.6} /> : <IconMoon size={20} stroke={1.6} />}<span>{colorScheme === "dark" ? "Светлая тема" : "Тёмная тема"}</span></button>
          <div className="row morerow" style={{ cursor: "default" }}><span className={`lamp ${lamp}`} style={{ marginTop: 0, justifySelf: "center" }} /><span>{personWord(picture.you?.person ?? "")} · {linkWord(picture.link)}</span></div>
        </Stack>
      </Drawer>
      <NewSession />
      <Spotlight actions={actions} shortcut={["mod + K"]} nothingFound="Ничего не нашлось" highlightQuery limit={9} searchProps={{ leftSection: <IconSearch size={18} />, placeholder: "Сессия, папка, проект, машина или действие" }} />
      <Modal opened={ui.keysOpen} onClose={() => ui.set({ keysOpen: false })} title="Клавиши">
        <Table verticalSpacing={6}><Table.Tbody>{KEYS.map(([k, what]) => <Table.Tr key={k}><Table.Td style={{ whiteSpace: "nowrap" }}>{k.split("  ").map((x) => <kbd key={x} className="k" style={{ marginRight: 4 }}>{x}</kbd>)}</Table.Td><Table.Td><Text size="sm">{what}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
      </Modal>
    </div>
  );
}
