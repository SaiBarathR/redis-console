// Production-build CSP harness only. API responses are intercepted by Playwright;
// this server never connects to Redis or reads environment secrets.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../dist");
const nonce = "web-qualification-nonce-2026";
// 4300 is the console agent's dev port; the QA range is 4500–4900 (docs/V0.2-PLAN.md).
const port = Number(process.env.QA_CSP_PORT ?? 4810);
createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  const asset = path.startsWith("/assets/") && /^\/assets\/[\w.-]+$/.test(path);
  try {
    const file = asset
      ? resolve(root, `.${path}`)
      : resolve(root, "index.html");
    const content = await readFile(file);
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(
      asset
        ? content
        : content
            .toString()
            .replace(
              "<head>",
              `<head><meta name="csp-nonce" content="${nonce}">`,
            ),
    );
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, "127.0.0.1", () =>
  process.stdout.write(`CSP fixture listening on ${port}\n`),
);
