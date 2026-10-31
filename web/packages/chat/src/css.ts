// Стили ленты: текст модели, вызовы инструментов, свои пузыри, сообщения сессии, ввод.
export const CSS = `
.chat{flex:1;min-height:0;display:flex;flex-direction:column}
.chat-feed{gap:9px}
.chat-txt{font-size:15px;max-width:94%;white-space:pre-wrap;overflow-wrap:anywhere}
.chat-me{align-self:flex-end;max-width:84%;background:var(--accent);color:var(--on-accent);padding:8px 12px;border-radius:18px 18px 4px 18px;font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere}
.chat-me small,.chat-in small{display:block;font:500 11px/1.3 var(--mono);opacity:.8;text-align:right;margin-top:3px}
.chat-me.pend{background:var(--surface);color:var(--ink);border:1.5px dashed var(--wait)}
.chat-me.pend small{color:var(--wait);opacity:1;text-align:left}
.chat-again{background:none;border:0;padding:0;color:inherit;font:inherit;text-decoration:underline;text-underline-offset:2px}
.chat-tool{display:flex;align-items:center;gap:8px;font:500 13px/1.3 var(--mono);background:var(--surface);border:1px solid var(--line2);border-radius:10px;padding:7px 10px;min-width:0}
.chat-tool b{font-weight:600;color:var(--accent);flex:none}
.chat-tool span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.chat-tool em{font-style:normal;font-weight:600;color:var(--ok);flex:none}
.chat-tool.run{border-color:var(--accent)}
.chat-tool.run em{color:var(--accent)}
.chat-tool.err em{color:var(--bad)}
.chat-in{align-self:flex-start;max-width:88%;background:var(--surface);border:1.5px solid var(--accent);padding:8px 12px;border-radius:18px 18px 18px 4px;font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere}
.chat-from{display:flex;gap:6px;align-items:center;font:600 11.5px/1.4 var(--mono);color:var(--accent);margin-bottom:2px}
.chat-tag{font:600 10.5px/1 var(--mono);background:var(--wait-weak);color:var(--wait);padding:3px 6px;border-radius:5px}
.chat-res{font:500 12px/1 var(--mono);color:var(--muted);text-align:center;border-top:1px dashed var(--line);padding-top:8px}
.chat-note{font-size:13px;color:var(--muted);text-align:center;padding:8px}
.chat-ask:empty{display:none}
.chat-ask{flex:none;padding:0 12px 8px}
.chat-askbar{width:100%;display:flex;gap:10px;align-items:center;text-align:left;background:var(--wait-weak);color:var(--wait);border:0;border-radius:12px;padding:10px 12px}
.chat-askbar b{font:700 15px/1 var(--mono)}
.chat-askbar span{flex:1;min-width:0;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.chat-askbar em{font-style:normal;font-weight:600;font-size:14px}
.chat-comp{flex:none;display:flex;gap:8px;align-items:flex-end;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--line2);background:var(--surface)}
.chat-inp{flex:1;min-width:0;border:1px solid var(--line);border-radius:20px;padding:9px 14px;font:15px/1.35 var(--body);color:var(--ink);background:var(--bg);resize:none;max-height:40vh}
.chat-send{width:40px;height:40px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:grid;place-items:center;font:700 18px/1 var(--body);border:0;padding:0;flex:none}
.chat-send[disabled]{opacity:.45;cursor:default}
`;
