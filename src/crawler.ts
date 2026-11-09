import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import robotsParser from "robots-parser";

export type CrawlOptions = {
  startUrl: string;
  out: string;
  max: number;
  delay: number;
  concurrency: number;
  retries: number;
  extraHosts: string[];
  anyHost: boolean;
  ignoreRobots: boolean;
  userAgent: string;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withProtocol(input: string): string {
  return /^https?:\/\//i.test(input) ? input : `http://${input}`;
}

export async function crawl(opts: CrawlOptions): Promise<void> {
  const start = normalize(withProtocol(opts.startUrl));
  if (!start) throw new Error(`Invalid URL: ${opts.startUrl}`);

  const startHost = new URL(start).hostname;
  const allowedHosts = new Set<string>([startHost, ...opts.extraHosts]);

  const canVisit = (href: string): boolean => {
    const host = new URL(href).hostname;
    return opts.anyHost || allowedHosts.has(host);
  };

  const queue: string[] = [start];
  const visited = new Set<string>([start]);
  const robotsCache = new Map<string, robotsParser.Robot>();

  let claimed = 0;
  let pending = 0;
  let saved = 0;
  let failed = 0;
  let skipped = 0;

  const getRobots = async (origin: string) => {
    const cached = robotsCache.get(origin);
    if (cached) return cached;
    const url = `${origin}/robots.txt`;
    let txt = "";
    try {
      const r = await fetch(url, { headers: { "User-Agent": opts.userAgent } });
      if (r.ok) txt = await r.text();
    } catch {}
    // @ts-ignore
    const r = robotsParser(url, txt);
    robotsCache.set(origin, r);
    return r;
  };

  const fetchWithRetry = async (url: string): Promise<Response | null> => {
    for (let i = 0; i <= opts.retries; i++) {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": opts.userAgent, Accept: "text/html,*/*" },
          redirect: "follow",
        });
        if (res.status === 429 || res.status >= 500) {
          if (i < opts.retries) {
            await sleep(1000 * 2 ** i);
            continue;
          }
          return res;
        }
        return res;
      } catch {
        if (i < opts.retries) {
          await sleep(1000 * 2 ** i);
          continue;
        }
        return null;
      }
    }
    return null;
  };

  const processPage = async (url: string): Promise<void> => {
    if (!opts.ignoreRobots) {
      const origin = new URL(url).origin;
      const r = await getRobots(origin);
      if (!r.isAllowed(url, opts.userAgent)) {
        console.warn(`· robots-disallow ${url}`);
        skipped++;
        return;
      }
    }

    const res = await fetchWithRetry(url);
    if (!res) {
      console.warn(`✗ network  ${url}`);
      failed++;
      return;
    }
    if (!res.ok) {
      console.warn(`✗ ${res.status}     ${url}`);
      failed++;
      return;
    }

    const effective = normalize(res.url) ?? url;
    if (effective !== url) {
      if (visited.has(effective)) {
        skipped++;
        return;
      }
      visited.add(effective);
    }

    const ct = res.headers.get("content-type") ?? "";
    const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");

    // One `file`, one mkdir — used by both branches.
    const file = filePathFor(opts.out, effective, ct);
    await mkdir(path.dirname(file), { recursive: true });

    if (!isHtml) {
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(file, buf);
      saved++;
      console.log(`↓ ${fmtSize(buf.length)} ${effective}`);
      return;
    }

    const html = await decodeHtml(res);
    const $ = cheerio.load(html);

    $("meta[http-equiv='Content-Type']").attr(
      "content",
      "text/html; charset=utf-8",
    );
    $("meta[charset]").attr("charset", "utf-8");

    const baseHref = $("base[href]").attr("href");
    const base = baseHref ? new URL(baseHref, effective).href : effective;

    // Shared enqueue — used by all extractors below.
    const enqueue = (raw: string | undefined): void => {
      if (!raw) return;
      let abs: string;
      try {
        const u = new URL(raw, base);
        if (u.protocol !== "http:" && u.protocol !== "https:") return;
        u.hash = "";
        abs = u.href;
      } catch {
        return;
      }
      if (visited.has(abs) || !canVisit(abs)) return;
      visited.add(abs);
      queue.push(abs);
    };

    $("a[href]").each((_, el) => enqueue($(el).attr("href")));
    $("iframe[src]").each((_, el) => enqueue($(el).attr("src")));
    $("frame[src]").each((_, el) => enqueue($(el).attr("src")));
    $("embed[src]").each((_, el) => enqueue($(el).attr("src")));
    $("object[data]").each((_, el) => enqueue($(el).attr("data")));

    // Uncomment when you want a full offline mirror (styles / images / fonts):
    // $("link[href]").each((_, el) => enqueue($(el).attr("href")));
    // $("img[src]").each((_, el) => enqueue($(el).attr("src")));
    // $("script[src]").each((_, el) => enqueue($(el).attr("src")));
    // $("source[src]").each((_, el) => enqueue($(el).attr("src")));

    // Write the post-modification HTML, not the pre-modification string.
    await writeFile(file, $.html());
    saved++;
    console.log(`✓ [${saved}] ${effective}`);
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (claimed >= opts.max) return;
      if (queue.length === 0) {
        if (pending === 0) return;
        await sleep(20);
        continue;
      }
      const url = queue.shift()!;
      claimed++;
      pending++;
      try {
        await sleep(opts.delay);
        await processPage(url);
      } catch (err) {
        failed++;
        console.warn(`✗ ${url}: ${(err as Error).message}`);
      } finally {
        pending--;
      }
    }
  };

  console.log(`crawl ${start}`);
  console.log(
    `hosts: ${[...allowedHosts].join(", ")}${opts.anyHost ? " (any)" : ""}`,
  );
  console.log(
    `max=${opts.max} delay=${opts.delay}ms concurrency=${opts.concurrency}\n`,
  );

  await Promise.all(Array.from({ length: opts.concurrency }, worker));

  console.log(
    `\nDone. saved=${saved} failed=${failed} skipped=${skipped} discovered=${visited.size}`,
  );
}

function normalize(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function filePathFor(out: string, url: string, contentType: string): string {
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname).replace(/^\/+/, "");

  const ext =
    extFromContentType(contentType) ?? extFromPath(u.pathname) ?? "bin";

  let base: string;
  if (p === "" || p.endsWith("/")) {
    base = p + "index";
  } else if (/\.html?$/i.test(p)) {
    base = p.replace(/\.html?$/i, "");
  } else {
    base = p.replace(/\.[^./]*$/, "");
  }

  let suffix = "";
  if (u.search) {
    suffix =
      "__" +
      u.search
        .slice(1)
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .slice(0, 80);
  }

  const file = (base + suffix + "." + ext).replace(/[<>:"|?*\x00-\x1f]/g, "_");
  return path.join(out, u.hostname, file);
}

function extFromPath(p: string): string | null {
  const m = p.match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1]!.toLowerCase() : null;
}

function extFromContentType(ct: string): string | null {
  const t = ct.split(";")[0]!.trim().toLowerCase();
  const map: Record<string, string> = {
    "text/html": "html",
    "application/xhtml+xml": "html",
    "application/pdf": "pdf",
    "text/css": "css",
    "text/javascript": "js",
    "application/javascript": "js",
    "application/json": "json",
    "application/xml": "xml",
    "text/xml": "xml",
    "text/plain": "txt",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "font/woff": "woff",
    "font/woff2": "woff2",
    "font/ttf": "ttf",
    "application/zip": "zip",
    "application/octet-stream": "bin",
  };
  return map[t] ?? null;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}M`;
  return `${(n / 1024 ** 3).toFixed(1)}G`;
}

async function decodeHtml(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 2048).toString("latin1");
  const fromMeta = head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  const fromHeader = res.headers
    .get("content-type")
    ?.match(/charset=([\w-]+)/i)?.[1];
  const charset = (fromMeta ?? fromHeader ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}
