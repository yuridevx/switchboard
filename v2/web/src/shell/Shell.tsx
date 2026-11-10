// Оболочка: панель разделов слева (на телефоне — снизу), горячие клавиши, полоса «нет связи», место для страницы шага.
import { ActionIcon, Button, Tooltip, useMantineColorScheme } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { IconArchive, IconDots, IconLayoutList, IconMoon, IconPlus, IconSearch, IconSun } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Boundary, personWord, useUi } from "../common.tsx";
import { hhmm } from "../lib/time.ts";
import { useFleet, waitsYou } from "../store/fleet.ts";
import { linkWord, openPage, useLink } from "./link.ts";
import { LAMP, NAV } from "./nav.ts";
import { newPath } from "./NewSession.tsx";
import { HOST, Steps, StepUrl } from "./Page.tsx";
import { PushBar } from "./PushBar.tsx";

const GO: Record<string, string> = { w: "/work", a: "/archive", s: "/spend", f: "/fleet", o: "/observe", t: "/settings", р: "/work", а: "/archive", х: "/spend", ф: "/fleet", н: "/observe", с: "/settings" };

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

export function Shell() {
  const go = useNavigate();
  const loc = useLocation();
  const picture = useFleet();
  const ui = useUi();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const waiting = useMemo(() => waitsYou(picture), [picture.sessions, picture.machines, picture.you]);
  useGoKeys();
  useHotkeys([
    ["n", () => go(newPath())], ["т", () => go(newPath())],
    ["i", () => ui.set({ inspector: !ui.inspector })], ["ш", () => ui.set({ inspector: !ui.inspector })],
    ["shift+/", () => go("/keys")], ["mod+K", () => go("/find")],
  ]);
  const inTalk = /^\/(work|archive)\/.+/.test(loc.pathname);
  // экран машины — часть «Флота»: раздел в панели остаётся подсвеченным
  const section = loc.pathname.startsWith("/machine") ? "/fleet" : "/" + (loc.pathname.split("/")[1] ?? "");
  const lamp = LAMP[picture.link] ?? "failed";

  return (
    <div className={`app${inTalk ? " in-talk" : ""}`}>
      <nav className="rail" aria-label="Разделы">
        <Tooltip label="Новая сессия (N)" position="right"><ActionIcon size={40} radius="md" variant="filled" aria-label="Новая сессия" onClick={() => go(newPath())} mb={6}><IconPlus size={20} /></ActionIcon></Tooltip>
        {NAV.map(([to, word, I]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive || section === to ? "active" : "")}>
            <I size={21} stroke={1.6} />{word}
            {to === "/work" && waiting && <span className="dot" aria-label="ждут вас" />}
          </NavLink>
        ))}
        <div style={{ flex: 1 }} />
        <Tooltip label="Найти (Ctrl K)" position="right"><ActionIcon variant="subtle" size="lg" aria-label="Найти" onClick={() => go("/find")}><IconSearch size={18} /></ActionIcon></Tooltip>
        <Tooltip label={colorScheme === "dark" ? "Светлая тема" : "Тёмная тема"} position="right"><ActionIcon variant="subtle" size="lg" aria-label="Сменить тему" onClick={() => setColorScheme(colorScheme === "dark" ? "light" : "dark")}>{colorScheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}</ActionIcon></Tooltip>
        <Tooltip label={`${personWord(picture.you?.person ?? "")} · ${linkWord(picture.link)}`} position="right">
          <div style={{ padding: 8 }} role="img" aria-label={linkWord(picture.link)}><span className={`lamp ${lamp}`} style={{ marginTop: 0 }} /></div>
        </Tooltip>
      </nav>
      <main className="main">
        {picture.link !== "open" && picture.rev > 0 && <OfflineBar />}
        {picture.link === "open" && <PushBar />}
        {/* страница шага встаёт сюда и занимает место экрана; сам экран при этом скрыт, но жив */}
        <div id={HOST} className="pagehost" />
        <div className="screen"><Boundary name={NAV.find(([to]) => to === section)?.[1] ?? "Экран"} key={loc.pathname.split("/")[1]}><Outlet /></Boundary></div>
        <Steps />
        <StepUrl />
      </main>
      <nav className="tabbar" aria-label="Разделы">
        <NavLink to="/work" className={({ isActive }) => (isActive ? "active" : "")}><IconLayoutList size={21} stroke={1.6} />Работа{waiting && <span className="dot" aria-label="ждут вас" />}</NavLink>
        <button type="button" aria-label="Новая сессия" onClick={() => go(newPath())}><IconPlus size={24} />Новая</button>
        <NavLink to="/archive" className={({ isActive }) => (isActive ? "active" : "")}><IconArchive size={21} stroke={1.6} />Архив</NavLink>
        {/* лампа связи на телефоне — у «Ещё»: зелёная, жёлтая при подключении, красная без связи */}
        <NavLink to="/more" className={({ isActive }) => (isActive ? "active" : "")}><IconDots size={21} />Ещё<span className={`linklamp lamp ${lamp}`} role="img" aria-label={linkWord(picture.link)} /></NavLink>
      </nav>
    </div>
  );
}
