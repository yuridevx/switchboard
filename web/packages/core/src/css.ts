// Стили каркаса: токены цветов (светлая и тёмная тема), шапка, полосы, полноэкранные состояния,
// общие метки (пилюли, точки, счётчики, карточки итога). Модули добавляют свои стили полем css.
export const BASE_CSS = `
:root{
  --bg:#edf0f3; --surface:#ffffff; --surface2:#f4f6f9;
  --ink:#121a22; --muted:#5a6672; --line:#d3dae1; --line2:#e3e8ed;
  --accent:#2747c9; --accent-weak:#e1e7fb; --on-accent:#ffffff;
  --wait:#a9650a; --wait-weak:#f7e9d2;
  --ok:#1b7a46; --ok-weak:#dbefe3;
  --bad:#b3322e; --bad-weak:#f6dedd;
  --shadow:0 1px 2px rgba(18,26,34,.06),0 6px 20px rgba(18,26,34,.06);
  --disp:"Unbounded","Golos Text",system-ui,sans-serif;
  --body:"Golos Text",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0e1318; --surface:#151c23; --surface2:#1b242d;
  --ink:#e6ebf0; --muted:#94a1ae; --line:#2a3540; --line2:#212b35;
  --accent:#8aa2ff; --accent-weak:#1c2648; --on-accent:#0e1318;
  --wait:#e3a64c; --wait-weak:#2e2414;
  --ok:#52c488; --ok-weak:#14301f;
  --bad:#ef7f78; --bad-weak:#3a1b1b;
  --shadow:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(0,0,0,.3);
  color-scheme:dark;
}}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.45 var(--body);-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
button{font:inherit;color:inherit;cursor:pointer}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code{font-family:var(--mono)}
[hidden]{display:none!important}

.sb-app{height:100dvh;display:flex;min-width:0}
.sb-main{flex:1;min-width:0;display:flex;flex-direction:column;height:100%;position:relative}
.sb-navcol{flex:none;width:220px;border-right:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;gap:4px;padding:14px 10px}
.sb-navcol button,.sb-navrow button{display:flex;justify-content:space-between;align-items:center;gap:8px;border:0;background:transparent;border-radius:10px;padding:9px 12px;font:600 14px var(--body);text-align:left}
.sb-navcol button[aria-current="page"],.sb-navrow button[aria-current="page"]{background:var(--accent-weak);color:var(--accent)}
.sb-navrow{flex:none;display:flex;gap:4px;padding:6px 10px;background:var(--surface);border-bottom:1px solid var(--line2);overflow-x:auto}

/* шапка */
.sb-bar{flex:none;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top,0px)) 14px 10px;background:var(--surface);border-bottom:1px solid var(--line2)}
.sb-logo{width:32px;height:32px;border-radius:9px;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;font:700 16px/1 var(--disp);flex:none}
.sb-logo.xl{width:72px;height:72px;border-radius:19px;font-size:34px}
.sb-bt{display:flex;flex-direction:column;min-width:0;flex:1}
.sb-bt b{font:600 17px/1.2 var(--body);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-bt b.m{font:600 15px/1.25 var(--mono)}
.sb-bt span{font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-back{font:500 30px/1 var(--body);color:var(--accent);background:none;border:0;padding:0 6px 4px 0;flex:none}

/* пилюли, точки, счётчики */
.sb-pill{display:inline-flex;align-items:center;gap:6px;font:600 11.5px/1 var(--mono);padding:6px 9px;border-radius:999px;white-space:nowrap;flex:none;background:var(--surface2);color:var(--muted)}
.sb-pill.conn::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.sb-pill.ok{background:var(--ok-weak);color:var(--ok)}
.sb-pill.wait{background:var(--wait-weak);color:var(--wait)}
.sb-pill.bad{background:var(--bad-weak);color:var(--bad)}
.sb-pill.busy{background:var(--accent-weak);color:var(--accent)}
.sb-dot{width:10px;height:10px;border-radius:50%;background:var(--muted)}
.sb-dot.busy{background:var(--accent);animation:sb-pulse 1.6s ease-out infinite}
.sb-dot.wait{background:var(--wait);box-shadow:0 0 0 3px var(--wait-weak)}
.sb-dot.idle{background:var(--ok)}
.sb-dot.stop{background:transparent;border:1.5px solid var(--muted)}
@keyframes sb-pulse{0%{box-shadow:0 0 0 0 var(--accent-weak)}60%{box-shadow:0 0 0 6px var(--accent-weak)}100%{box-shadow:0 0 0 0 var(--accent-weak)}}
@media (prefers-reduced-motion:reduce){.sb-dot.busy{animation:none;box-shadow:0 0 0 3px var(--accent-weak)}}
.sb-badge{min-width:22px;height:22px;padding:0 7px;border-radius:999px;background:var(--accent);color:var(--on-accent);font:700 12px/22px var(--mono);text-align:center}
.sb-badge.wait{background:var(--wait);color:var(--surface)}

/* тело экрана */
.sb-view{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.sb-top:empty{display:none}
.sb-top{flex:none;padding:10px 12px 0}
.sb-pad{flex:1;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.sb-cta{width:100%;background:var(--accent);color:var(--on-accent);border:0;border-radius:12px;padding:12px;font:600 15px var(--body)}
.sb-cta[disabled]{opacity:.4;cursor:default}
.sb-okc,.sb-waitc,.sb-badc{border-radius:14px;padding:11px 13px;font-size:14px;display:flex;flex-direction:column;gap:4px}
.sb-okc{background:var(--ok-weak);color:var(--ok)}
.sb-waitc{background:var(--wait-weak);color:var(--wait)}
.sb-badc{background:var(--bad-weak);color:var(--bad)}
.sb-okc span,.sb-waitc span,.sb-badc span{color:var(--ink)}
.sb-badc code{color:var(--ink);word-break:break-word}

/* полоса «нет связи» и строка отказа */
.sb-off{flex:none;display:flex;justify-content:space-between;gap:8px;align-items:center;background:var(--wait-weak);color:var(--wait);font:600 13px/1.3 var(--body);padding:8px 14px}
.sb-off button{background:none;border:0;color:inherit;font:inherit;text-decoration:underline;text-underline-offset:2px;padding:0}
.sb-toast{position:absolute;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom,0px));background:var(--bad-weak);color:var(--bad);border-radius:12px;padding:10px 12px;font-size:13.5px;box-shadow:var(--shadow);z-index:5}
.sb-toast.ok{background:var(--ok-weak);color:var(--ok)}

/* полноэкранные состояния */
.sb-full{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:12px;padding:28px 24px 48px;overflow-y:auto}
.sb-full p{font-size:14px;color:var(--muted);max-width:34ch;margin:0}
.sb-big{font:600 20px/1.25 var(--disp);text-wrap:balance}
.sb-k{font:600 13.5px var(--mono);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:6px 10px}
.sb-cmd{font:600 12.5px/1.4 var(--mono);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 10px;text-align:left;word-break:break-word}
.sb-ring{width:64px;height:64px;border-radius:50%;display:grid;place-items:center;font:700 28px/1 var(--body)}
.sb-ring.bad{background:var(--bad-weak);color:var(--bad)}
.sb-ring.wait{background:var(--wait-weak);color:var(--wait)}
.sb-full .sb-cta{max-width:240px}
.sb-ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;counter-reset:sb;align-self:stretch;text-align:left;max-width:420px;width:100%;margin-inline:auto}
.sb-ol li{counter-increment:sb;display:flex;gap:10px;align-items:center;background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:10px 12px;font-size:14px}
.sb-ol li::before{content:counter(sb);width:22px;height:22px;border-radius:50%;background:var(--accent-weak);color:var(--accent);display:grid;place-items:center;font:700 12px/1 var(--mono);flex:none}
.sb-keyin{width:100%;max-width:360px;border:1px solid var(--line);border-radius:12px;padding:11px 12px;font:500 14px var(--mono);color:var(--ink);background:var(--surface)}
.sb-errs{margin:0;padding:0;list-style:none;font:500 12.5px/1.45 var(--mono);text-align:left;color:var(--bad)}
`;
