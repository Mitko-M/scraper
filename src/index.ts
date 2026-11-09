#!/usr/bin/env node
import { parseArgs } from "node:util";
import { crawl } from "./crawler.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o", default: "./scraped" },
    max: { type: "string", short: "m", default: "200" },
    delay: { type: "string", short: "d", default: "500" },
    concurrency: { type: "string", short: "c", default: "2" },
    retries: { type: "string", short: "r", default: "3" },
    allow: { type: "string", multiple: true, default: [] },
    "any-host": { type: "boolean", default: false },
    "ignore-robots": { type: "boolean", default: false },
    "user-agent": {
      type: "string",
      default: "scrape-cli/0.1.0 (+https://github.com/you/scrape-cli)",
    },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || positionals.length === 0) {
  console.log(`usage: scrape <url> [options]

  -o, --out <dir>          output directory (default ./scraped)
  -m, --max <n>            max pages to crawl (default 200)
  -d, --delay <ms>         delay per request (default 500)
  -c, --concurrency <n>    parallel requests (default 2)
  -r, --retries <n>        retries on failure (default 3)
      --allow <host>       extra allowed host (repeatable)
      --any-host           follow links to any host (off by default)
      --ignore-robots      skip robots.txt check (respect it unless you have a reason)
      --user-agent <ua>    custom User-Agent header`);
  process.exit(values.help ? 0 : 1);
}

await crawl({
  startUrl: positionals[0]!,
  out: values.out!,
  max: Number(values.max),
  delay: Number(values.delay),
  concurrency: Number(values.concurrency),
  retries: Number(values.retries),
  extraHosts: values.allow as string[],
  anyHost: values["any-host"] as boolean,
  ignoreRobots: values["ignore-robots"] as boolean,
  userAgent: values["user-agent"] as string,
});
