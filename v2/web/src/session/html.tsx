// HTML в песочнице и узнавание HTML-документа: общее для блока кода в ответе и для просмотра записанного файла. Лёгкий файл: Markdown грузится отдельным куском.
import { isValidElement, type ReactNode } from "react";

/** Текст узлов React: код блока после подсветки — дерево, а копируется текст. */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement(node) ? textOf((node.props as { children?: ReactNode }).children) : "";
}

/** Документ HTML в песочнице: скрипты идут, но у рамки свой пустой источник — до страницы, её хранилища и пропуска ей не достать. */
export function HtmlFrame({ html, title = "Просмотр HTML" }: { html: string; title?: string }) {
  return <iframe className="htmlframe" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} />;
}

export const looksHtml = (lang: string, code: string) => lang === "html" || (!lang && /^\s*<(!doctype html|html[\s>])/i.test(code));
