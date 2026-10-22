import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDeps } from "./server__deps.ts";
import { getState, getTg, sync } from "./server__service.ts";

const root = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const port = Number(process.env.PORT || 10000);
const host = "0.0.0.0";
const deps = renderDeps();
let pollBusy = false;

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
function securityHeaders(res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
}
async function bodyBuffer(req: IncomingMessage, max = 64_000): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += b.length; if (size > max) throw new Error("Request body too large"); chunks.push(b); }
  return Buffer.concat(chunks);
}
async function sendApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  let body: Buffer | undefined;
  try { if (!(["GET", "HEAD"].includes(req.method || "GET"))) body = await bodyBuffer(req); }
  catch { res.writeHead(413, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "too_large", message: "Request body is too large." } })); return; }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  const request = new Request(url, { method: req.method, headers, ...(body ? { body: body as unknown as BodyInit, duplex: "half" } as RequestInit : {}) });
  const response = await (await import("./api")).handle(request, deps);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
}
async function sendStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.includes("\0")) { res.writeHead(400); res.end("Bad request"); return; }
  let file = resolve(root, "." + pathname);
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); res.end("Forbidden"); return; }
  try { if (!(await stat(file)).isFile()) throw new Error("not a file"); }
  catch { file = resolve(root, "index.html"); }
  try {
    const content = await readFile(file);
    securityHeaders(res);
    res.setHeader("Content-Type", mime[extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", file.endsWith("index.html") ? "no-cache" : "public, max-age=3600");
    res.writeHead(200); res.end(req.method === "HEAD" ? undefined : content);
  } catch { res.writeHead(500); res.end("Build output not found. Run npm run build."); }
}

const server = createServer(async (req, res) => {
  try {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const proto = forwardedProto === "https" ? "https" : "http";
    const url = new URL(req.url || "/", `${proto}://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await sendApi(req, res, url);
    else if (req.method === "GET" || req.method === "HEAD") await sendStatic(req, res, url);
    else { res.writeHead(405, { allow: "GET, HEAD" }); res.end("Method not allowed"); }
  } catch (err) {
    console.error("request failed:", err instanceof Error ? err.message : "unknown error");
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "internal", message: "Internal server error." } }));
  }
});

server.listen(port, host, () => console.log(`Kiruu AI listening on ${host}:${port}`));
setInterval(async () => {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const state = await getState(deps);
    if (state.running && (await getTg(deps)).status === "connected") await sync(deps);
  } catch (err) { console.error("Telegram poll failed:", err instanceof Error ? err.message : "unknown error"); }
  finally { pollBusy = false; }
}, 60_000).unref();
