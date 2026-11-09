# scrape-cli

A small, honest web crawler CLI written in TypeScript. Point it at a URL, get a mirror of that site on disk.

Originally written to archive [Димитър Тянев's *Организация на компютъра*](http://www.tyanev.com/home.php?lang=bg&mod=1&mid=18) from an unstable university server. It grew into a general-purpose BFS crawler.

## Features

- **Breadth-first crawl** with a sliding-window concurrency pool
- **Respects `robots.txt`** — fetched once per origin and cached
- **Retries with exponential backoff** on network errors and 429/5xx
- **Follows all content-bearing tags** — `<a>`, `<iframe>`, `<frame>`, `<embed>`, `<object>` — so PHP-wrapped pages and framed chapter content are both reached
- **Saves non-HTML responses** — PDFs, images, audio, video — with the correct extension derived from the `Content-Type` header
- **Charset-aware** — sniffs encoding from the `meta` tag or headers and normalizes every page to UTF-8, so old `windows-1251` sites don't produce mojibake
- **Mirror-on-disk layout** — `scraped/<host>/<path>.<ext>` so you can browse the result locally
- **Host boundary by default** — only crawls the start URL's hostname unless you opt in to more

## Install

Requires **Node 20+** (native `fetch`).

```bash
git clone https://github.com/Mitko-M/scraper.git
cd scrape-cli
npm install
npm run build
npm link          # puts `scrape` on your PATH
```

Or just run it from the repo without installing globally:

```bash
npm run dev -- https://example.com -o ./out -m 50
```

## Usage

```bash
scrape <url> [options]
```

### Options

| Flag | Default | Description |
|---|---|---|
| `-o, --out <dir>` | `./scraped` | Output directory |
| `-m, --max <n>` | `200` | Maximum pages to crawl |
| `-d, --delay <ms>` | `500` | Delay before each request per worker |
| `-c, --concurrency <n>` | `2` | Parallel requests |
| `-r, --retries <n>` | `3` | Retries on failure (exponential backoff) |
| `--allow <host>` | — | Extra allowed host (repeatable) |
| `--any-host` | off | Follow links to any host |
| `--ignore-robots` | off | Skip robots.txt checks (be careful) |
| `--user-agent <ua>` | `scrape-cli/0.1.0` | Custom `User-Agent` header |
| `-h, --help` | — | Show help |

### Examples

Crawl a small site, one request at a time, gentle on the server:

```bash
scrape https://example.com -o ./example -m 100 -d 1000 -c 1
```

Crawl a site that serves content from a CDN host too:

```bash
scrape https://example.com --allow cdn.example.com -o ./example
```

Crawl a framed "book reader" site where chapters live in `<iframe>`s:

```bash
scrape "http://www.tyanev.com/home.php?lang=bg&mod=1&mid=18" -o ./tyanev -m 500 -d 800
```

## Output layout

Given `scrape https://example.com/docs/intro -o ./out`, files land at:

```
out/
└── example.com/
    ├── docs/
    │   └── intro.html
    ├── home__lang_en_mod_1_mid_18.html      ← query string becomes a readable suffix
    ├── resources/
    │   ├── books/
    │   │   └── chapter_01.html              ← iframe content, fetched and saved
    │   └── docs/
    │       └── reference.pdf                ← non-HTML saved with real extension
    └── styles/
        └── style.css                        ← if you uncomment the asset extractors
```

Every HTML file is rewritten to `charset=utf-8` before saving, so double-clicking any file opens readable text — no local server required.

## How it works

Roughly three layers:

1. **Queue + workers.** A `queue: string[]` holds discovered URLs. N workers pull from it, sleep `--delay`, fetch, process, repeat. A `pending` counter tracks in-flight requests so workers exit only when the queue is truly drained — not when it's momentarily empty while one worker hasn't yet enqueued its links.

2. **Dedup.** A `visited: Set<string>` holds normalized URLs (hash stripped, redirect target canonicalized). Every extractor checks it before enqueuing. This is what prevents `?a=1&b=2` and `?b=2&a=1` from being crawled twice — well, it doesn't sort params, but it does strip hashes and follow redirects. Good enough for most sites.

3. **Extraction.** [Cheerio](https://cheerio.js.org/) parses the HTML into a DOM tree. A shared `enqueue()` helper normalizes and filters candidate URLs, and each tag type feeds it:

   ```ts
   $("a[href]").each((_, el) => enqueue($(el).attr("href")));
   $("iframe[src]").each((_, el) => enqueue($(el).attr("src")));
   $("object[data]").each((_, el) => enqueue($(el).attr("data")));
   ```

   The `<object>` case reads `data`, not `src` — a small detail that matters on sites built with old HTML.

### Charset handling

The server may send `windows-1251`, `shift_jis`, or no charset at all. `decodeHtml()`:

1. Buffers the full response as raw bytes
2. Sniffs the charset from the first 2 KB (`<meta http-equiv>`) or the `Content-Type` header
3. Decodes with `new TextDecoder(charset)` — which throws on unknown labels, so it falls back to UTF-8
4. Rewrites the meta tag to `utf-8` and writes the *mutated* tree (`$.html()`), not the original string

That last step is a common footgun: `cheerio.load()` gives you a mutable tree, but the `html` variable you passed in is untouched. Writing `html` instead of `$.html()` silently discards every modification.

### Buffers and binary content

Non-HTML responses are handled before Cheerio ever sees them:

```ts
if (!isHtml) {
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buf);
  return;
}
```

A `Buffer` is a chunk of raw bytes. You can't put a PDF into a JS string without corrupting it, because a string will try to interpret those bytes as UTF-16 and replace anything invalid with U+FFFD. So PDFs, images, and fonts go straight from the network buffer to disk. The extension comes from `Content-Type`, not the URL path, which handles cases like `home.php?getfile=xyz` returning a PDF.

## Limitations

- **No JavaScript execution.** If a page renders its content client-side (React, Vue, etc.), Cheerio sees an empty `<div id="root">` and nothing else. Use Playwright or Puppeteer for those.
- **No asset rewriting.** Links stay absolute (`https://example.com/…`). If you want a fully offline mirror, uncomment the `link[href]`, `img[src]`, and `script[src]` extractors in `crawler.ts` — that fetches them, but doesn't yet rewrite the HTML to point at the local files.
- **No resume.** If the process dies mid-crawl, `visited` is lost and the next run starts from zero. A `state.json` is an obvious next step.
- **No content deduplication.** Pages that differ only by a tracking param (`?utm_source=…`) are treated as distinct. `canonicalize()` on URL params would help.
- **Query-string order matters.** `?a=1&b=2` and `?b=2&a=1` are treated as distinct URLs. Sorting params before hashing in `visited` would fix this.

## Etiquette

This tool honors `robots.txt` and sends an identifiable `User-Agent` by default. **Do not remove those defaults when crawling sites you don't own.** Rate-limit with `--delay` and `--concurrency 1` on unfamiliar hosts. `robots.txt` is a technical signal, not a contract — check the site's Terms of Service before bulk-downloading. For a single textbook you have legitimate access to, one polite crawl is fine; running this daily against a stranger's server is not.

## License

MIT — see [LICENSE](./LICENSE) if present, or add one.
