// Стили полосы «Включить уведомления».
export const CSS = `
.al-card{display:flex;gap:12px;align-items:center;justify-content:space-between;background:var(--accent-weak);border-radius:14px;padding:11px 12px 11px 14px}
.al-card>span{display:flex;flex-direction:column;min-width:0}
.al-card b{font:600 14.5px/1.3 var(--body);color:var(--accent)}
.al-card span span{font-size:13px;color:var(--ink)}
.al-card.muted{background:var(--surface2)}
.al-card.muted b{color:var(--muted)}
.al-on{flex:none;background:var(--accent);color:var(--on-accent);border:0;border-radius:10px;padding:9px 14px;font:600 14px var(--body)}
.al-on[disabled]{opacity:.5}
`;
