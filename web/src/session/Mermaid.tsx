// Схема mermaid: отдельный кусок сборки, грузится при первой схеме. Текст схемы — в SVG, SVG — картинкой: как картинка он не исполняет скриптов.
// Схема не разобралась (в том числе пока ответ ещё пишется) — показывается её текст.
import mermaid from "mermaid";
import { useEffect, useId, useState } from "react";
import { svgUrl } from "./html.tsx";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", htmlLabels: false, flowchart: { htmlLabels: false } });

export default function Mermaid({ code, onClick }: { code: string; onClick?: () => void }) {
  const id = "mmd" + useId().replace(/\W/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    (async () => {
      const fine = await mermaid.parse(code, { suppressErrors: true });
      const out = fine ? (await mermaid.render(id, code)).svg : "";
      if (on) setSvg(out);
    })().catch(() => on && setSvg(""));
    return () => { on = false; };
  }, [code, id]);
  if (svg === null) return null;
  if (!svg) return <pre>{code}</pre>;
  const pic = <img className="svgview" src={svgUrl(svg)} alt="Схема" />;
  return onClick ? <button type="button" className="picbtn fill" aria-label="Открыть схему целиком" onClick={onClick}>{pic}</button> : pic;
}
