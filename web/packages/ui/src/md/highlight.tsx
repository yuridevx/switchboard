// Подсветка кода: языки флота, узлы — разметкой React.
import { useMemo, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

const lowlight = createLowlight({ bash, c, cpp, csharp, css, diff, go, ini, java, javascript, json, markdown, powershell, python, rust, shell, sql, typescript, xml, yaml });
lowlight.registerAlias({ bash: ["sh", "zsh"], javascript: ["js", "jsx", "mjs"], typescript: ["ts", "tsx"], python: ["py"], rust: ["rs"], ini: ["toml"], xml: ["html", "svg"], yaml: ["yml"], powershell: ["ps1", "pwsh"], csharp: ["cs"] });

const BY_EXT: Record<string, string> = { ts: "ts", tsx: "ts", js: "js", jsx: "js", mjs: "js", py: "py", go: "go", rs: "rs", sh: "bash", json: "json", md: "markdown", css: "css", html: "html", svg: "html", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", c: "c", h: "c", cpp: "cpp", java: "java", ps1: "ps1", cs: "cs" };

export function langOfPath(path: string | undefined) {
  const ext = path?.slice(path.lastIndexOf(".") + 1).toLowerCase() ?? "";
  return Object.hasOwn(BY_EXT, ext) ? BY_EXT[ext] : "";
}

/** Узлы подсветки; незнакомый язык — текст как есть. */
export function useHighlighted(code: string, lang: string): ReactNode {
  return useMemo(() => {
    const name = lang.toLowerCase();
    return lowlight.registered(name) ? toJsxRuntime(lowlight.highlight(name, code), { Fragment, jsx, jsxs }) : code;
  }, [code, lang]);
}
