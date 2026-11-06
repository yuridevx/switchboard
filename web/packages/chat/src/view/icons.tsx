// Значки ленты по имени: имя приходит из свёртки и таблицы инструментов, компонент — отсюда.
import {
  Anchor, Archive, ArrowDown, ArrowDownToLine, ArrowLeftRight, ArrowUp, AtSign, Ban, Bell, BookOpen, Bot, BrainCircuit, CalendarClock, Check, ChevronDown, ChevronRight, ChevronUp, Circle, CircleCheck, CircleDot,
  ClipboardList, Download, FilePen, FilePlus, FileText, FileUp, Focus, FolderSearch, Gauge, GitBranch, Globe, History, Info, Layers, Lightbulb, ListChecks, ListCollapse, LoaderCircle, MessageCircleQuestion,
  MessageSquareQuote, MessagesSquare, NotebookPen, Paperclip, Pencil, Radar, RefreshCw, RotateCcw, RotateCw, Search, ShieldOff, Shuffle, Slash, Sparkles, Square, Terminal, TriangleAlert, Undo2, Wrench, X, Zap,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  anchor: Anchor, archive: Archive, "arrow-down": ArrowDown, "arrow-down-to-line": ArrowDownToLine, "arrow-left-right": ArrowLeftRight, "arrow-up": ArrowUp, "at-sign": AtSign, ban: Ban, bell: Bell, "book-open": BookOpen,
  bot: Bot, "brain-circuit": BrainCircuit, "calendar-clock": CalendarClock, check: Check, "chevron-down": ChevronDown, "chevron-right": ChevronRight, "chevron-up": ChevronUp, circle: Circle, "circle-check": CircleCheck,
  "circle-dot": CircleDot, "clipboard-list": ClipboardList, download: Download, "file-pen": FilePen, "file-plus": FilePlus, "file-text": FileText, "file-up": FileUp, focus: Focus, "folder-search": FolderSearch, gauge: Gauge,
  "git-branch": GitBranch, globe: Globe, history: History, info: Info, layers: Layers, lightbulb: Lightbulb, "list-checks": ListChecks, "list-collapse": ListCollapse, "loader-circle": LoaderCircle,
  "message-circle-question": MessageCircleQuestion, "message-square-quote": MessageSquareQuote, "messages-square": MessagesSquare, "notebook-pen": NotebookPen, paperclip: Paperclip, pencil: Pencil, radar: Radar,
  "refresh-cw": RefreshCw, "rotate-ccw": RotateCcw, "rotate-cw": RotateCw, search: Search, "shield-off": ShieldOff, shuffle: Shuffle, slash: Slash, sparkles: Sparkles, square: Square, terminal: Terminal,
  "triangle-alert": TriangleAlert, "undo-2": Undo2, wrench: Wrench, x: X, zap: Zap,
};

/** Квадрат остановки — меньше прочих, как кнопка «Стоп». */
export function Icon({ name, size = 13 }: { name: string; size?: number }) {
  const C = ICONS[name] ?? Wrench;
  return <C size={name === "square" ? 11 : size} aria-hidden="true" />;
}
