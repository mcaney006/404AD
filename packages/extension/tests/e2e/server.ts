/**
 * Static file server for the end-to-end suite.
 *
 * The extension's content script matches `<all_urls>`, so the fixture pages
 * have to be served over HTTP rather than loaded from `file://` or injected
 * with `setContent`.
 */
const ROOT = new URL("./pages/", import.meta.url);
const PORT = Number(process.env.E2E_PORT ?? 8787);

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(new URL(name, ROOT));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  },
});

console.log(`e2e fixtures on http://127.0.0.1:${PORT}`);
