// Настройки участника сессии: профиль, модель, слот, усилие. Одна таблица у формы новой сессии и у настроек сессии; пара — вторая колонка тех же рядов.
import { Fragment, useState, type PointerEvent, type ReactNode } from "react";
import { Chip, Chips, edgeScroll, EFFORTS, IconBtn, In, isLive, modelEnv, MODELS, profileIdsOf, profileName, slotWaitText, Switch, track, useApp, useMachineLoad, type AccountsAnswer, type FleetKey, type ProfileInfo, type ProfileTreeNode, type ProfileView } from "@switchboard/web-ui";

/** сколько профилей видно без поиска (слово пользователя 6 нояб.: «до 6 подходящих или недавних») */
const SHOWN = 6;

const aliasOf = (key: FleetKey | undefined, model: string) => key?.env[modelEnv(model)] ?? "";
/** Что входит в набор: листья дерева из ответа машины. */
const leaves = (n: ProfileTreeNode): string[] => (n.children?.length ? n.children.flatMap(leaves) : [profileName(n.id)]);
const moved = (list: string[], id: string, to: number) => {
  const l = list.filter((x) => x !== id);
  l.splice(Math.max(0, Math.min(to, l.length)), 0, id);
  return l;
};
const scrollerOf = (el: Element): HTMLElement => {
  for (let x = el.parentElement; x; x = x.parentElement) if (/auto|scroll/.test(getComputedStyle(x).overflowY)) return x;
  return document.documentElement;
};

export type PartyValue = { list: string[]; model: string; effort: string; slot: string };
/** Участник: что выбрано и куда уходит выбор — в форму или запросом в сессию. */
export type PartySide = { value: PartyValue; set(change: Partial<PartyValue>): void };
/** Что доступно на машине; пока ответа нет — поля пустые. */
export type PartyData = { machine: string; ready: boolean; profiles?: Record<string, ProfileInfo>; slots?: AccountsAnswer["slots"]; keys: Record<string, FleetKey> };

type RowKey = "profile" | "unfold" | "model" | "slot" | "map" | "effort";
/** ряды таблицы: подпись пустая — ряд продолжает предыдущий */
const ROWS: Array<[RowKey, string]> = [["profile", "Профиль"], ["unfold", ""], ["model", "Модель"], ["slot", "Слот"], ["map", ""], ["effort", "Усилие"]];

/** Ячейки участника: профили с порядком и развёрткой, модель, слот, усилие. */
function useCells(title: string, { value, set }: PartySide, live: boolean, data: PartyData, usage: Map<string, number>): Record<RowKey, ReactNode> {
  const { machine, ready, profiles, slots, keys } = data;
  const { list, slot } = value;
  const [query, setQuery] = useState("");
  /** порядок на время перетаскивания: наружу уходит один раз, по отпусканию */
  const [dragged, setDragged] = useState<string[] | null>(null);
  const view = useMachineLoad<ProfileView>(machine, "profile.view", { profile: list }, live && ready && list.length > 0);
  const merged = list.length && !view.stale ? view.data : undefined;
  const modelShown = value.model || (merged?.settings.model?.value as string | undefined) || "";
  const effortShown = value.effort || (merged?.settings.effortLevel?.value as string | undefined) || "";
  const keyNames = Object.keys(keys);
  /** у сессии модель может быть полным именем: кнопка — её псевдоним */
  const alias = MODELS.find((m) => modelShown.includes(m)) ?? "";
  const mapped = keyNames.includes(slot) ? aliasOf(keys[slot], alias || "opus") : "";
  const needle = query.trim().toLowerCase();
  const rows = Object.entries(profiles ?? {}).filter(([id, p]) => `${id} ${p.about ?? ""} ${(p.names ?? []).map((x) => x.name).join(" ")}`.toLowerCase().includes(needle));
  const toggle = (id: string) => set({ list: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
  /** порядок — тем же жестом, что списки страницы: мышью и пальцем за ручку, Esc отменяет; стрелками — с клавиатуры */
  const drag = (id: string) => (e: PointerEvent<HTMLButtonElement>) => {
    const box = e.currentTarget.closest(".pt-tf")!;
    const scroller = scrollerOf(box);
    track(e, false, (from) => {
      let now = list;
      let y = from.y;
      setDragged(now);
      const stop = edgeScroll(scroller, "y", () => y, () => {});
      return {
        move(p) {
          y = p.y;
          const on = document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>("[data-chosen]");
          const other = on?.dataset.chosen;
          if (!other || other === id || !box.contains(on!)) return;
          now = moved(now, id, now.indexOf(other));
          setDragged(now);
        },
        drop() {
          stop();
          setDragged(null);
          if (now.join() !== list.join()) set({ list: now });
        },
        cancel() {
          stop();
          setDragged(null);
        },
      };
    });
  };
  const tagOf = (p: ProfileInfo) => (p.kind === "set" ? "набор" : p.kind === "style" ? "стиль" : "");
  // сначала профили, которые чаще стоят у открытых сессий; без поиска — до SHOWN штук, остальное — поиском
  const suggested = rows.filter(([id]) => !list.includes(id)).sort((a, b) => (usage.get(b[0]) ?? 0) - (usage.get(a[0]) ?? 0) || a[0].localeCompare(b[0])).slice(0, SHOWN);
  const sets = (merged?.tree ?? []).filter((n) => n.set);
  return {
    profile: (
      <div className="pt-tf" aria-label={`Профиль: ${title}`}>
        {(dragged ?? list).map((id, i) => (
          <span className="pt-oi" key={id} data-chosen={id}>
            {list.length > 1 ? (
              <button
                type="button"
                className="pt-gr"
                data-grip={id}
                title="Порядок: перетащить"
                aria-label={`порядок: ${profileName(id)}`}
                onPointerDown={drag(id)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") setDragged(moved(dragged ?? list, id, i - 1));
                  if (e.key === "ArrowRight") setDragged(moved(dragged ?? list, id, i + 1));
                  if (e.key === "Escape") setDragged(null);
                }}
                onKeyUp={(e) => {
                  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && dragged) {
                    setDragged(null);
                    if (dragged.join() !== list.join()) set({ list: dragged });
                  }
                }}
              >
                ⠿
              </button>
            ) : null}
            <b>{profileName(id)}</b>
            <IconBtn className="pt-oa" aria-label={`убрать: ${profileName(id)}`} onClick={() => toggle(id)}>
              ✕
            </IconBtn>
          </span>
        ))}
        <In className="pt-flt" aria-label={`Найти профиль: ${title}`} placeholder="Найти профиль" autoComplete="off" value={query} onChange={() => {}} onInput={(e) => setQuery(e.currentTarget.value)} />
        {suggested.map(([id, p]) => (
          <button type="button" className="pt-add" key={id} data-profile={id} title={[p.about, id].filter(Boolean).join(" · ")} onClick={() => toggle(id)}>
            {`+ ${profileName(id)}`}
            {tagOf(p) ? <span className={`pt-tg ${p.kind}`}>{tagOf(p)}</span> : null}
          </button>
        ))}
      </div>
    ),
    unfold: (
      <div className="pt-un" data-unfold="">
        {sets.map((n) => (
          <span key={n.id}>
            <b>{profileName(n.id)}</b>
            {` → ${[...new Set(leaves(n))].join(" › ")}  `}
          </span>
        ))}
      </div>
    ),
    model: (
      <Chips className="pt-seg">
        {MODELS.map((m) => (
          <Chip key={m} on={alias === m} data-model={m} onClick={() => set({ model: m })}>
            {m}
          </Chip>
        ))}
      </Chips>
    ),
    slot: (
      <div className="pt-sl">
        <div className="pt-sg">
          <span className="pt-sep">тут</span>
          <Chips className="pt-seg">
            {Object.entries(slots ?? {}).map(([name, info]) => (
              <Chip key={name} on={slot === name} data-slot={name} onClick={() => set({ slot: name })}>
                {info.wait ? slotWaitText(name, info.wait) : name}
              </Chip>
            ))}
          </Chips>
        </div>
        {keyNames.length ? (
          <div className="pt-sg">
            <span className="pt-sep">флот</span>
            <Chips className="pt-seg">
              {keyNames.map((name) => (
                <Chip key={name} on={slot === name} data-slot={name} data-fleet="" onClick={() => set({ slot: name })}>
                  {name}
                </Chip>
              ))}
            </Chips>
          </div>
        ) : null}
      </div>
    ),
    map: (
      <div className="pt-map" data-mapped="">
        {mapped ? (
          <>
            {`${alias || "opus"} → `}
            <code>{mapped}</code>
          </>
        ) : null}
      </div>
    ),
    effort: (
      <Chips className="pt-seg" data-effort-now={effortShown}>
        {EFFORTS.map(([k, label]) => (
          <Chip key={k} on={effortShown === k} data-effort={k} onClick={() => set({ effort: k })}>
            {label}
          </Chip>
        ))}
      </Chips>
    ),
  };
}

/** Таблица: подпись слева, ведущий и ведомый в общих рядах; children — слова отказа. */
export function PartyTable({ lead, wing, paired, togglePair, data, children }: { lead: PartySide; wing: PartySide; paired: boolean; togglePair(): void; data: PartyData; children?: ReactNode }) {
  const app = useApp();
  const sessions = app.use(() => app.roster()?.sessions ?? []);
  const usage = new Map<string, number>();
  for (const x of sessions) if (isLive(x.state)) for (const id of profileIdsOf(x)) usage.set(id, (usage.get(id) ?? 0) + 1);
  const leadCells = useCells("сессия", lead, true, data, usage);
  const wingCells = useCells("пара", wing, paired, data, usage);
  const wide = app.wide;
  /** один переключатель над второй колонкой */
  const pairSwitch = (
    <span className="pt-sw pt-pair">
      <Switch on={paired} data-pair="" aria-label="Пара" onClick={togglePair} />
      <b>Пара</b>
    </span>
  );
  const cell = (side: "lead" | "wing", key: RowKey) => (
    <div className={`pt-c ${key}`} data-side={side === "lead" ? "Ведущий" : "Ведомый"}>
      {(side === "lead" ? leadCells : wingCells)[key]}
    </div>
  );
  return (
    <div className={wide ? "pt-grid" : "pt-grid narrow"} data-pair={paired ? "on" : "off"}>
      {wide ? (
        <>
          <span />
          <span />
          <div className="pt-t">{pairSwitch}</div>
          {ROWS.map(([key, label]) => (
            <Fragment key={key}>
              <span className="pt-k">{label}</span>
              {cell("lead", key)}
              {paired ? cell("wing", key) : <span />}
            </Fragment>
          ))}
        </>
      ) : (
        <>
          <div className="pt-t all">{pairSwitch}</div>
          {ROWS.map(([key, label]) => (
            <Fragment key={key}>
              <span className="pt-k">{label}</span>
              {cell("lead", key)}
            </Fragment>
          ))}
          {paired ? (
            <>
              <b className="pt-t all" aria-label="Пара">▸</b>
              {ROWS.map(([key, label]) => (
                <Fragment key={key}>
                  <span className="pt-k">{label}</span>
                  {cell("wing", key)}
                </Fragment>
              ))}
            </>
          ) : null}
        </>
      )}
      {children}
    </div>
  );
}
