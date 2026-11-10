// Оболочка: панель разделов слева (на телефоне — снизу), палитра команд, горячие клавиши, полоса «нет связи».
import { ActionIcon, Drawer, Modal, Stack, Table, Text, Tooltip, useMantineColorScheme } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { Spotlight, spotlight, type SpotlightActionData } from "@mantine/spotlight";
import {
  IconActivityHeartbeat, IconArchive, IconChartBar, IconDots, IconInbox, IconLayoutList, IconMoon, IconPlus, IconSearch, IconServer2, IconSettings, IconSun,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Boundary, personWord, STATE_WORD, useUi } from "../common.tsx";
import { inboxOf, useFleet } from "../store/fleet.ts";
import { NewSession } from "./NewSession.tsx";

const NAV = [
  ["/inbox", "Вам", IconInbox, "в"], ["/work", "Работа", IconLayoutList, "р"], ["/archive", "Архив", IconArchive, "а"], ["/spend", "Расход", IconChartBar, "х"],
  ["/fleet", "Флот", IconServer2, "ф"], ["/observe", "Наблюдение", IconActivityHeartbeat, "н"], ["/settings", "Настройки", IconSettings, "с"],
] as const;
const GO: Record<string, string> = { i: "/inbox", w: "/work", a: "/archive", s: "/spend", f: "/fleet", o: "/observe", t: "/settings", в: "/inbox", р: "/work", а: "/archive", х: "/spend", ф: "/fleet", н: "/observe", с: "/settings" };

const KEYS: Array<[string, string]> = [
  ["Ctrl K", "Палитра: сессии, машины, действия"], ["N", "Новая сессия"], ["J  K", "Вниз и вверх по списку"], ["E", "Прочитано"], ["I", "Инспектор"],
  ["G затем I W A S F O T", "Разделы: Вам, Работа, Архив, Расход, Флот, Наблюдение, Настройки"], ["Enter", "Отправить сообщение"], ["Shift Enter", "Новая строка"], ["?", "Этот список"],
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

export function Shell() {
  const go = useNavigate();
  const loc = useLocation();
  const picture = useFleet();
  const ui = useUi();
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
  const actions: SpotlightActionData[] = useMemo(() => [
    { id: "new", label: "Новая сессия", description: "N", onClick: () => ui.set({ newOpen: true }) },
    ...Object.values(picture.sessions).map((s) => ({ id: "s:" + s.callsign, label: s.title ?? s.spec.name, description: `${s.callsign} · ${picture.machines[s.callsign.slice(s.callsign.indexOf("@") + 1)]?.online === false ? "нет связи, последнее известное" : STATE_WORD[s.state]}`, onClick: () => go(`/work/${s.callsign}`) })),
    ...Object.values(picture.machines).map((m) => ({ id: "m:" + m.name, label: `Машина ${m.name}`, description: m.online ? `на связи · сборка ${m.build ?? "—"}` : "без связи", onClick: () => go(`/machine/${m.name}`) })),
    ...NAV.map(([to, word]) => ({ id: "n:" + to, label: word, description: "Раздел", onClick: () => go(to) })),
    { id: "a:deploy", label: "Выпуски: назначить или откатить сборку", onClick: () => go("/fleet/releases") },
    { id: "a:accounts", label: "Войти в аккаунт Claude на машине", onClick: () => go("/fleet/accounts") },
    { id: "a:people", label: "Люди и проекты: дать доступ", onClick: () => go("/settings/people") },
    { id: "a:passes", label: "Пропуска: отозвать устройство", onClick: () => go("/settings/passes") },
    { id: "a:fails", label: "Наблюдение: почему запрос отказал", onClick: () => go("/observe/requests") },
    { id: "a:theme", label: colorScheme === "dark" ? "Светлая тема" : "Тёмная тема", onClick: () => setColorScheme(colorScheme === "dark" ? "light" : "dark") },
  ], [picture.sessions, picture.machines, colorScheme]);

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
        <Tooltip label={`${personWord(picture.you?.person ?? "")} · ${picture.link === "open" ? "на связи" : "нет связи"}`} position="right">
          <div style={{ padding: 8 }} role="img" aria-label={picture.link === "open" ? "на связи" : "нет связи"}><span className={`lamp ${picture.link === "open" ? "idle" : "failed"}`} style={{ marginTop: 0 }} /></div>
        </Tooltip>
      </nav>
      <main className="main">
        {picture.link !== "open" && picture.rev > 0 && <div className="banner" role="status">Нет связи с флотом. Показано последнее известное; переподключаюсь.</div>}
        <Boundary name={NAV.find(([to]) => to === section)?.[1] ?? "Экран"} key={loc.pathname.split("/")[1]}><Outlet /></Boundary>
      </main>
      <nav className="tabbar" aria-label="Разделы">
        <NavLink to="/inbox" className={({ isActive }) => (isActive ? "active" : "")}><IconInbox size={21} stroke={1.6} />Вам{waiting && <span className="dot" />}</NavLink>
        <NavLink to="/work" className={({ isActive }) => (isActive ? "active" : "")}><IconLayoutList size={21} stroke={1.6} />Работа</NavLink>
        <button type="button" aria-label="Новая сессия" onClick={() => ui.set({ newOpen: true })}><IconPlus size={24} />Новая</button>
        <NavLink to="/archive" className={({ isActive }) => (isActive ? "active" : "")}><IconArchive size={21} stroke={1.6} />Архив</NavLink>
        <button type="button" onClick={() => setMoreOpen(true)}><IconDots size={21} />Ещё</button>
      </nav>
      <Drawer opened={moreOpen} onClose={() => setMoreOpen(false)} position="bottom" size="auto" title="Ещё">
        <Stack gap={4} pb="md">
          {NAV.slice(3).map(([to, word, I]) => <NavLink key={to} to={to} onClick={() => setMoreOpen(false)} className="row" style={{ gridTemplateColumns: "24px 1fr", textDecoration: "none", color: "inherit", alignItems: "center" }}><I size={20} stroke={1.6} /><span>{word}</span></NavLink>)}
          <button type="button" className="row" style={{ gridTemplateColumns: "24px 1fr", alignItems: "center", border: 0, background: "none", font: "inherit", color: "inherit", textAlign: "left" }} onClick={() => (spotlight.open(), setMoreOpen(false))}><IconSearch size={20} stroke={1.6} /><span>Найти</span></button>
          <button type="button" className="row" style={{ gridTemplateColumns: "24px 1fr", alignItems: "center", border: 0, background: "none", font: "inherit", color: "inherit", textAlign: "left" }} onClick={() => setColorScheme(colorScheme === "dark" ? "light" : "dark")}>{colorScheme === "dark" ? <IconSun size={20} stroke={1.6} /> : <IconMoon size={20} stroke={1.6} />}<span>{colorScheme === "dark" ? "Светлая тема" : "Тёмная тема"}</span></button>
        </Stack>
      </Drawer>
      <NewSession />
      <Spotlight actions={actions} shortcut={["mod + K"]} nothingFound="Ничего не нашлось" highlightQuery limit={9} searchProps={{ leftSection: <IconSearch size={18} />, placeholder: "Сессия, машина или действие" }} />
      <Modal opened={ui.keysOpen} onClose={() => ui.set({ keysOpen: false })} title="Клавиши">
        <Table verticalSpacing={6}><Table.Tbody>{KEYS.map(([k, what]) => <Table.Tr key={k}><Table.Td style={{ whiteSpace: "nowrap" }}>{k.split("  ").map((x) => <kbd key={x} className="k" style={{ marginRight: 4 }}>{x}</kbd>)}</Table.Td><Table.Td><Text size="sm">{what}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
      </Modal>
    </div>
  );
}
