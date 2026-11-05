// Заглушка сноса.
export default {
  fetch: () => new Response(JSON.stringify({ ok: false, error: "снесено" })),
} satisfies ExportedHandler;
