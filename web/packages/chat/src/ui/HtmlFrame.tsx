// HTML-документ сессии — в песочнице: чужой источник (без allow-same-origin), страницы и её ключа скрипты документа не видят.
// CSP закрывает подгрузку и запросы со скрипта, но переход самой рамки и WebRTC платформа не закрывает: документ может уйти на чужой адрес
// и унести в нём свои данные. Допускаем: ключа в документе нет, а сеть у сессии и так есть. Чужую страницу в карточке не оставляем:
// рамка снимается, если загрузилось не наше (нет сигнала документа) или загрузилось второе.
import { useEffect, useRef, useState } from "react";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; webrtc 'block'";
/** Сколько ждать сигнал своего документа после загрузки: сообщение приходит следом за load. */
const SIGNAL_MS = 500;

/**
 * Документ с правилом CSP в начале: оно действует раньше всего, что написано в документе. Следом — сигнал «загрузился именно он»:
 * скрипт идёт первым и убирает себя, поэтому знак сигнала документу не виден и чужая страница его не подделает.
 */
export const framed = (html: string, sign = "") =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}"><script>(()=>{const s=document.currentScript,p=parent;s.remove();addEventListener("load",(e)=>{if(e.isTrusted)p.postMessage(${JSON.stringify(sign)},"*")})})()</script>${html}`;

function Shown({ html, title }: { html: string; title: string }) {
  const [left, setLeft] = useState(false);
  const [sign] = useState(() => crypto.randomUUID());
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const signed = useRef(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data === sign && e.source === frame.current?.contentWindow) signed.current = true;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sign]);

  useEffect(() => {
    if (left) return;
    const el = frame.current!;
    let wait: ReturnType<typeof setTimeout>;
    const onLoad = () => {
      loads.current++;
      if (loads.current > 1) return setLeft(true);
      wait = setTimeout(() => setLeft(!signed.current), SIGNAL_MS);
    };
    el.addEventListener("load", onLoad);
    return () => {
      clearTimeout(wait);
      el.removeEventListener("load", onLoad);
    };
  }, [left]);

  if (left) {
    return (
      <div className="html-left" role="status">
        <span>Документ ушёл на другую страницу — просмотр снят</span>
        <button
          type="button"
          className="cb-b"
          onClick={() => {
            loads.current = 0;
            signed.current = false;
            setLeft(false);
          }}
        >
          Показать снова
        </button>
      </div>
    );
  }
  return (
    <div className="html-frame">
      <iframe ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={framed(html, sign)} />
    </div>
  );
}

/** Другой документ — другая рамка: счёт загрузок начинается заново. */
export function HtmlFrame({ html, title = "Просмотр HTML" }: { html: string; title?: string }) {
  return <Shown key={html} html={html} title={title} />;
}
