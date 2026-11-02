// Стили каркаса: токены цветов (светлая и тёмная тема), шапка, полосы, полноэкранные состояния,
// общие метки (пилюли, точки, счётчики, карточки итога). Модули добавляют свои стили полем css.
export const BASE_CSS = `
:root{
  --bg:#E6E9E4; --surface:#FBFCFA; --surface2:#F0F2EE;
  --ink:#17201B; --muted:#56625B; --line:#D3D9D2; --line2:#E2E6E0;
  --accent:#17201B; --accent-weak:#E3E8E1; --on-accent:#FBFCFA;
  --busy:#2B5CCB; --busy-weak:#E0E7F8;
  --wait:#A85A05; --wait-weak:#FBEBD2; --on-wait:#FFFFFF;
  --ok:#287649; --ok-weak:#DCEEE2;
  --bad:#B3302A; --bad-weak:#F6DEDB;
  --shadow:0 1px 2px rgba(20,30,25,.06),0 8px 24px rgba(20,30,25,.08);
  --disp:"Geologica","Golos Text",system-ui,sans-serif;
  --body:"Geologica","Golos Text",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0D110F; --surface:#151A17; --surface2:#1B211D;
  --ink:#E2E8E3; --muted:#9AA69F; --line:#2B342E; --line2:#222A25;
  --accent:#E2E8E3; --accent-weak:#232B26; --on-accent:#151A17;
  --busy:#88A7FF; --busy-weak:#1B2646;
  --wait:#F1A443; --wait-weak:#382810; --on-wait:#1E1404;
  --ok:#66C691; --ok-weak:#15301F;
  --bad:#FF8B80; --bad-weak:#3D1C19;
  --shadow:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(0,0,0,.3);
  color-scheme:dark;
}}
:root[data-theme="dark"]{
  --bg:#0D110F; --surface:#151A17; --surface2:#1B211D;
  --ink:#E2E8E3; --muted:#9AA69F; --line:#2B342E; --line2:#222A25;
  --accent:#E2E8E3; --accent-weak:#232B26; --on-accent:#151A17;
  --busy:#88A7FF; --busy-weak:#1B2646;
  --wait:#F1A443; --wait-weak:#382810; --on-wait:#1E1404;
  --ok:#66C691; --ok-weak:#15301F;
  --bad:#FF8B80; --bad-weak:#3D1C19;
  --shadow:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(0,0,0,.3);
  color-scheme:dark;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.45 var(--body);-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
button{font:inherit;color:inherit;cursor:pointer}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code{font-family:var(--mono)}
[hidden]{display:none!important}

.sb-app{height:100dvh;display:flex;min-width:0}
.sb-main{flex:1;min-width:0;display:flex;flex-direction:column;height:100%;position:relative}
.sb-navcol{flex:none;width:212px;border-right:1px solid var(--line2);background:var(--surface2);display:flex;flex-direction:column;gap:2px;padding:12px 10px;overflow-y:auto}
.sb-nv{display:flex;justify-content:space-between;align-items:center;gap:8px;border:0;background:transparent;border-radius:8px;padding:7px 9px;font:500 14px var(--body);text-align:left;color:var(--ink)}
.sb-nv:hover{background:var(--accent-weak)}
.sb-navcol .sb-nv[aria-current="page"]{background:var(--surface);box-shadow:0 0 0 1px var(--line);font-weight:600}
.sb-nv.sub{padding:5px 9px 5px 28px;font-size:13px}
.sb-lamps{display:flex;gap:3px}
.sb-lamps .sb-dot{width:7px;height:7px;animation:none;box-shadow:none}
.sb-grp{font:600 11.5px var(--body);color:var(--muted);padding:12px 9px 4px}
.sb-goto{display:flex;justify-content:space-between;align-items:center;border:1px solid var(--line);background:var(--surface);color:var(--muted);border-radius:8px;padding:6px 10px;margin:2px 0 8px;font:500 13px var(--body)}
.sb-goto kbd{font:600 11px var(--mono);border:1px solid var(--line);border-radius:4px;padding:0 5px;background:var(--surface2)}
.sb-navrow{flex:none;display:flex;gap:6px;padding:8px 12px;background:var(--surface);border-bottom:1px solid var(--line2);overflow-x:auto;scrollbar-width:none}
.sb-navrow .sb-nv{flex:none;border:1px solid var(--line2);border-radius:999px;padding:4px 11px;font-size:13px;background:var(--surface2)}
.sb-navrow .sb-nv[aria-current="page"]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.sb-tabs{flex:none;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;border-top:1px solid var(--line2);background:var(--surface);padding:6px 8px calc(8px + env(safe-area-inset-bottom,0px))}
.sb-tabs .sb-nv{flex-direction:column;justify-content:center;gap:2px;min-height:48px;font-size:12.5px;color:var(--muted);position:relative}
.sb-tabs .sb-nv[aria-current="page"]{color:var(--ink);font-weight:600}
.sb-tabs .sb-badge{position:absolute;top:2px;left:calc(50% + 8px);min-width:18px;height:18px;font-size:10.5px;line-height:18px;padding:0 5px}
/* поиск Ctrl K */
.sb-palw{position:fixed;inset:0;z-index:20}
.sb-palveil{position:absolute;inset:0;background:rgba(10,15,12,.38)}
.sb-pal{position:relative;margin:70px auto 0;width:min(640px,92%);background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden}
.sb-palin{width:100%;border:0;border-bottom:1px solid var(--line2);padding:14px 16px;font:16px var(--body);background:transparent;color:var(--ink);outline:none}
.sb-palres{display:flex;flex-direction:column;padding:6px;max-height:380px;overflow-y:auto}
.sb-palit{display:flex;gap:10px;align-items:center;border:0;background:transparent;text-align:left;padding:8px 10px;border-radius:8px}
.sb-palit:hover,.sb-palit.first{background:var(--accent-weak)}
.sb-palit .l{font:500 13.5px var(--mono)}
.sb-palit .k{margin-left:auto;font-size:12px;color:var(--muted)}
.sb-palit .sb-dot{width:9px;height:9px;animation:none}

/* широкий вид: колонка разделов, список слева от экрана сессии */
.sb-app.wide .sb-bar{display:none}
.sb-brand{display:flex;align-items:center;gap:8px;padding:2px 6px 8px;font:700 15px var(--body)}
.sb-brand b{flex:1}
.sb-brand .sb-logo{width:26px;height:26px;border-radius:8px;font-size:13px}
.sb-brand .sb-pill{padding:4px;background:none}
.sb-navcol .sb-brand{order:-2}
.sb-split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr)}
.sb-master{border-right:1px solid var(--line2);background:var(--surface);display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.sb-detail{display:flex;flex-direction:column;min-height:0;min-width:0}
@media (max-width:760px){
  .sb-app.wide{flex-direction:column}
  .sb-app.wide .sb-navcol{width:auto;flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:6px 8px}
  .sb-app.wide .sb-brand b,.sb-app.wide .sb-grp,.sb-app.wide .sb-goto{display:none}
  .sb-app.wide .sb-brand{padding:0 4px}
  .sb-split{grid-template-columns:minmax(0,1fr)}
  .sb-split .sb-master{display:none}
}

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
.sb-pill.busy{background:var(--busy-weak);color:var(--busy)}
.sb-dot{width:10px;height:10px;border-radius:50%;background:var(--muted)}
.sb-dot.busy{background:var(--busy);animation:sb-pulse 1.6s ease-out infinite}
.sb-dot.wait{background:var(--wait);box-shadow:0 0 0 3px var(--wait-weak)}
.sb-dot.idle{background:var(--ok)}
.sb-dot.stop{background:transparent;border:1.5px solid var(--muted)}
.sb-dot.bad{background:var(--bad);border-radius:2px;transform:rotate(45deg)}
.sb-dot.gone{background:transparent;border:1.5px dashed var(--muted)}
@keyframes sb-pulse{0%{box-shadow:0 0 0 0 var(--busy-weak)}60%{box-shadow:0 0 0 6px var(--busy-weak)}100%{box-shadow:0 0 0 0 var(--busy-weak)}}
@media (prefers-reduced-motion:reduce){.sb-dot.busy{animation:none;box-shadow:0 0 0 3px var(--busy-weak)}}
.sb-badge{min-width:22px;height:22px;padding:0 7px;border-radius:999px;background:var(--accent);color:var(--on-accent);font:700 12px/22px var(--mono);text-align:center}
.sb-badge.wait{background:var(--wait);color:var(--on-wait)}

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

/* экраны широкого вида: страница, разделы, кнопки, поля */
.sb-page{flex:1;min-height:0;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:12px}
.sb-ph{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sb-ph h2{margin:0;font:600 19px var(--body);flex:1}
.sb-sec{background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}
.sb-sec.dlg{border:1.5px solid var(--accent);box-shadow:var(--shadow)}
.sb-sec.bad{background:var(--bad-weak);border-color:var(--bad)}
.sb-sec.wait{background:var(--wait-weak);border-color:var(--wait)}
.sb-sec.ok{background:var(--ok-weak);border-color:var(--ok)}
.sb-h4{margin:0;font:600 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.sb-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px;align-items:center;font-size:13.5px}
.sb-row>span:first-child{color:var(--muted)}
.sb-opts{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.sb-b{font:600 12.5px/1.2 var(--body);border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:6px 10px;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;gap:4px}
.sb-b.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.sb-b.bad{color:var(--bad);border-color:var(--bad);background:transparent}
.sb-b.dash{border-style:dashed;color:var(--muted);background:transparent}
.sb-b[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.sb-b[disabled]{opacity:.45;cursor:default}
.sb-in{border:1px solid var(--line);border-radius:8px;padding:6px 9px;font:13.5px var(--body);color:var(--ink);background:var(--bg);min-width:0}
.sb-in.m{font-family:var(--mono);font-size:12.5px}
.sb-note{font-size:12.5px;color:var(--muted)}
.sb-note.ok{color:var(--ok)}
.sb-note.bad{color:var(--bad)}
.sb-note.wait{color:var(--wait)}
.sb-m{font-family:var(--mono)}
.sb-barw{height:6px;border-radius:3px;background:var(--surface2);overflow:hidden;display:block;min-width:60px}
.sb-barw i{display:block;height:100%;background:var(--ok)}
.sb-barw.warn i{background:var(--wait)}
.sb-barw.bad i{background:var(--bad)}

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
