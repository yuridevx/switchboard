// Архив на странице: весь каталог (points.list без фильтров) — для метки fire и sid по callsign; читается на первом roster,
// на экране «Сессии» и после своих действий. Список с фильтрами и поиск экран спрашивает сам; своего состояния сверх ответа нет.
// Проект и «идёт» считает страница: проект — метка project.of доски, «идёт» — сессия в roster.
import type { App } from "@switchboard/web-core";
import { createStore, sessionOf } from "@switchboard/web-ui";
import type { ListedPoint } from "@switchboard/points";

/** Строка каталога points.list: title — заголовок сессии, model и токены — сводка, которую Host кладёт в точку. */
export type Row = {
  sid: string;
  callsign?: string;
  title?: string;
  dir?: string;
  model?: string;
  tok_in?: number;
  tok_out?: number;
  owner: string;
  head: { id: number; at: number };
  points: number;
  branches: number;
  hits?: Array<Omit<Hit, "sid" | "callsign" | "title">>;
};
/** Строка на странице: project — имя проекта доски, live — сессия идёт на машине. */
export type Listed = Row & { project?: string; live: boolean };
/** Каталог архива; search — умеет ли хранилище флота искать. С q у строки — совпадения. */
export type Archive = { search: boolean; sessions: Row[] };

/** Проект и «идёт» — со страницы. */
export function seen(app: App, s: Row): Listed {
  const project = s.callsign ? (app.mark("project.of", s.callsign) as { name: string } | null | undefined)?.name : undefined;
  return { ...s, ...(project ? { project } : {}), live: !!s.callsign && !!sessionOf(app, s.callsign) };
}
export type Line = { owner: string | null; head: number | null; points: ListedPoint[] };
/** Вызов модели из api-request: system — из api-request-shape. */
export type Call = { uuid: string; at: string; model: string; tok_in: number; tok_out: number; system: string };
export type Hit = { sid: string; callsign: string; title: string; point: number; uuid: string; at: string; text: string };

export function createFleet(app: App) {
  // done — итог последнего действия на странице сессии: переживает смену адреса, когда выбрана новая последняя точка
  const data = createStore<{ fleet?: Archive; error: string; moving: boolean; done?: { sid: string; text: string; link?: string } }>({ error: "", moving: false }, () => app.changed());
  let asked = false;
  let turn = 0;

  async function read() {
    const mine = ++turn;
    const r = await app.read<Archive>("points.list");
    if (mine !== turn) return; // ответ опоздал: есть вопрос новее
    data.set((d) => {
      d.error = r.ok ? "" : r.error;
      if (r.ok) d.fleet = r.result;
    });
  }

  const online = () => new Set(app.roster()?.machines.map((m) => m.machine));

  return {
    get: data.get,
    read,
    /** Идёт перенос «пожара»: второй не начать, пока страница открыта. */
    moving: (on: boolean) => data.set((d) => void (d.moving = on)),
    /** Итог действия сессии; без текста — снять. */
    said: (done?: { sid: string; text: string; link?: string }) => data.set((d) => void (d.done = done)),
    onRoster() {
      if (asked) return;
      asked = true;
      void read();
    },
    /** Машины с сессиями в архиве, которых нет в roster. */
    fire(): string[] {
      const on = online();
      return [...new Set((data.get().fleet?.sessions ?? []).map((s) => s.owner))].filter((m) => !on.has(m));
    },
    sidOf: (callsign: string) => data.get().fleet?.sessions.find((s) => s.callsign === callsign),
    bySid: (sid: string) => {
      const s = data.get().fleet?.sessions.find((x) => x.sid === sid);
      return s && seen(app, s);
    },
  };
}

export type Fleet = ReturnType<typeof createFleet>;

export const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} M` : n >= 1e3 ? `${Math.round(n / 1e3)} K` : String(n));
export const modelName = (m = "") => m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
export const tokens = (s: Pick<Row, "tok_in" | "tok_out">) => `${tok(s.tok_in ?? 0)} → ${tok(s.tok_out ?? 0)}`;
export const titleOf = (s: Pick<Row, "title" | "callsign" | "sid">) => s.title || (s.callsign ? s.callsign.split("@")[0] : s.sid);
