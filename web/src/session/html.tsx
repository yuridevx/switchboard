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

export const looksHtml = (lang: string, code: string) => lang === "html" || (!lang && /^\s*<(!doctype html|html[\s>])/i.test(code));
export const looksSvg = (lang: string, code: string) => lang === "svg" || ((!lang || lang === "xml") && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(code));

/** SVG — картинкой из данных: как картинка он не исполняет скриптов и не ходит в сеть. */
export const svgUrl = (code: string) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(code);
export function SvgView({ code, title = "Просмотр SVG" }: { code: string; title?: string }) {
  return <img className="svgview" src={svgUrl(code)} alt={title} />;
}

/** Просмотр кода, который можно показать: HTML — в песочнице, SVG — картинкой; иначе null. */
export const previewKind = (lang: string, code: string): "html" | "svg" | null => (looksSvg(lang, code) ? "svg" : looksHtml(lang, code) ? "html" : null);

/** Картинку из ленты — в новой вкладке: вкладка не открывает адрес с данными, поэтому данные переводятся в свой адрес страницы. */
export function openPicture(src: string): void {
  if (!src.startsWith("data:")) return void window.open(src, "_blank", "noopener");
  const [head, body = ""] = src.split(",", 2) as [string, string?];
  const mime = /^data:([^;,]+)/.exec(head)?.[1] ?? "image/png";
  const bytes = head.includes(";base64") ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  window.open(url, "_blank", "noopener");
  // адрес живёт, пока вкладка его читает
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
