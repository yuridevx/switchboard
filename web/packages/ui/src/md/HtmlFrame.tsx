// Просмотр HTML в песочнице: без своего источника и сети; документ, ушедший со страницы, снимается.
import { useEffect, useRef, useState } from "react";

const POLICY = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; webrtc 'block'";
const [MIN, MAX] = [60, 640];
const SIGN_MS = 500;

/**
 * Документ рамки: правило CSP раньше всего. Скрипт убирает себя, знак видит только он: документ сам подать знак не может.
 * Знак — настоящий load этого документа; высота — до низа тела с его отступом.
 */
const framed = (html: string, sign: string) =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${POLICY}"><script>(()=>{const s=document.currentScript,p=parent;s.remove();addEventListener("load",(e)=>{if(!e.isTrusted)return;p.postMessage("${sign}","*");const b=document.body,h=()=>p.postMessage({height:b.getBoundingClientRect().bottom+parseFloat(getComputedStyle(b).marginBottom)},"*");h();new ResizeObserver(h).observe(b)})})()</script>${html}`;

function Frame({ html, title, again }: { html: string; title: string; again(): void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [sign] = useState(() => crypto.randomUUID());
  const [height, setHeight] = useState<number>();
  const [left, setLeft] = useState(false);
  const signed = useRef(false);
  const loads = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      if (e.data === sign) signed.current = true;
      else if (typeof e.data?.height === "number") setHeight(Math.min(MAX, Math.max(MIN, Math.ceil(e.data.height))));
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer.current);
    };
  }, [sign]);

  /** Первая загрузка — наш документ, он подаёт знак; вторая — документ ушёл. */
  function onLoad() {
    if (++loads.current > 1) return setLeft(true);
    timer.current = setTimeout(() => signed.current || setLeft(true), SIGN_MS);
  }

  if (left) {
    return (
      <div className="html-left" role="status">
        <span>Документ ушёл на другую страницу — просмотр снят</span>
        <button type="button" className="cb-b" onClick={again}>
          Показать снова
        </button>
      </div>
    );
  }
  return (
    <div className="html-frame" style={height ? { height } : undefined}>
      <iframe ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={framed(html, sign)} onLoad={onLoad} />
    </div>
  );
}

export function HtmlFrame({ html, title = "Просмотр HTML" }: { html: string; title?: string }) {
  const [shown, setShown] = useState(0);
  return <Frame key={`${shown}:${html}`} html={html} title={title} again={() => setShown((n) => n + 1)} />;
}
