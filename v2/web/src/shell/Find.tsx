// Разделы оболочки страницами: «Найти» (сессии, машины, папки, проекты, действия), «Ещё» на телефоне, «Клавиши».
import { peopleList } from "@sb/protocol";
import { Table, Text, TextInput, useMantineColorScheme } from "@mantine/core";
import { IconMoon, IconSearch, IconSun } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { personWord, STATE_WORD, useCall, useLabels } from "../common.tsx";
import { projectOf } from "../lib/work.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { linkWord } from "./link.ts";
import { newPath } from "./NewSession.tsx";
import { RoutePage } from "./Page.tsx";
import { LAMP, NAV } from "./nav.ts";

type Found = { id: string; label: string; about?: string; words: string[]; run: () => void };

/** Что подходит под запрос: все слова запроса есть в названии, описании или ключевых словах; пустой запрос — всё. */
export function findIn<T extends { label: string; about?: string; words: string[] }>(items: T[], q: string): T[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((x) => {
    const hay = [x.label, x.about ?? "", ...x.words].join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export function Find() {
  const go = useNavigate();
  const picture = useFleet();
  const labels = useLabels();
  const projects = useCall(peopleList, {});
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const items: Found[] = useMemo(() => {
    const names = Object.fromEntries((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
    const to = (path: string) => () => go(path, { replace: true });
    return [
      { id: "new", label: "Новая сессия", about: "N", words: [], run: to(newPath()) },
      ...Object.values(picture.sessions).map((s) => {
        const project = names[projectOf(picture, s)];
        return {
          id: "s:" + s.callsign, label: labels[s.callsign] ?? s.title ?? s.spec.name,
          about: `${s.callsign} · ${picture.machines[machineOfCall(s.callsign)]?.online === false ? "нет связи, последнее известное" : STATE_WORD[s.state]} · ${s.spec.cwd}${project ? ` · ${project}` : ""}`,
          // находится по папке, проекту и по обращению, которое сессия разбирает (вид и ключ инцидента)
          words: [s.spec.cwd, project ?? "", s.spec.name, ...(s.incident ? [s.incident.kind, s.incident.key, "инцидент"] : [])],
          run: to(`/work/${s.callsign}`),
        };
      }),
      ...Object.values(picture.machines).map((m) => ({ id: "m:" + m.name, label: `Машина ${labels["@" + m.name] ?? m.name}`, about: m.online ? `на связи · сборка ${m.build ?? "—"}` : "без связи", words: [m.name], run: to(`/machine/${m.name}`) })),
      ...NAV.map(([path, word]) => ({ id: "n:" + path, label: word, about: "Раздел", words: [], run: to(path) })),
      { id: "a:deploy", label: "Выпуски: назначить или откатить сборку", words: [], run: to("/fleet/releases") },
      { id: "a:accounts", label: "Войти в аккаунт Claude на машине", words: [], run: to("/fleet/accounts") },
      { id: "a:people", label: "Люди и проекты: дать доступ", words: [], run: to("/settings/people") },
      { id: "a:passes", label: "Пропуска: отозвать устройство", words: [], run: to("/settings/passes") },
      { id: "a:alerts", label: "Уведомления на этом устройстве", words: [], run: to("/settings/alerts") },
      { id: "a:fails", label: "Наблюдение: почему запрос отказал", words: [], run: to("/observe/requests") },
      { id: "a:keys", label: "Клавиши", about: "?", words: ["горячие"], run: to("/keys") },
      { id: "a:theme", label: colorScheme === "dark" ? "Светлая тема" : "Тёмная тема", words: ["тема"], run: () => setColorScheme(colorScheme === "dark" ? "light" : "dark") },
    ];
  }, [picture.sessions, picture.machines, colorScheme, labels, projects.data]);
  const found = findIn(items, q).slice(0, 30);
  const pick = Math.min(at, Math.max(found.length - 1, 0));
  return (
    <RoutePage title="Найти">
      <TextInput autoFocus aria-label="Найти" leftSection={<IconSearch size={18} />} placeholder="Сессия, папка, проект, машина или действие" value={q}
        onChange={(e) => (setQ(e.currentTarget.value), setAt(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setAt(Math.min(pick + 1, found.length - 1)));
          if (e.key === "ArrowUp") (e.preventDefault(), setAt(Math.max(pick - 1, 0)));
          if (e.key === "Enter") found[pick]?.run();
        }} />
      <div role="listbox" aria-label="Найденное" style={{ marginTop: 10 }}>
        {found.map((x, i) => (
          <div key={x.id} role="option" aria-selected={i === pick} tabIndex={-1} className={`row${i === pick ? " sel" : ""}`} style={{ gridTemplateColumns: "1fr" }} onClick={x.run} onMouseEnter={() => setAt(i)}>
            <div style={{ minWidth: 0 }}><div className="t trunc">{x.label}</div>{x.about && <div className="sub trunc">{x.about}</div>}</div>
          </div>
        ))}
        {!found.length && <Text className="muted" size="sm" mt="sm">Ничего не нашлось</Text>}
      </div>
    </RoutePage>
  );
}

/** «Ещё» на телефоне: разделы, которых нет в нижней панели, поиск, тема, связь. */
export function More() {
  const picture = useFleet();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const lamp = LAMP[picture.link] ?? "failed";
  return (
    <RoutePage title="Ещё">
      {NAV.slice(3).map(([to, word, I]) => <NavLink key={to} to={to} className="row morerow"><I size={20} stroke={1.6} /><span>{word}</span></NavLink>)}
      <NavLink to="/find" className="row morerow"><IconSearch size={20} stroke={1.6} /><span>Найти</span></NavLink>
      <button type="button" className="row morerow" onClick={() => setColorScheme(colorScheme === "dark" ? "light" : "dark")}>{colorScheme === "dark" ? <IconSun size={20} stroke={1.6} /> : <IconMoon size={20} stroke={1.6} />}<span>{colorScheme === "dark" ? "Светлая тема" : "Тёмная тема"}</span></button>
      <div className="row morerow" style={{ cursor: "default" }}><span className={`lamp ${lamp}`} style={{ marginTop: 0, justifySelf: "center" }} /><span>{personWord(picture.you?.person ?? "")} · {linkWord(picture.link)}</span></div>
    </RoutePage>
  );
}

const KEYS: Array<[string, string]> = [
  ["Ctrl K", "Найти: сессии, машины, папки, проекты, действия"], ["N", "Новая сессия"], ["J  K", "Вниз и вверх по списку"], ["E", "Прочитано"], ["I", "Инспектор"],
  ["G затем I W A S F O T", "Разделы: Вам, Работа, Архив, Расход, Флот, Наблюдение, Настройки"], ["Enter", "Отправить сообщение"], ["Shift Enter", "Новая строка"], ["Esc", "Отменить перетаскивание"], ["?", "Этот список"],
];

export function Keys() {
  return (
    <RoutePage title="Клавиши">
      <Table verticalSpacing={6}><Table.Tbody>{KEYS.map(([k, what]) => <Table.Tr key={k}><Table.Td style={{ whiteSpace: "nowrap" }}>{k.split("  ").map((x) => <kbd key={x} className="k" style={{ marginRight: 4 }}>{x}</kbd>)}</Table.Td><Table.Td><Text size="sm">{what}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
    </RoutePage>
  );
}
