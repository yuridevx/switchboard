// Стили «Работы»: один список для колонки пульта и экрана телефона.
export const BOARD_CSS = `
.bd{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr)}
.sb-app.wide .bd{grid-template-columns:minmax(280px,340px) minmax(0,1fr)}
.sb-master .bd{grid-template-columns:minmax(0,1fr)}
.sb-master .bd-pick{display:none}
.bd-list{position:relative;display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--surface);border-right:1px solid var(--line2);overflow:hidden}
.bd-lh{flex:none;display:flex;align-items:center;gap:8px;padding:12px 12px 8px}
.bd-lh b{flex:1;font:600 19px/1.2 var(--body)}
.fbar{flex:none;display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--line2);background:var(--surface)}
.fscroll{display:flex;gap:5px;overflow-x:auto;flex:1;min-width:0;scrollbar-width:none;-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 24px),transparent);mask-image:linear-gradient(to right,#000 calc(100% - 24px),transparent);padding-right:24px}
.fscroll::-webkit-scrollbar{display:none}
button.fc{flex:none;display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 11px;font:500 12.5px/1.3 var(--body);color:var(--ink);background:var(--surface2);border:1px solid var(--line2);white-space:nowrap}
button.fc .n{font:500 11px var(--mono);color:var(--muted)}
button.fc[aria-selected="true"]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
button.fc[aria-selected="true"] .n{color:inherit;opacity:.75}
.fc .ed{font-size:11px;opacity:.8}
button.fc.add{padding:4px 10px;font-size:14px;line-height:1;background:transparent;border-style:dashed}
button.fc.vw{padding:4px 7px;display:inline-grid;place-items:center;background:transparent}
button.fc.vw[aria-expanded="true"]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.bd-body{flex:1;min-height:0;overflow-y:auto}
.lst{position:relative;display:flex;flex-direction:column;padding:4px 6px 14px}
.pjs{position:relative}
.pj{display:flex;align-items:center;gap:4px;padding:8px 4px 2px 6px;position:sticky;top:0;background:var(--surface);z-index:2;box-shadow:0 1px 0 var(--line2)}
.grip{flex:none;width:22px;height:28px;display:grid;place-items:center;color:var(--muted);cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;border-radius:6px;font-size:15px;line-height:1}
.grip:hover,.grip:focus-visible{background:var(--accent-weak);color:var(--ink)}
.grip:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
@media (hover:hover){.bd-list .grip{opacity:.35}.bd-list .pj:hover .grip,.bd-list .grip:focus-visible{opacity:1}}
.pin-sep{border-top:1.5px solid var(--line);margin:6px 8px}
button.pj-t{flex:1;min-width:0;display:flex;align-items:center;gap:7px;border:0;background:transparent;padding:4px 6px;border-radius:7px;font:600 13.5px var(--body);text-align:left;color:var(--ink)}
@media (hover:hover){button.pj-t:hover{background:var(--accent-weak)}button.pj-add:hover{background:var(--accent-weak);color:var(--ink)}.bd-row:hover{background:var(--surface2)}}
.pj-t .car{width:12px;color:var(--muted);font-size:10px;transition:transform .15s;flex:none}
.pj-t[aria-expanded="false"] .car{transform:rotate(-90deg)}
.pj-t .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pj-t .lamps{display:flex;gap:3px;margin-left:auto;align-items:center}
.pj-t .lamps .sb-dot{width:7px;height:7px;animation:none;box-shadow:none}
.pj-t .n{font:500 11.5px var(--mono);color:var(--muted);margin-left:4px}
button.pj-add{flex:none;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;font-size:17px;line-height:1;display:grid;place-items:center;background:transparent;color:var(--muted)}
.mgrp{display:flex;align-items:center;gap:6px;padding:7px 10px 1px 34px;font:600 11.5px var(--body);color:var(--muted)}
.mgrp .n{font:500 10.5px var(--mono);opacity:.8}
.bd-row{position:relative;display:flex;gap:10px;align-items:flex-start;width:100%;text-align:left;border:0;background:transparent;border-radius:9px;padding:7px 10px;color:var(--ink)}
.sb-app:not(.wide) .bd-row{padding:7px 12px}
.bd-row[aria-current="true"]{background:var(--accent-weak)}
.bd-row .sb-dot{margin-top:5px;flex:none}
.bd-rt{flex:1;min-width:0;display:flex;flex-direction:column}
.bd-t1{display:flex;gap:4px;align-items:baseline;min-width:0}
.bd-cs{font:600 13px var(--mono);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.bd-cs.hum{font-family:var(--body);letter-spacing:0}
.bd-at{margin-left:auto;padding-left:8px;font:400 12px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}
.bd-at.hum{font-family:var(--body)}
.bd-t2{display:flex;gap:6px;align-items:center;font-size:12.5px;color:var(--muted);min-width:0}
.bd-t2 .tx{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bd-t2 .tx.q{color:var(--wait);font-weight:500}
.bd-t2 .tx.f{color:var(--bad)}
.bd-t2 .prj{font-weight:600;color:var(--ink);white-space:nowrap}
.bd-pill{display:inline-flex;align-items:center;font:600 11px var(--body);padding:1px 7px;border-radius:999px;background:var(--surface2);border:1px solid var(--line2);color:var(--ink);white-space:nowrap;flex:none}
.bd-t1 .bd-pill{margin-left:6px}
.bd-pill.inc{background:var(--wait-weak);color:var(--wait);border-color:transparent}
.bd-pin{width:12px;height:12px;flex:none;align-self:center;margin-left:3px;fill:var(--muted)}
.bd-row .sb-badge{flex:none;align-self:center;margin-left:auto;min-width:18px;height:18px;padding:0 6px;font-size:11px;line-height:18px}
.bd-row.kid::before{content:"";position:absolute;left:14px;top:-4px;height:18px;width:9px;border-left:1.5px solid var(--line);border-bottom:1.5px solid var(--line);border-bottom-left-radius:6px}
.bd-empty{color:var(--muted);padding:16px 12px;font-size:12.5px}
.bd-pick{min-width:0}
@media (max-width:760px){.sb-app.wide .bd{grid-template-columns:minmax(0,1fr)}.bd-pick{display:none}}
/* в одну строку */
.bd-list.dense .bd-row{padding:3px 10px;gap:8px;align-items:center}
.bd-list.dense .bd-row .sb-dot{margin-top:0}
.bd-list.dense .bd-rt{flex-direction:row;align-items:baseline;gap:9px}
.bd-list.dense .bd-t1{display:contents}
.bd-list.dense .bd-cs{flex:0 1 auto;max-width:46%}
.bd-list.dense .bd-t2{flex:1;font-size:12px;order:5;min-width:0}
.bd-list.dense .bd-t2 .bd-pill{font-size:10.5px;padding:0 6px}
.bd-list.dense .bd-at{order:9;max-width:34%;padding-left:0}
.bd-list.dense .bd-row .sb-badge{height:16px;line-height:16px}
.bd-list.dense .bd-row.kid::before{top:-3px;height:13px}
.bd-list.dense .pj{padding-top:4px;padding-bottom:0}
.bd-list.dense .mgrp{padding-top:4px}
.bd-list.dense .pin-sep{margin:3px 8px}
/* панель вида: не закрывает список — на пульте в правой части, на телефоне блоком под списком */
.bd-vw{display:flex;flex-direction:column;gap:8px;background:var(--surface);padding:10px 12px 12px}
.sb-app.wide .bd-vw{position:fixed;right:8px;top:58px;z-index:9;width:330px;max-height:calc(100% - 66px);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.18)}
.sb-app:not(.wide) .bd-vw{flex:none;border-top:1px solid var(--line);max-height:58%;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}
.sb-main:has(.bd-vw) .sb-tabs{display:none}
.vw-h{display:flex;align-items:center;gap:6px;font:600 14px var(--body);flex:none}
.vw-h b{flex:1}
.vw-x{border:1px solid transparent;background:transparent;border-radius:8px;padding:3px 8px;font:500 12.5px var(--body);color:var(--muted)}
.vw-x:hover{background:var(--accent-weak)}
.vw-x.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent);padding:4px 12px;font-weight:600}
.vw-b{display:flex;flex-direction:column;gap:8px;min-height:0;overflow-y:auto}
.vw-g{display:flex;flex-direction:column;gap:4px}
.vw-t{font:600 11.5px var(--body);color:var(--muted)}
.vw-c{display:flex;flex-wrap:wrap;gap:4px}
.vw-c button{border:1px solid var(--line);border-radius:999px;padding:3px 10px;font:500 12.5px var(--body);background:transparent;color:var(--muted)}
.vw-c button[aria-pressed="true"]{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
.vw-c button:disabled{opacity:.45;cursor:default}
/* окно фильтра */
.bd-veil{position:fixed;inset:0;z-index:15;background:rgba(10,15,12,.38);display:flex;align-items:flex-start;justify-content:center;padding-top:40px}
.bd-dlg{width:min(620px,92%);max-height:calc(100% - 80px);background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden}
.sb-app:not(.wide) .bd-veil{align-items:flex-end;padding-top:0}
.sb-app:not(.wide) .bd-dlg{width:100%;max-height:88%;border-radius:18px 18px 0 0;border-width:1px 0 0}
.fe-h{flex:none;padding:14px 16px 6px}
.fe-h b{font:600 16px var(--body)}
.fe-b{flex:1;overflow-y:auto;min-height:0;padding:4px 16px 12px;display:flex;flex-direction:column;gap:10px}
.fe-b input{font:400 14px var(--body);color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:7px 10px;width:100%;box-sizing:border-box;flex:none}
.fe-b input.fe-name{font:600 15px var(--body)}
.fe-fs{display:flex;flex-direction:column;gap:12px}
.fe-f{display:flex;flex-direction:column;gap:6px}
.fe-l{display:flex;align-items:center;gap:8px;font:500 11.5px var(--mono);color:var(--muted)}
.fe-l b{font:600 12.5px var(--body);color:var(--ink)}
.fe-c{display:flex;flex-wrap:wrap;gap:4px;max-height:118px;overflow-y:auto}
.fe-c button{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:3px 10px;font:500 12.5px var(--body)}
.fe-c button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.fe-none{font-size:12.5px;color:var(--muted);padding:4px 2px}
.fe-ft{flex:none;display:flex;align-items:center;gap:8px;padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--line2);background:var(--surface)}
.fe-n{flex:1;min-width:0;font-size:12.5px;color:var(--muted)}
`;
