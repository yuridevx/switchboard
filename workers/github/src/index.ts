// Снесено: вход отвечает отказом словом.
export default { fetch: async () => Response.json({ type: "reply", id: "", ok: false, error: "снесено" }, { status: 501 }) };
