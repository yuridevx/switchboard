// Песочница HTML: документ без своего источника и сети; его высота; ушёл на другую страницу — просмотр снят.
import { useEffect, useRef, useState } from "react";

const POLICY = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; webrtc 'block'";
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 640;
/** Сколько ждать сигнала документа после первой загрузки. */
const SIGNAL_MS = 500;

/**
 * Документ с правилом CSP в начале: оно действует раньше всего, что написано в документе. Следом — сигнал «загрузился именно он»:
 * скрипт идёт первым и убирает себя, поэтому знак сигнала документу не виден и чужая страница его не подделает.
 */
export const framed = (html: string, sign = ""): string =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${POLICY}"><script>(()=>{const s=document.currentScript,p=parent;s.remove();addEventListener("load",(e)=>{if(!e.isTrusted)return;p.postMessage(${JSON.stringify(sign)},"*");const b=document.body,h=()=>p.postMessage({height:b.getBoundingClientRect().bottom+parseFloat(getComputedStyle(b).marginBottom)},"*");h();new ResizeObserver(h).observe(b)})})()</script>${html}`;

function Frame({ html, title, again }: { html: string; title: string; again(): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [sign] = useState(() => crypto.randomUUID());
  const [height, setHeight] = useState<number>();
  const [left, setLeft] = useState(false);
  const watch = useRef({ loads: 0, signed: false, timer: undefined as ReturnType<typeof setTimeout> | undefined });

  useEffect(() => {
    const w = watch.current;
    const listen = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      if (e.data === sign) {
        w.signed = true;
        clearTimeout(w.timer);
      } else if (typeof e.data?.height === "number") {
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(e.data.height))));
      }
    };
    window.addEventListener("message", listen);
    return () => {
      window.removeEventListener("message", listen);
      clearTimeout(w.timer);
    };
  }, [sign]);

  const loaded = () => {
    const w = watch.current;
    if (++w.loads > 1) return setLeft(true);
    if (!w.signed) w.timer = setTimeout(() => setLeft(true), SIGNAL_MS);
  };

  return left ? (
    <div className="html-left" role="status">
      <span>Документ ушёл на другую страницу — просмотр снят</span>
      <button type="button" className="cb-b" onClick={again}>
        Показать снова
      </button>
    </div>
  ) : (
    <div className="html-frame" style={height ? { height } : undefined}>
      <iframe ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={framed(html, sign)} onLoad={loaded} />
    </div>
  );
}

/** Другой документ — другая рамка: счёт загрузок начинается заново. */
export function HtmlFrame({ html, title = "Просмотр HTML" }: { html: string; title?: string }) {
  const [shown, setShown] = useState(0);
  return <Frame key={`${shown}:${html}`} html={html} title={title} again={() => setShown((n) => n + 1)} />;
}
