import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const built = process.argv.includes("--dist");
const htmlPath = built ? "../dist/index.html" : "../index.html";
const publicPath = built ? "../dist/" : "../public/";
const [html, headers, robots, sitemap] = await Promise.all([
  readFile(new URL(htmlPath, import.meta.url), "utf8"),
  readFile(new URL(`${publicPath}_headers`, import.meta.url), "utf8"),
  readFile(new URL(`${publicPath}robots.txt`, import.meta.url), "utf8"),
  readFile(new URL(`${publicPath}sitemap.xml`, import.meta.url), "utf8"),
]);

assert(html.includes("https://www.googletagmanager.com/gtag/js?id=G-D0NC5D1Y6M"), "Google tag loader is missing.");
const inlineScripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]);
const googleInitializer = inlineScripts.find((script) => script.includes("G-D0NC5D1Y6M"));
assert(googleInitializer, "Google tag initializer is missing.");
const hash = createHash("sha256").update(googleInitializer).digest("base64");
assert(headers.includes(`'sha256-${hash}'`), "The CSP does not authorize the exact Google tag initializer.");
assert(!headers.includes("'unsafe-inline'"), "The CSP must not allow arbitrary inline scripts.");
assert(headers.includes("worker-src 'self'"), "The CSP must allow the same-origin transfer worker.");
assert(headers.includes("screen-wake-lock=(self)"), "The static Permissions Policy must allow the screen wake lock.");
assert(html.includes("<meta name=\"robots\" content=\"index, follow\""), "The homepage robots directive is missing.");
assert(robots.includes("Disallow: /d/"), "robots.txt must exclude one-time receiver URLs.");
assert(robots.includes("Sitemap: https://termdrop.sh/sitemap.xml"), "robots.txt must advertise the sitemap.");
assert(sitemap.includes("<loc>https://termdrop.sh/</loc>"), "The canonical homepage is missing from the sitemap.");

function assert(value, message) {
  if (!value) throw new Error(message);
}
