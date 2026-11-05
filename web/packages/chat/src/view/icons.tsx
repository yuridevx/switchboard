// Значки ленты по имени: имя приходит из свёртки и слов, компонент — отсюда.
import {
  Anchor, Archive, ArrowDown, ArrowDownToLine, Ban, Bell, BookOpen, Bot, BrainCircuit, Check, ChevronDown, Circle, CircleCheck, CircleDot, ClipboardList, Clock, Eye, FilePen, FilePlus, FileText, FileUp,
  Focus, FolderSearch, Gauge, GitBranch, Globe, Info, Layers, ListChecks, ListCollapse, LoaderCircle, MessageCircleQuestion, MessagesSquare, Plug, RefreshCw, Repeat, RotateCcw, Search, ShieldOff, Shuffle, Sparkles,
  Square, Terminal, TriangleAlert, Wrench, X, Zap, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  anchor: Anchor, archive: Archive, "arrow-down": ArrowDown, "arrow-down-to-line": ArrowDownToLine, ban: Ban, bell: Bell, "book-open": BookOpen, bot: Bot, "brain-circuit": BrainCircuit, check: Check, "chevron-down": ChevronDown,
  circle: Circle, "circle-check": CircleCheck, "circle-dot": CircleDot, "clipboard-list": ClipboardList, clock: Clock, eye: Eye, "file-pen": FilePen, "file-plus": FilePlus, "file-text": FileText, "file-up": FileUp,
  focus: Focus, "folder-search": FolderSearch, gauge: Gauge, "git-branch": GitBranch, globe: Globe, info: Info, layers: Layers, "list-checks": ListChecks, "list-collapse": ListCollapse, "loader-circle": LoaderCircle,
  "message-circle-question": MessageCircleQuestion, "messages-square": MessagesSquare, plug: Plug, "refresh-cw": RefreshCw, repeat: Repeat, "rotate-ccw": RotateCcw, search: Search, "shield-off": ShieldOff,
  shuffle: Shuffle, sparkles: Sparkles, square: Square, terminal: Terminal, "triangle-alert": TriangleAlert, wrench: Wrench, x: X, zap: Zap,
};

/** Квадрат остановки — меньше прочих, как кнопка «Стоп». */
export function Icon({ name, size = 13 }: { name: string; size?: number }) {
  const C = ICONS[name] ?? Wrench;
  return <C size={name === "square" ? 11 : size} aria-hidden="true" />;
}
