// HTML и SVG в песочнице и узнавание HTML-документа: общее для блока кода в ответе и для просмотра записанного файла. Лёгкий файл: Markdown грузится отдельным куском.
import { isValidElement, useState, type ReactNode } from "react";

/** Текст узлов React: код блока после подсветки — дерево, а копируется текст. */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement(node) ? textOf((node.props as { children?: ReactNode }).children) : "";
}

/** Документ HTML в песочнице: скрипты идут, но у рамки свой пустой источник — до страницы, её хранилища и пропуска ей не достать.
 *  Документ ушёл на другую страницу (вторая загрузка рамки) — рамка снимается: чужая страница здесь не показывается. «Показать снова» возвращает документ. */
export function HtmlFrame({ html, title = "Просмотр HTML" }: { html: string; title?: string }) {
  const [loads, setLoads] = useState(0);
  const [round, setRound] = useState(0);
  if (loads > 1) {
    return (
      <div className="htmlframe gone">
        <span>Документ ушёл на другую страницу</span>
        <button type="button" className="linkbtn" onClick={() => (setLoads(0), setRound((r) => r + 1))}>Показать снова</button>
      </div>
    );
  }
  return <iframe key={round} className="htmlframe" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} onLoad={() => setLoads((n) => n + 1)} />;
}

/** Ответ — целый HTML-документ без блока кода: оборачивается в блок html, чтобы показаться кодом с «Просмотром», а не разметкой страницы. */
export function fenceHtml(text: string): string {
  const t = text.trim();
  if (!/^<(!doctype html|html[\s>])/i.test(t) || !/<\/html>\s*$/i.test(t)) return text;
  return "```html\n" + t + "\n```";
}

/** Типы картинок по расширению: с ними браузер показывает содержимое из хранилища. */
export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" };
const TEXT = new Set(["txt", "log", "json", "csv", "yaml", "yml", "xml", "toml", "ini", "diff", "patch"]);
const htmlText = (code: string) => /^\s*<(!doctype html|html[\s>])/i.test(code);
const svgText = (code: string) => /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(code);

export const extOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "";
export type ShowKind = "image" | "html" | "mermaid" | "markdown" | "text";
/** Вид показа — одно правило на всё, что показывает лента: файл, отправленный сессией, файл человека, файл, записанный инструментом, и блок кода в ответе.
 *  ext — расширение имени файла или язык блока кода; code — текст: по нему узнаётся блок без языка. null — показа нет: файл только скачивается, блок остаётся кодом. */
export function showKind(ext: string, code = ""): ShowKind | null {
  const e = ext.toLowerCase();
  if (IMAGE_TYPES[e] || ((!e || e === "xml") && svgText(code))) return "image";
  if (e === "html" || e === "htm" || (!e && htmlText(code))) return "html";
  if (e === "mmd" || e === "mermaid") return "mermaid";
  if (e === "md" || e === "markdown") return "markdown";
  return TEXT.has(e) ? "text" : null;
}

/** SVG — картинкой из данных: как картинка он не исполняет скриптов и не ходит в сеть. */
export const svgUrl = (code: string) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(code);
export function SvgView({ code, title = "Просмотр SVG" }: { code: string; title?: string }) {
  return <img className="svgview" src={svgUrl(code)} alt={title} />;
}

