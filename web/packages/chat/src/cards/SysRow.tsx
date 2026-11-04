// Служебные строки ленты: итог хода, сжатие, прерывание, повтор API, лимит, команда, ошибки, задачи, отказ модели, хук, память, файлы.
import type { ReactNode } from "react";
import { AlertTriangle, Anchor, Archive, ArrowLeftRight, Ban, BookOpen, Bot, FileUp, Gauge, Info, Pencil, RefreshCw, RotateCcw, ShieldOff, Shuffle, Sparkles, Square, Terminal, X, Zap } from "lucide-react";
import { hhmm } from "@switchboard/web-ui";
import { useCards } from "../context.ts";
import type { Sys, Task } from "../state/types.ts";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { baseName, duration, kTokens, modelName, money, steps } from "./format.ts";

type Of<T extends Sys["type"]> = Extract<Sys, { type: T }>;

/** Плашка: красная или жёлтая. */
function Banner({ tone, icon, title, text, children }: { tone: "bad" | "wait"; icon: ReactNode; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className={`chat-ban ${tone}`} role={tone === "bad" ? "alert" : undefined}>
      {icon}
      <div>
        <b>{title}</b>
        {text ? <p>{text}</p> : null}
        {children}
      </div>
    </div>
  );
}

/** Линия во всю ширину с подписью посередине. */
const Divider = ({ icon, text, tone }: { icon: ReactNode; text: string; tone?: string }) => (
  <div className={tone ? `chat-sys ${tone}` : "chat-sys"}>
    {icon}
    {text}
  </div>
);

const Line = ({ icon, tone, children }: { icon: ReactNode; tone?: string; children: ReactNode }) => (
  <div className={tone ? `chat-line ${tone}` : "chat-line"}>
    {icon}
    <span>{children}</span>
  </div>
);

const LIMIT: Record<string, string> = { five_hour: "окно 5 часов", seven_day: "неделя", seven_day_opus: "неделя Opus", seven_day_sonnet: "неделя Sonnet", overage: "сверх подписки" };
/** Почему основная модель не ответила. */
const FALLBACK: Record<string, string> = { model_not_found: "недоступна", permission_denied: "недоступна организации", overloaded: "перегружена", server_error: "не ответила (сбой сервера)", last_resort: "не ответила (ошибка)", model_blocked: "временно отключена" };
const AREA: Record<string, string> = { cyber: "кибербезопасность", bio: "биология и химия", chem: "химия", weapons: "оружие", self_harm: "самоповреждение" };
const TASK_END: Record<string, [string, string]> = { completed: ["завершена", "ok"], failed: ["упала", "bad"], stopped: ["остановлена", "wait"], killed: ["оборвана", "wait"] };

/** Почему оборвался ход: подтипы result у SDK; незнакомый — как есть. */
const RESULT: Record<string, string> = { error_during_execution: "сбой при выполнении", error_max_turns: "предел шагов", error_max_budget_usd: "предел бюджета", error_max_structured_output_retries: "предел повторов ответа" };

function ResultRow({ sys }: { sys: Of<"result"> }) {
  if (!sys.ok) {
    return (
      <div className="chat-res err">
        <AlertTriangle size={13} />
        {`ход оборвался: ${RESULT[sys.subtype ?? ""] ?? sys.subtype ?? "ошибка"}`}
        {sys.error ? <p>{sys.error}</p> : null}
      </div>
    );
  }
  const bits = ["ход закончен", sys.ms ? duration(sys.ms) : null, typeof sys.turns === "number" ? steps(sys.turns) : null, typeof sys.cost === "number" ? money(sys.cost) : null, sys.tokens ? `${kTokens(sys.tokens)} в контексте` : null];
  return <div className="chat-res">{bits.filter(Boolean).join(" · ")}</div>;
}

function CompactRow({ sys }: { sys: Of<"compact"> }) {
  const line = `контекст сжат${sys.pre !== undefined ? ` · ${kTokens(sys.pre)}${sys.post ? ` → ${kTokens(sys.post)}` : ""}` : ""}`;
  if (!sys.summary) return <Divider icon={<Archive size={13} />} text={line} />;
  return (
    <Disclosure
      className="chat-sum"
      title={
        <>
          <Archive size={13} />
          {line}
        </>
      }
    >
      <Markdown text={sys.summary} />
    </Disclosure>
  );
}

function CommandRow({ sys }: { sys: Of<"command"> }) {
  // вывод без имени команды (смена модели на лету) — серой строкой
  if (!sys.name) return <Line icon={<Zap size={13} />}>{sys.output}</Line>;
  return (
    <div className="chat-cmd">
      <span>
        <Zap size={12} />
        {sys.args ? `${sys.name} ${sys.args}` : sys.name}
      </span>
      {sys.output ? <pre>{sys.output}</pre> : null}
    </div>
  );
}

/** Задача без вызова инструмента: идёт — со «Стоп»; конец фоновой — чем кончилась. */
function TaskRow({ sys }: { sys: Of<"task"> }) {
  const v = useCards();
  const task: Task | undefined = v.useFeed((f) => (sys.id ? f.tasks[sys.id] : undefined));
  const status = task?.status ?? sys.status;
  const agent = (task?.type ?? sys.kind) === "local_agent";
  const icon = agent ? <Bot size={13} /> : <Terminal size={13} />;
  if (status === "running") {
    return (
      <div className="chat-line run">
        {icon}
        <span>{[task?.description ?? sys.description, task?.summary].filter(Boolean).join(" · ")}</span>
        <em>{`${task?.toolUses ?? 0} ${steps(task?.toolUses ?? 0).split(" ")[1]}`}</em>
        {v.stopTask && sys.id ? (
          <button type="button" className="chat-mini" onClick={() => v.stopTask!(sys.id!)}>
            <Square size={11} />
            Стоп
          </button>
        ) : null}
      </div>
    );
  }
  const [word, tone] = TASK_END[status] ?? TASK_END.completed;
  return (
    <Line icon={icon} tone={tone}>
      {`Задача ${word}`}
      {sys.description ? <span className="chat-dim">{` · ${sys.description}`}</span> : null}
    </Line>
  );
}

function RefusalRow({ sys }: { sys: Of<"refusal"> }) {
  const v = useCards();
  const from = modelName(sys.from) || "Модель";
  const why = [sys.category ? `Область: ${AREA[sys.category] ?? sys.category}` : null, sys.text?.trim()].filter(Boolean).join(". ");
  if (sys.to) return <Banner tone="wait" icon={<ShieldOff size={15} />} title={`${from} отказалась — ответ переписан моделью ${modelName(sys.to)}`} text={[sys.local ? "Только этот ответ: модель сессии прежняя." : `Дальше сессия идёт на ${modelName(sys.to)}.`, why].filter(Boolean).join(" ")} />;
  return (
    <Banner tone="bad" icon={<ShieldOff size={15} />} title={`${from} отказалась отвечать`} text={why || undefined}>
      {sys.ask && v.edit ? (
        <button type="button" className="chat-mini" onClick={() => v.edit!(sys.ask!)}>
          <Pencil size={12} />
          Изменить сообщение
        </button>
      ) : null}
    </Banner>
  );
}

export function SysRow({ sys, at }: { sys: Sys; at?: number }) {
  switch (sys.type) {
    case "result":
      return <ResultRow sys={sys} />;
    case "compact":
      return <CompactRow sys={sys} />;
    case "interrupted":
      return <Divider icon={<Square size={11} />} text={`прервано${at ? ` · ${hhmm(at)}` : ""}`} tone="wait" />;
    case "retry":
      return <Divider icon={<RefreshCw size={13} />} text={`повтор запроса к API · ${sys.attempt ?? "?"} из ${sys.max ?? "?"}${sys.error ? ` · ${sys.error}` : ""}${sys.delayMs ? ` · через ${Math.round(sys.delayMs / 1000)} с` : ""}`} tone="wait" />;
    case "limits":
      return <Banner tone="wait" icon={<Gauge size={15} />} title={sys.status === "rejected" ? "Лимит подписки исчерпан" : "Лимит подписки скоро кончится"} text={[sys.window ? (LIMIT[sys.window] ?? sys.window) : null, sys.resets ? `сброс в ${hhmm(sys.resets * 1000)}` : null].filter(Boolean).join(", ") || undefined} />;
    case "command":
      return <CommandRow sys={sys} />;
    case "error":
      return <Banner tone="bad" icon={<X size={15} />} title="Ошибка" text={sys.text} />;
    case "model":
      return <Divider icon={<Sparkles size={13} />} text={`модель: ${sys.from ? `${modelName(sys.from)} → ` : ""}${modelName(sys.to)}`} />;
    case "task":
      return <TaskRow sys={sys} />;
    case "info":
      return sys.warn ? <Banner tone="wait" icon={<Info size={15} />} title={sys.text} /> : <Line icon={<Info size={13} />}>{sys.text}</Line>;
    case "denied":
      return (
        <Line icon={<Ban size={13} />}>
          {`Отклонено правилами: ${sys.tool}`}
          {sys.message ? ` — ${sys.message}` : ""}
        </Line>
      );
    case "reset":
      return <Divider icon={<RotateCcw size={13} />} text="разговор начат заново" />;
    case "refusal":
      return <RefusalRow sys={sys} />;
    case "fallback":
      return <Banner tone="wait" icon={<Shuffle size={15} />} title={`${modelName(sys.from) || "Модель"} ${FALLBACK[sys.trigger ?? ""] ?? "не ответила"} — этот ход отвечает ${modelName(sys.to)}`} />;
    case "hook":
      return (
        <Line icon={<Anchor size={13} />} tone="wait">
          {`Хук ${sys.name} не сработал${sys.code != null ? ` (код ${sys.code})` : ""}`}
          {sys.text ? <span className="chat-dim">{`: ${sys.text.slice(0, 300)}`}</span> : null}
        </Line>
      );
    case "memory":
      return <Line icon={<BookOpen size={13} />}>{`Из памяти: ${sys.paths.map(baseName).join(", ")}`}</Line>;
    case "files":
      return (
        <Line icon={<FileUp size={13} />} tone={sys.failed.length ? "bad" : undefined}>
          {[sys.saved.length ? `Файлы сохранены: ${sys.saved.join(", ")}` : null, sys.failed.length ? `Не сохранились: ${sys.failed.join(", ")}` : null].filter(Boolean).join(" · ")}
        </Line>
      );
    case "swap":
      return <Divider icon={<ArrowLeftRight size={13} />} text={`аккаунт: ${sys.from} → ${sys.to}`} tone="swap" />;
  }
}
