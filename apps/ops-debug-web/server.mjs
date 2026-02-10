import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "4173");
const host = "0.0.0.0";
const distDir = join(process.cwd(), "dist");

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function sanitizePath(urlPath) {
  const withoutQuery = urlPath.split("?")[0] ?? "/";
  const rawPath = withoutQuery === "/" ? "/index.html" : withoutQuery;
  const normalized = normalize(rawPath).replace(/^\.+/, "");
  return normalized.startsWith("/") ? normalized.slice(1) : normalized;
}

async function resolveFilePath(urlPath) {
  const candidate = sanitizePath(urlPath);
  const absolute = join(distDir, candidate);

  try {
    const stats = await fs.stat(absolute);
    if (stats.isFile()) {
      return absolute;
    }
  } catch {
    // fallback below
  }

  return join(distDir, "index.html");
}

const server = createServer(async (req, res) => {
  try {
    const filePath = await resolveFilePath(req.url ?? "/");
    const ext = extname(filePath).toLowerCase();
    const contentType = mimeByExt[ext] ?? "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`ops-debug-web startup error: ${message}`);
  }
});

server.listen(port, host, () => {
  console.log(`ops-debug-web listening on http://${host}:${port}`);
});
