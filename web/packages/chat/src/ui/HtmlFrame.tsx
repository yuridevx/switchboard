// HTML-документ сессии — в песочнице: чужой источник (без allow-same-origin), страницы и её ключа не видит.
// Правило CSP закрывает сеть: скрипты страницы работают, но унести данные наружу и подгрузить чужое не могут.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

/** Документ с правилом CSP в начале: оно действует раньше всего, что написано в документе. */
export const framed = (html: string) => `<!doctype html><meta http-equiv="Content-Security-Policy" content="${CSP}">${html}`;

export function HtmlFrame({ html, title = "Просмотр HTML" }: { html: string; title?: string }) {
  return (
    <div className="html-frame">
      <iframe title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={framed(html)} />
    </div>
  );
}
