// Разговор сессии: шапка — только кто это и чем занят; лента; над полем ввода — дела и «Идут сейчас»; под полем — документ сессии и все действия значками.
// Рядом — инспектор (ширина тянется) или второй разговор пары; у пары шапка одна на обоих участников.
import { CLAUDE, prefsSet, sessionCall, sessionRemove, sessionRewind, sessionStart, sessionStop, sessionUpdate, type SessionRow } from "@sb/protocol";
import { ActionIcon, Button, Checkbox, Group, Loader, Menu, SegmentedControl, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { useSplit } from "../lib/Split.tsx";
import { Page } from "../shell/Page.tsx";
import { IconArrowDown, IconArrowLeft, IconDots, IconEraser, IconFocus2, IconHandStop, IconLayoutSidebarRight, IconListCheck, IconLockOpen, IconPencilCheck, IconPlayerPlay, IconPuzzle, IconRobot, IconUserMinus, IconUserPlus } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { act } from "../api.ts";
import { useLocal } from "../lib/local.ts";
import { exportMd, focused } from "../chat/focus.ts";
import { AfterTurn, confirmDanger, EFFORTS, Failed, Lamp, MODES, STATE_WORD, useCall, useLabels, useMyPrefs, useUi, useWide } from "../common.tsx";
import { day, hhmm, kilo } from "../lib/time.ts";
import { machineOfCall, useFleet } from "../store/fleet.ts";
import { AskCard } from "./Ask.tsx";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { Asides, Running } from "./Dock.tsx";
import { patchDoc } from "./doc.ts";
import { type FeedEnv, FeedEnvProvider, Rows, Tail, TodoList } from "./Feed.tsx";
import { ModelFace, pickModel, useDoc } from "./DocFields.tsx";
import { ModelPicker, useModelWord, useOffers } from "./ModelPicker.tsx";
import { Inspector } from "./Inspector.tsx";
import { type Talk, useMarkRead, useTalk } from "./talk.ts";

const isLive = (s: SessionRow) => s.state !== "stopped" && s.state !== "failed";

/** Значение документа сессии в ряду под полем ввода: лицо — значок, полоски или короткое слово; что это и чему равно — в подсказке и в меню; замена — один запрос session.update. */
function Chip({ label, word, value, options, later, onPick, face, item, loud }: { label: string; /** значение словом — для подсказки */ word: string; value?: string; options: ReadonlyArray<readonly [string, string]>; later?: boolean; onPick: (v: string) => void; face: React.ReactNode; /** свой вид варианта в меню; нет — словом */ item?: (v: string) => React.ReactNode; /** значение не обычное — лицо цветом */ loud?: boolean }) {
  return (
    <Menu position="top-start" withinPortal>
      <Menu.Target>
        <button type="button" className={`docval${loud ? " loud" : ""}`} aria-label={label} title={`${label}: ${word}`}>{face}<AfterTurn on={!!later} brief /></button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{label}</Menu.Label>
        {options.map(([v, w]) => <Menu.Item key={v} onClick={() => onPick(v)} fw={v === value ? 700 : undefined}>{item?.(v) ?? w}</Menu.Item>)}
      </Menu.Dropdown>
    </Menu>
  );
}

const MODE_ICON = { all: IconLockOpen, ask: IconHandStop, plan: IconListCheck, edits: IconPencilCheck, auto: IconRobot } as const;

/** Усилие ступеньками: сколько закрашено — такое усилие; ни одной — как у модели. Ступенек столько, сколько усилий бывает. */
function EffortBars({ level }: { level: number }) {
  const w = EFFORTS.length * 4 - 1;
  return (
    <svg className="effort" width={w} height="12" viewBox={`0 0 ${w} 12`} aria-hidden="true">
      {EFFORTS.map((_, i) => <rect key={i} x={i * 4} y={9 - i * 2} width="3" height={3 + i * 2} rx="1" className={i < level ? "on" : undefined} />)}
    </svg>
  );
}

/** Значения документа сессии одной строкой значков: режим, модель, усилие, кусочки, контекст, час кэша. Аккаунта здесь нет: его выбирает машина.
 *  ask — «/model слова» из поля ввода: список моделей открывается с этим поиском. */
function DocValues({ s, ask }: { s: SessionRow; ask?: { n: number; q: string } }) {
  const [piecesOpen, setPiecesOpen] = useState(false);
  const d = useDoc(s);
  const offerWord = useModelWord();
  const picked = s.spec.pieces ?? [];
  const mode = (s.spec.mode ?? "all") as keyof typeof MODE_ICON;
  const modeWord = MODES.find(([m]) => m === mode)![1];
  const ModeIcon = MODE_ICON[mode];
  const effort = EFFORTS.findIndex(([e]) => e === s.spec.effort) + 1;
  const piecesWord = picked.length ? picked.map(d.title).join(" + ") : "нет";
  const live = isLive(s);
  return (
    <div className="docvals" role="group" aria-label="Документ сессии">
      <Chip label="Режим" word={modeWord} value={mode} options={MODES} loud={mode !== "all"} onPick={(m) => patchDoc(s, { mode: m as never })}
        face={<><ModeIcon size={15} />{mode !== "all" && <span className="w">{modeWord}</span>}</>}
        item={(v) => { const I = MODE_ICON[v as keyof typeof MODE_ICON]; return <span className="menu-face"><I size={15} />{MODES.find(([m]) => m === v)![1]}</span>; }} />
      <ModelPicker value={s.spec} loud={!!s.answers} ask={ask} onPick={(o) => pickModel(s, o)}
        title={s.answers ? `Модель: выбрана ${offerWord(s.spec.model)}, отвечает ${offerWord(s.answers)}` : `Модель: ${offerWord(s.spec.model)}`}
        face={<><ModelFace s={s} /><AfterTurn on={d.later.includes("model") || d.later.includes("key")} brief /></>} />
      <Chip label="Усилие" word={effort ? EFFORTS[effort - 1]![1] : "как у модели"} value={s.spec.effort} options={d.efforts} later={d.later.includes("effort")} onPick={(e) => patchDoc(s, { effort: e as never })}
        face={<EffortBars level={effort} />}
        item={(v) => <span className="menu-face"><EffortBars level={EFFORTS.findIndex(([e]) => e === v) + 1} />{EFFORTS.find(([e]) => e === v)![1]}</span>} />
      <button type="button" className="docval" aria-label="Кусочки" title={`Кусочки: ${piecesWord}`} onClick={() => setPiecesOpen(true)}>
        <IconPuzzle size={15} />{picked.length > 0 && <><span className="w word">{piecesWord}</span><span className="n">{picked.length}</span></>}<AfterTurn on={d.later.includes("pieces")} brief />
      </button>
      {live && <CtxRing s={s} />}
      {live && <CacheClock s={s} />}
      <Page name="pieces" opened={piecesOpen} onClose={() => setPiecesOpen(false)} title={`Кусочки ${s.callsign}`}>
        <Stack gap="sm">
          {d.pieces.map((p) => (
            <Checkbox key={p.id} label={p.title ?? p.id} description={p.ok ? p.about : p.why} disabled={!p.ok} checked={picked.includes(p.id)}
              onChange={(e) => patchDoc(s, { pieces: e.currentTarget.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id) })} />
          ))}
        </Stack>
        <Button mt="md" style={{ alignSelf: "flex-start" }} onClick={() => setPiecesOpen(false)}>Готово</Button>
      </Page>
    </div>
  );
}

/** Занятость контекста кольцом, как в Claude: нажатие сжимает разговор; пока сжимает — кольцо пунктиром и слово «сжимаю».
 *  Сколько занято, машина называет в строке сессии с каждым ответом модели; окно модели — из каталога провайдера, который страница уже читает для выбора модели.
 *  У сессии страница ничего не спрашивает. */
function CtxRing({ s }: { s: SessionRow }) {
  const offers = useOffers();
  const size = s.cache?.size ?? 0;
  const window = offers.find((o) => o.key === (s.spec.key ?? CLAUDE) && o.model === (s.spec.model ?? ""))?.window;
  const pct = window ? Math.min(100, Math.round((size / window) * 100)) : 0;
  // каталог ещё не ответил или окна в нём нет — занятое называется числом токенов
  const said = window ? `${pct}%` : kilo(size);
  const r = 7, c = 2 * Math.PI * r;
  const word = s.compacting ? "Сжимаю контекст" : `Контекст ${said} · сжать`;
  return (
    <Tooltip label={word}>
      <button type="button" className={`ctxring${pct >= 85 ? " bad" : pct >= 65 ? " warn" : ""}`} aria-label={word} disabled={!!s.compacting} onClick={() => act(sessionCall, { to: s.callsign, method: "compact" })}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={r} className="track" />
          <circle cx="9" cy="9" r={r} className="arc" strokeDasharray={s.compacting ? "2.5 3" : `${(c * pct) / 100} ${c}`} transform="rotate(-90 9 9)" />
        </svg>
        <span>{s.compacting ? "сжимаю" : said}</span>
      </button>
    </Tooltip>
  );
}

const CACHE_HOUR = 60 * 60_000;

/** Кэш разговора из строки сессии. Срок известен — дуга показывает, сколько кэшу осталось быть тёплым; засечка на дуге — когда машина сожмёт разговор сама:
 *  оба часа называет машина, страница их не считает. Срока нет (провайдер его не называет, и на ключе он не задан) — дуга показывает, какую долю
 *  последнего запроса модель прочитала из кэша. Кэша нет (срок вышел, модель сменили, разговор ещё не начат) — пустое кольцо. */
function CacheClock({ s }: { s: SessionRow }) {
  // часы идут сами: раз в 20 секунд кольцо перерисовывается по нынешнему времени
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 20_000); return () => clearInterval(t); }, []);
  const now = Date.now();
  const until = s.cache?.until;
  const left = until ? until - now : 0;
  const timed = left > 0;
  // доля прочитанного из кэша — когда срока нет
  const share = s.cache && !until && s.cache.size ? Math.round(((s.cache.read ?? 0) / s.cache.size) * 100) : undefined;
  const warm = timed || !!share;
  const compact = timed ? s.cache!.compact : undefined;
  const r = 7, c = 2 * Math.PI * r;
  const word = timed ? `Кэш разговора тёплый до ${hhmm(until!)}${compact ? ` · в ${hhmm(compact)} разговор сожмётся сам` : ""}`
    : share !== undefined ? `Последний запрос прочитал из кэша ${share} %`
    : "Кэш разговора холодный: следующий ход запишет его заново";
  // засечка автосжатия: на том месте круга, где дуга окажется в час сжатия
  const a = (compact ? (until! - compact) / CACHE_HOUR : 0) * 2 * Math.PI - Math.PI / 2;
  const arc = timed ? Math.min(1, left / CACHE_HOUR) : (share ?? 0) / 100;
  return (
    <Tooltip label={word}>
      <span className={`cacheclock${warm ? "" : " cold"}${compact && compact - now <= 6 * 60_000 ? " soon" : ""}`} role="img" aria-label={word} data-cache={timed ? "warm" : share !== undefined ? "read" : "cold"}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={r} className="track" />
          {warm && <circle cx="9" cy="9" r={r} className="arc" strokeDasharray={`${c * arc} ${c}`} transform="rotate(-90 9 9)" />}
          {compact && <line className="notch" x1={9 + (r - 3) * Math.cos(a)} y1={9 + (r - 3) * Math.sin(a)} x2={9 + (r + 2) * Math.cos(a)} y2={9 + (r + 2) * Math.sin(a)} />}
        </svg>
        {timed ? <span className="w">{Math.ceil(left / 60_000)}</span> : share !== undefined && <span className="w">{share}%</span>}
      </span>
    </Tooltip>
  );
}

function save(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Все действия над разговором — в одном месте, значками в ряду под полем ввода: фокус, ведомый, инспектор, «ещё», очистить. */
function DocActs({ s, talk, offline, focus, onFocus, insp, onInsp }: { s: SessionRow; talk: Talk; offline: boolean; focus: boolean; onFocus(): void; /** инспектор этой сессии открыт */ insp: boolean; onInsp(): void }) {
  const prefs = useMyPrefs();
  const pins = (prefs.values.pins as string[] | undefined) ?? [];
  const pinned = pins.includes(s.callsign);
  const live = isLive(s) && !offline;
  const midTurn = s.state === "busy" || s.state === "waiting";
  return (
    <div className="docacts" role="group" aria-label="Действия">
      <Tooltip label={focus ? "Вся лента" : "Фокус: только итоги ходов"}><ActionIcon variant={focus ? "light" : "subtle"} color="gray" size="md" aria-label="Фокус" aria-pressed={focus} onClick={onFocus}><IconFocus2 size={16} /></ActionIcon></Tooltip>
      {live && !s.spec.wing && !s.lead && <Tooltip label="Открыть ведомого"><ActionIcon variant="subtle" color="gray" size="md" aria-label="Открыть ведомого" onClick={() => act(sessionUpdate, { to: s.callsign, patch: {}, pair: true })}><IconUserPlus size={16} /></ActionIcon></Tooltip>}
      {live && s.spec.wing && <Tooltip label="Убрать ведомого"><ActionIcon variant="subtle" color="gray" size="md" aria-label="Убрать ведомого" onClick={() => confirmDanger({ title: `Убрать ведомого ${s.spec.wing}?`, body: `${s.spec.wing} перестанет получать задачи от ${s.callsign}, и его сессия будет убрана с машины. Точки в архиве останутся.`, confirm: "Убрать ведомого", onConfirm: () => void patchDoc(s, { wing: null }) })}><IconUserMinus size={16} /></ActionIcon></Tooltip>}
      <Tooltip label="Инспектор (I)"><ActionIcon variant={insp ? "light" : "subtle"} color="gray" size="md" aria-label="Инспектор" aria-pressed={insp} onClick={onInsp}><IconLayoutSidebarRight size={16} /></ActionIcon></Tooltip>
      <Menu position="top-end" withinPortal>
        <Menu.Target><ActionIcon variant="subtle" color="gray" size="md" aria-label="Ещё"><IconDots size={16} /></ActionIcon></Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => prefs.save("pins", pinned ? pins.filter((p) => p !== s.callsign) : [...pins, s.callsign])}>{pinned ? "Открепить" : "Закрепить"}</Menu.Item>
          <Menu.Item onClick={() => save(`${s.callsign}.md`, exportMd(s.callsign, talk.view))}>Выгрузить разговор в Markdown</Menu.Item>
          {live && <Menu.Item onClick={() => act(sessionStop, { to: s.callsign })}>Остановить сессию</Menu.Item>}
          <Menu.Item color="red" disabled={offline} onClick={() => confirmDanger({
            title: `Убрать ${s.callsign}?`, body: midTurn ? "Идёт ход: сессия уйдёт с машины, когда он кончится. Точки в архиве останутся." : "Сессия уйдёт с машины. Точки в архиве останутся.",
            confirm: midTurn ? "Убрать после хода" : "Убрать", onConfirm: () => act(sessionRemove, { to: s.callsign, ...(midTurn ? { after_turn: true } : {}) }, midTurn ? "Сессия уберётся после хода" : undefined),
          })}>Убрать сессию</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {live && <Tooltip label="Очистить разговор"><ActionIcon variant="subtle" color="gray" size="md" className="far" aria-label="Очистить" onClick={() => confirmDanger({ title: `Очистить разговор ${s.callsign}?`, body: "Разговор начнётся заново: сессия забудет всё, что было сказано. Файлы останутся как есть.", confirm: "Очистить", onConfirm: async () => void (await act(sessionRewind, { to: s.callsign })) })}><IconEraser size={16} /></ActionIcon></Tooltip>}
    </div>
  );
}

const nowWord = (x: SessionRow, offline: boolean): string => {
  const now = x.compacting ? "сжимает контекст" : (x.doing ?? STATE_WORD[x.state]);
  return offline ? `нет связи · было: ${now}` : now;
};

/** Шапка пары — одна на обоих: два участника с лампой, именем и тем, чем занят. Нажатие на участника показывает только его; на показанного ещё раз — обе стороны. */
function PairBar({ lead, wing, shown, both, onPick, onBack }: { lead: SessionRow; wing: SessionRow; /** позывной показанной стороны */ shown: string; both: boolean; onPick(callsign: string): void; onBack?: () => void }) {
  const offline = useFleet((f) => f.machines[machineOfCall(lead.callsign)]?.online === false);
  const labels = useLabels();
  const cell = (x: SessionRow, word: string) => {
    const on = both || shown === x.callsign;
    return (
      <div className={`pm${on ? " on" : ""}`}>
        <button type="button" className="pm-who" aria-pressed={on} aria-label={`${word} ${x.callsign}`} title={word} onClick={() => onPick(x.callsign)}>
          <Lamp state={x.state} offline={offline} />
          <span className="pm-t"><b className="trunc">{labels.of(x.callsign) ?? x.title ?? x.spec.name}</b><span className="trunc muted"><span className="mono">{x.callsign}</span> · {nowWord(x, offline)}</span></span>
        </button>
        {!isLive(x) && !offline && <Button size="compact-xs" leftSection={<IconPlayerPlay size={13} />} onClick={() => act(sessionStart, { to: x.callsign })}>Запустить</Button>}
      </div>
    );
  };
  return (
    <div className="pairbar" role="group" aria-label="Пара">
      {onBack && <ActionIcon variant="subtle" className="narrow-only" aria-label="Назад" onClick={onBack}><IconArrowLeft size={18} /></ActionIcon>}
      {cell(lead, "Ведущий")}
      {cell(wing, "Ведомый")}
    </div>
  );
}

/** Имя сессии для людей: нажатие на заголовок превращает его в поле на том же месте; Enter записывает, Esc отменяет, пустое имя снимает его. Запись — общая для флота. */
function NameButton({ s, shown }: { s: SessionRow; shown: string }) {
  const labels = useLabels();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState("");
  const put = async () => {
    setOpen(false);
    if (v.trim() === (labels.of(s.callsign) ?? "")) return;
    if (await act(prefsSet, { scope: "fleet", name: "labels", patch: { [s.callsign]: v.trim() || null } }, v.trim() ? "Имя записано" : "Имя снято")) await qc.invalidateQueries({ queryKey: ["prefs.get"] });
  };
  if (open) return (
    <TextInput size="xs" autoFocus aria-label={`Имя для ${s.callsign}`} placeholder={s.title ?? s.spec.name} value={v} onChange={(e) => setV(e.currentTarget.value)} onBlur={() => void put()}
      onKeyDown={(e) => (e.key === "Enter" ? void put() : e.key === "Escape" ? setOpen(false) : undefined)} />
  );
  return <button type="button" className="namebtn trunc" title="Назвать сессию" onClick={() => (setV(labels.of(s.callsign) ?? ""), setOpen(true))}>{shown}</button>;
}

export type Side = "lead" | "wing" | "both";

/** Шапка разговора: кто это и чем занят. Действий в ней нет — они в ряду под полем ввода; исключения — «назад» на телефоне и «Запустить» у стоящей сессии. */
function Header({ s, onBack }: { s: SessionRow; onBack?: () => void }) {
  const offline = useFleet((f) => f.machines[machineOfCall(s.callsign)]?.online === false);
  const labels = useLabels();
  const tree = s.spec.parent ? `задача от ${labels.name(s.spec.parent)}` : "";
  return (
    <div className="pane-head conv-head">
      {onBack && <ActionIcon variant="subtle" className="narrow-only" aria-label="Назад" onClick={onBack}><IconArrowLeft size={18} /></ActionIcon>}
      <Lamp state={s.state} offline={offline} />
      <div className="h-title">
        <NameButton s={s} shown={labels.of(s.callsign) ?? s.title ?? s.spec.name} />
        <div className="trunc muted" style={{ fontSize: 12.5 }}><span className="mono">{s.callsign}</span> · {nowWord(s, offline)}{tree ? ` · ${tree}` : ""}</div>
      </div>
      {!isLive(s) && !offline && <Button size="xs" leftSection={<IconPlayerPlay size={14} />} onClick={() => act(sessionStart, { to: s.callsign })}>Запустить</Button>}
    </div>
  );
}

/** Карточки состояния: почему сессия стоит или чего ждёт. */
function StateCards({ s, onWhy }: { s: SessionRow; onWhy(): void }) {
  return (
    <>
      {s.state === "failed" && (
        <div className="statecard bad">
          <Text fw={600} size="sm">Сессия не запустилась</Text>
          {s.error && <Text size="sm">{s.error}</Text>}
          <Group gap="xs"><Button size="compact-xs" variant="default" onClick={() => act(sessionStart, { to: s.callsign })}>Запустить</Button><Button size="compact-xs" variant="subtle" onClick={onWhy}>Почему</Button></Group>
        </div>
      )}
      {s.wait && <div className="statecard"><Text fw={600} size="sm">Ждёт сброса лимита</Text><Text size="sm">Годных аккаунтов Claude нет. Сессия продолжит {day(s.wait)} в {hhmm(s.wait)}.</Text></div>}
      {s.archiveError && <div className="statecard bad"><Text fw={600} size="sm">Последняя точка не сохранилась</Text><Text size="sm">{s.archiveError}</Text></div>}
    </>
  );
}

/** Шаг отката: что уйдёт — видно до нажатия; после — текст ушедшего сообщения возвращается в поле ввода. */
function Rewind({ s, upto, onDone }: { s: SessionRow; upto: string; onDone(text?: string): void }) {
  const [what, setWhat] = useState<"talk" | "both">("talk");
  const files = what === "both";
  // проба одна на оба варианта: число записей от выбора не зависит, список файлов показывается при «Разговор и файлы»
  const dry = useCall(sessionRewind, { to: s.callsign, upto, files: true, dry: true });
  const midTurn = s.state === "busy" || s.state === "waiting" || s.state === "starting";
  const d = dry.data;
  return (
    <Stack gap="sm">
      <SegmentedControl value={what} onChange={(v) => setWhat(v as "talk" | "both")} data={[{ value: "talk", label: "Только разговор" }, { value: "both", label: "Разговор и файлы", disabled: !!dry.data?.nofiles }]} aria-label="Что откатить" />
      {dry.error ? <Failed error={dry.error} /> : !d ? <Loader size="sm" /> : (
        <>
          {d.text && <div className="me" style={{ alignSelf: "stretch", maxWidth: "none" }}><Text size="sm" className="clamp2">{d.text}</Text></div>}
          <Text size="sm">Из разговора уйдёт записей: <b>{d.cut}</b>{d.text ? " — это сообщение и всё после него. Его текст вернётся в поле ввода." : "."}</Text>
          {midTurn && <Text size="sm" c="orange" role="note">Текущий ход прервётся</Text>}
          {d.nofiles && <Text size="sm" role="note">Файлы к этому сообщению не вернуть: {d.nofiles}</Text>}
          {files && (
            <div className="card" style={{ gap: 2 }}>
              <Text size="sm" fw={600}>Файлы вернутся к состоянию до этого сообщения · <span style={{ color: "var(--st-idle)" }}>+{d.plus ?? 0}</span> <span style={{ color: "var(--st-failed)" }}>−{d.minus ?? 0}</span></Text>
              {(d.files ?? []).map((f) => <div key={f} className="line mono" style={{ fontSize: 12.5 }}>{f}</div>)}
              {!d.files?.length && <Text size="sm" className="muted">Файлы с этого сообщения не менялись</Text>}
            </div>
          )}
        </>
      )}
      <Group gap="sm">
        <Button color="red" disabled={!d} onClick={async () => { const r = await act(sessionRewind, { to: s.callsign, upto, files }); if (r) onDone(r.text); }}>Откатить</Button>
        <Button variant="default" onClick={() => onDone()}>Отмена</Button>
      </Group>
    </Stack>
  );
}

function FeedPane({ s, talk, focus, onFocus, insp, onInsp, autoFocus, pair, onWhy }: { s: SessionRow; talk: Talk; focus: boolean; onFocus(): void; insp: boolean; onInsp(): void; autoFocus?: boolean; pair?: boolean; onWhy(): void }) {
  const machine = machineOfCall(s.callsign);
  const m = useFleet((f) => f.machines[machine]);
  const me = useFleet((f) => f.you?.person);
  const offline = m?.online === false;
  const labels = useLabels();
  useMarkRead(s.callsign);
  const box = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const [stuck, setStuck] = useState(true);
  const [rewindAt, setRewindAt] = useState<string | null>(null);
  const [drop, setDrop] = useState(false);
  const [modelAsk, setModelAsk] = useState<{ n: number; q: string }>();
  const stick = useRef(true);
  const items = useMemo(() => (focus ? focused(talk.view) : talk.view.rows), [focus, talk.view]);
  const toLast = () => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setStuck(true);
  };
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [talk.events, talk.loading, talk.asides]);
  // вопрос сессии стоит карточками в конце ленты: лента встаёт на первый неотвеченный и больше сама вниз не едет
  useEffect(() => {
    const el = box.current, card = el?.querySelector<HTMLElement>("[data-ask][data-open]");
    if (!el || !card || talk.loading) return;
    stick.current = false;
    el.scrollTop = Math.max(0, card.offsetTop - 12);
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, [s.ask?.id, talk.loading]);
  const todos = talk.view.todos?.some((t) => t.status !== "completed") ? talk.view.todos : undefined;
  const live = isLive(s) && !offline;
  const env = useMemo<FeedEnv>(() => ({
    canAct: live, me, waiting: s.ask?.id,
    act: (method, args) => void act(sessionCall, { to: s.callsign, method, args }, method === "tasks" ? "Ушло в фон" : "Остановлено"),
    // снятое с очереди сообщение возвращает свой текст в поле ввода
    cancel: (id) => void talk.cancel(id).then((text) => text && composer.current?.giveBack(text)), resend: talk.resend, drop: talk.drop,
    edit: (text) => composer.current?.setText(text),
    rewind: setRewindAt,
    name: labels.name,
  }), [live, me, s.ask?.id, s.callsign, talk.cancel, talk.resend, talk.drop, labels.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const acts = <DocActs s={s} talk={talk} offline={offline} focus={focus} onFocus={onFocus} insp={insp} onInsp={onInsp} />;
  return (
    <>
      <div className="feed-wrap">
        <div className={`feed${drop ? " drop" : ""}`} ref={box}
          onScroll={(e) => { const el = e.currentTarget; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80; stick.current = near; setStuck(near); }}
          onDragOver={(e) => live && e.dataTransfer.types.includes("Files") && (e.preventDefault(), setDrop(true))}
          onMouseUp={() => pair && window.getSelection()?.isCollapsed !== false && composer.current?.focus()}
          onDragLeave={() => setDrop(false)}
          onDrop={(e) => { if (!live || !e.dataTransfer.files.length) return; e.preventDefault(); setDrop(false); composer.current?.addFiles([...e.dataTransfer.files]); }}>
          <div className="feed-in">
            {offline && (
              <div className="ban">
                <Text fw={600} size="sm">Машина {machine} без связи с {hhmm(m!.since)}</Text>
                <Text size="sm">Сессией нельзя управлять, пока машина не вернётся. <Link to={`/machine/${machine}`}>Что известно о машине</Link></Text>
              </div>
            )}
            {talk.more && <Button variant="subtle" size="xs" onClick={talk.loadMore} style={{ alignSelf: "center" }}>Раньше</Button>}
            <FeedEnvProvider value={env}>
              {talk.loading ? <Loader size="sm" style={{ alignSelf: "center" }} /> : talk.error ? <Failed error={talk.error} /> : !items.length && live ? <Text size="sm" className="muted" ta="center">Сообщений пока нет</Text> : <Rows rows={items} view={talk.view} />}
            </FeedEnvProvider>
            {live && <Tail view={talk.view} compacting={s.compacting} />}
            <StateCards s={s} onWhy={onWhy} />
            {s.ask && !offline && <AskCard key={s.ask.id} callsign={s.callsign} ask={s.ask} />}
          </div>
        </div>
        {!stuck && <Button className="to-last" size="compact-sm" variant="default" leftSection={<IconArrowDown size={14} />} onClick={toLast}>К последнему</Button>}
      </div>
      <Page name="rewind" opened={!!rewindAt} onClose={() => setRewindAt(null)} title={`Откатить ${s.callsign}`}>
        {rewindAt && <Rewind s={s} upto={rewindAt} onDone={(text) => (setRewindAt(null), text && composer.current?.setText(text))} />}
      </Page>
      <div className="dock">
        <div className="dock-in">
          {!offline && todos && <TodoList todos={todos} fold />}
          {live && <FeedEnvProvider value={env}><Running callsign={s.callsign} view={talk.view} /></FeedEnvProvider>}
          {!offline && <Asides asides={talk.asides} drop={talk.dropAside} />}
          {/* машина без связи: писать некому, но инспектор и «ещё» остаются под рукой */}
          {offline
            ? <div className="composer-opts">{acts}</div>
            : <Composer ref={composer} s={s} talk={talk} hint={s.state === "idle" ? talk.view.hint : undefined} autoFocus={autoFocus} values={<DocValues s={s} ask={modelAsk} />} acts={acts} onModel={(q) => setModelAsk((a) => ({ n: (a?.n ?? 0) + 1, q }))} />}
        </div>
      </div>
    </>
  );
}

/** Один разговор: шапка и лента. У пары шапка общая — bare. */
function Column({ s, pair, primary, bare, onBack, insp, onInsp, onWhy, onView }: { s: SessionRow; pair?: boolean; primary?: boolean; bare?: boolean; onBack?: () => void; insp: boolean; onInsp(): void; onWhy(): void; onView?(talk: Talk): void }) {
  const talk = useTalk(s.callsign);
  const [focus, setFocus] = useState(false);
  useEffect(() => onView?.(talk), [talk.view]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="conv" data-conv={s.callsign}>
      {!bare && <Header s={s} onBack={onBack} />}
      <FeedPane key={s.callsign} s={s} talk={talk} focus={focus} onFocus={() => setFocus((f) => !f)} insp={insp} onInsp={onInsp} autoFocus={primary && pair} pair={pair} onWhy={onWhy} />
    </div>
  );
}

/** Пара сессии: позывные ведущего и ведомого, если оба есть в картине. */
export function pairOf(sessions: Record<string, SessionRow>, callsign: string): { lead: string; wing: string } | null {
  const x = sessions[callsign];
  if (!x) return null;
  const lead = x.spec.wing ? x.callsign : (x.lead ?? (x.spec.parent && sessions[x.spec.parent]?.spec.wing === callsign ? x.spec.parent : undefined));
  const wing = lead ? sessions[lead]?.spec.wing ?? (lead !== callsign ? callsign : undefined) : undefined;
  return lead && wing && sessions[lead] && sessions[wing] ? { lead, wing } : null;
}
/** Где устройство помнит, какую сторону пары человек смотрел последней. */
export const pairKey = (lead: string) => "pair." + lead;

export function Conversation({ callsign, onBack }: { callsign: string; onBack?: () => void }) {
  const s = useFleet((f) => f.sessions[callsign]);
  const duo = useFleet((f) => { const p = pairOf(f.sessions, callsign); return p ? `${p.lead} ${p.wing}` : ""; });
  const [leadCall = "", wingCall = ""] = duo.split(" ");
  const other = useFleet((f) => (duo ? f.sessions[callsign === leadCall ? wingCall : leadCall] : undefined));
  const ui = useUi();
  const wide = useWide();
  const go = useNavigate();
  const here = useLocation().pathname;
  // какую сторону пары показать, помнит устройство: «обе» — два разговора рядом, иначе — тот, что в адресе
  const [stored, setStored] = useLocal<Side>(pairKey(leadCall || "-"), "lead");
  // при виде «обе» инспектор открывается у одной стороны: вторая остаётся участником в шапке, закрытие возвращает обе
  const [inspSide, setInspSide] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState("doc");
  const [talk, setTalk] = useState<Talk | null>(null);
  useEffect(() => (setSheet(false), setTab("doc")), [callsign]);
  useEffect(() => setInspSide(null), [leadCall]);
  const both = !!other && stored === "both" && wide;
  const inspOn = wide && (both ? inspSide !== null : ui.inspector);
  const showPair = both && !inspOn;
  const split = useSplit({ key: "insp.w", initial: 336, min: 280, rest: 420, right: true, cssVar: "--insp", label: "Ширина инспектора" }, inspOn);
  if (!s) return <div className="hole">Такой сессии нет: <span className="mono">&nbsp;{callsign}</span></div>;
  // один разговор на экране: тот, что в адресе; при «обе» с инспектором — сторона, чей инспектор открыт
  const shown = both && inspOn && other && inspSide === other.callsign ? other : s;
  const pick = (cs: string) => {
    if (both && inspOn) return setInspSide(cs === shown.callsign ? null : cs);
    if (wide && !both && cs === callsign) return setStored("both");
    setStored(cs === wingCall ? "wing" : "lead");
    if (cs !== callsign) go(here.replace(/[^/]+$/, cs));
  };
  const openInsp = (cs: string) => (!wide ? setSheet(true) : both ? setInspSide(cs) : ui.set({ inspector: true }));
  const toggleInsp = (cs: string) => (!wide ? setSheet(true) : both ? setInspSide(inspSide === cs ? null : cs) : ui.set({ inspector: !ui.inspector }));
  const why = (cs: string) => (setTab("log"), openInsp(cs));
  const inspector = (of: SessionRow) => <Inspector s={of} other={of === s ? other : s} view={talk?.view} tab={tab} onTab={setTab} />;
  // пара рядом: ведущий слева, ведомый справа
  const left = showPair && other && callsign === wingCall ? other : shown;
  const right = showPair && other ? (left === s ? other : s) : undefined;
  const col = (x: SessionRow) => (
    <Column key={x.callsign} s={x} primary={x === s} pair={showPair} bare={!!other} onBack={onBack} insp={inspOn && shown === x} onInsp={() => toggleInsp(x.callsign)} onWhy={() => why(x.callsign)} onView={x === (showPair ? s : shown) ? setTalk : undefined} />
  );
  return (
    <>
      {other && <PairBar lead={callsign === leadCall ? s : other} wing={callsign === leadCall ? other : s} shown={shown.callsign} both={showPair} onPick={pick} onBack={onBack} />}
      <div ref={split.box} className={`talk${showPair ? " pair" : inspOn ? " with-insp" : ""}${split.pulling ? " pulling" : ""}`} style={split.style}>
        {col(left)}
        {right && col(right)}
        {inspOn && <aside className="insp" aria-label="Инспектор">{inspector(shown)}</aside>}
        {split.edge}
        {!wide && <Page name="info" opened={sheet} onClose={() => setSheet(false)} title={s.callsign}>{inspector(s)}</Page>}
      </div>
    </>
  );
}
