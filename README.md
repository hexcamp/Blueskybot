# Blueskybot

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Bluesky](https://img.shields.io/badge/Bluesky-AT%20Protocol-0085ff?logo=bluesky&logoColor=white)](https://bsky.app/)

A lightweight Node.js bot that monitors RSS feeds and posts new articles to [Bluesky](https://bsky.app). Features rich embed cards, AI-generated alt text for image accessibility via Google Gemini or OpenAI, and a pluggable provider system so any source — JSON APIs, scrapers, etc. — can be added by dropping a single file into `providers/`.

> **Recent changes (April 2026):**
> - Alt-text images downscaled to 256 px (was 512) — ~50% fewer Gemini/OpenAI tokens
> - Parallel alt-text prefetch: up to 3 images processed concurrently per feed cycle
> - Article title and description passed as context hint to the vision model — reduces misidentification
> - Defer-on-failure retry queue: items whose alt text fails are retried for up to 5 cycles before posting without alt text
> - In-memory alt-text cache: the same image URL is never sent to the API twice per process lifetime
> - Favicons, logos, and icons skip the API entirely and use a generic alt text

## Features

- Monitors multiple RSS feeds on a configurable polling interval
- Posts new articles to Bluesky with rich embed cards (title, description, thumbnail)
- **AI-generated alt text** for images via Google Gemini or OpenAI — making posts accessible to visually impaired users; configure with a single env var
  - Article title and description are passed as context to the vision model, improving accuracy for named people and events
  - Up to 3 images prefetched in parallel per feed cycle to reduce posting latency
  - Failed alt-text calls trigger a retry queue (`deferredItems.json`); items retry for up to 5 cycles before posting without alt text as a last resort
  - In-memory cache prevents duplicate API calls when the same image URL appears across feeds or retries
  - Favicons, logos, and icons skip the vision API entirely
- **Pluggable provider architecture** — RSS out of the box, and trivial to add your own source
- Extracts thumbnail images from RSS media fields (`enclosure`, `media:thumbnail`, `media:content`) or, as a fallback, from `<img>` tags embedded in the feed's `content` HTML — so feeds that don't use dedicated media fields still get images
- Falls back to Open Graph metadata (`og:image`, `og:title`, `og:description`) when the RSS item itself lacks the information
- Tracks posted links locally to prevent duplicates
- Persistent session management (logs in once, re-authenticates on expiry)
- Respects Bluesky API rate limits with separate read/write tracking
- Request timeouts and URL validation for reliability and security
- Runs as non-root user in Docker with health checks

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (or [Docker](https://www.docker.com/))
- A [Bluesky](https://bsky.app) account
- One or more RSS feed URLs to monitor

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/cgillinger/Blueskybot.git
cd Blueskybot
npm install
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Edit `.env` with your Bluesky credentials:

```env
BLUESKY_USERNAME=your_handle@bsky.social
BLUESKY_PASSWORD=your_app_password
```

> **Tip:** Use an [App Password](https://bsky.app/settings/app-passwords) instead of your main password.

### 3. Configure feeds

```bash
cp feeds.txt.example feeds.txt
```

Edit `feeds.txt` — one entry per line, no quotes or brackets needed:

```
# This is a comment — the line is ignored
https://example.com/feed.xml | Example News
https://another.site/rss     | Another Feed
https://minimal.org/rss

# Disabled feed:
# https://example.com/other-feed.rss | Other Source
```

Lines starting with `#` are comments and empty lines are ignored. The title after `|` is optional — if provided, it prefixes the Bluesky post.

Any bare `http(s)://…` URL is treated as an RSS feed. A `prefix://id` entry routes to a custom provider — see [Custom providers](#custom-providers) below.

### 4. Run

```bash
npm start
```

The bot polls every minute and posts articles published within the last hour. Conditional HTTP requests (ETag/Last-Modified) keep unchanged polls near-zero cost.

## Docker

### Using Docker Compose (recommended)

```bash
cp .env.example .env          # configure credentials
cp feeds.txt.example feeds.txt # configure feeds
docker compose up -d --build
```

```bash
docker compose logs -f        # follow logs
docker compose down           # stop
```

> **Note:** `feeds.txt` is baked into the Docker image at build time — it is **not** mounted as a volume. If you edit `feeds.txt` on the host after the initial build, you must rebuild the image for the change to take effect:
> ```bash
> docker compose build && docker compose up -d
> ```
> After rebuilding, verify that the correct feeds were loaded:
> ```bash
> docker logs blueskybot --tail 20
> # Expected: Loaded N feed(s) from feeds.txt.
> ```

### Using Docker directly

```bash
docker build -t blueskybot .
docker run -d --name blueskybot --env-file .env --restart always blueskybot
```

The container uses `node:18-alpine`, runs as a non-root user, and includes a health check.

## Configuration

All configuration constants are defined at the top of `bot.mjs`:

| Constant                    | Default    | Description                                 |
|-----------------------------|------------|---------------------------------------------|
| `POLL_INTERVAL_MS`          | `60000`    | Polling interval (1 min)                    |
| `PUBLICATION_WINDOW_MS`     | `3600000`  | Only post articles newer than this (1 hour) |
| `MAX_TRACKED_LINKS_PER_FEED`| `100`      | Duplicate tracking buffer per feed          |
| `FETCH_TIMEOUT_MS`          | `15000`    | HTTP request timeout (15 sec)               |
| `MAX_IMAGE_SIZE`            | `1000000`  | Max image size in bytes (1 MB)              |
| `ALT_IMAGE_MAX_DIMENSION`   | `256`      | Max px per side when downscaling for Gemini |
| `ALT_TEXT_CONCURRENCY`     | `3`        | Max parallel alt-text API calls per feed cycle |
| `ALT_TEXT_MAX_RETRIES`     | `5`        | Retry cycles before posting without alt text |

Environment variables (set in `.env`):

| Variable            | Default  | Description                                          |
|---------------------|----------|------------------------------------------------------|
| `BLUESKY_USERNAME`  | —        | Your Bluesky handle or email                         |
| `BLUESKY_PASSWORD`  | —        | Your Bluesky password or App Password                |
| `ALT_TEXT_ENABLED`  | `false`  | Set to `true` to enable AI-generated alt-text        |
| `ALT_TEXT_LANGUAGE` | `en`     | BCP-47 language code for alt-text (e.g. `sv`, `fi`) |
| `ALT_TEXT_PROVIDER` | `gemini` | Alt-text provider — `gemini` or `openai`             |
| `GEMINI_API_KEY`    | —        | Required when `ALT_TEXT_PROVIDER=gemini`             |
| `OPENAI_API_KEY`    | —        | Required when `ALT_TEXT_PROVIDER=openai`             |

## Custom providers

A **provider** is a small ES module that knows how to fetch news items from a specific source and return them in a normalized shape. The only built-in provider is RSS, used automatically for any bare `http(s)://` entry in `feeds.txt`.

Each provider lives in `providers/<name>.mjs` and exports a single async function. To add a new one, copy [`providers/_template.mjs`](providers/_template.mjs) and register it in `bot.mjs`:

```js
import myProvider from './providers/my-provider.mjs';

const providers = {
  'rss': rssFetcher,
  'my-provider': myProvider,   // ← your provider
};
```

Entries in `feeds.txt` then use the prefix you registered:

```
my-provider://some-id | Display Title
```

A provider receives the parsed feed config (`{ type, id, title }` or `{ type, url, title }`) and the shared HTTP cache, and returns an array of normalized items:

```js
{
  title: 'Article title',
  link: 'https://example.com/article',
  description: 'Short summary, max ~300 chars',
  imageUrl: 'https://example.com/thumb.jpg',  // or null
  pubDate: '2026-04-24T12:00:00Z',              // anything new Date() understands
}
```

Return `null` instead of an array to signal "nothing changed since last poll" (e.g. for sources that support HTTP 304). The rest of the pipeline — OG-metadata fallback, alt-text, deduplication, posting — is provider-agnostic and handles whatever the provider returns.

### Alt-text for images

The bot automatically generates image descriptions using Google's Gemini AI **or** OpenAI's `gpt-4o-mini`, making posts accessible to visually impaired users. Pick the provider with `ALT_TEXT_PROVIDER` (`gemini` is the default). When enabled, posts with images use `app.bsky.embed.images` with AI-generated alt text instead of plain link preview cards. The article URL is always included in the post text, so readers can still open the article.

#### Step 1 — Get a free Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in with a Google account
2. Click **Create API key** → **Create API key in new project** (or pick an existing project)
3. Copy the key — it looks like `AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`

> The free tier includes approximately 250 requests per day, which covers most RSS volumes. No billing required.

#### Step 2 — Enable alt-text in `.env`

```env
ALT_TEXT_ENABLED=true
ALT_TEXT_LANGUAGE=sv        # BCP-47 code: sv=Swedish, en=English, fi=Finnish, de=German …
ALT_TEXT_PROVIDER=gemini    # or "openai"
GEMINI_API_KEY=AIzaSyXXXX   # required when ALT_TEXT_PROVIDER=gemini
# OPENAI_API_KEY=sk-XXXX    # required when ALT_TEXT_PROVIDER=openai
```

The bot validates the key at startup. If `ALT_TEXT_ENABLED=true` and the key for the selected provider is missing, the bot exits immediately with a clear error message.

#### How it works

1. Extracts the article image from the RSS feed (or falls back to `og:image`)
2. Up to 3 images per feed are prefetched in parallel — alt-text is generated concurrently to reduce end-to-end latency
3. Favicons, logos, and icons (matched by URL pattern) skip the API and receive a generic `"Image"` alt text
4. If the same image URL was already processed in this run, the cached result is reused — no duplicate API call
5. Downscales a copy to at most **256 × 256 px** and converts it to JPEG (roughly half the Gemini token cost of the previous 512 px limit)
6. Sends the downscaled copy along with the **article title and description as a context hint**: *"Describe this image as alt text… Context from the article: `<title — description>`. Use this to identify people or events, but only describe what is actually visible."*
7. Uploads the **original full-resolution image** to Bluesky
8. Posts with `app.bsky.embed.images` including the AI-generated alt text

**When alt text fails:** rather than posting immediately without alt text, the item is moved to a retry queue (`deferredItems.json`). Each subsequent poll cycle retries the alt-text call. After `ALT_TEXT_MAX_RETRIES` (default 5) failed cycles, the item is posted as a last resort — either with an empty alt text (if the image could be fetched) or as a plain link card.

If Gemini is unavailable or rate-limited (HTTP 429), the bot retries up to 3 times with exponential backoff (2 s → 4 s → 8 s) before considering the attempt failed.

#### Troubleshooting alt-text

| Problem | Solution |
|---------|----------|
| `ALT_TEXT_ENABLED=true but GEMINI_API_KEY is not set` | Add `GEMINI_API_KEY=…` to `.env` and restart |
| `ALT_TEXT_PROVIDER=openai but OPENAI_API_KEY is not set` | Add `OPENAI_API_KEY=…` to `.env` and restart |
| Alt-text is in the wrong language | Check `ALT_TEXT_LANGUAGE` — use a BCP-47 code like `sv`, `en`, `fi` |
| Posts fall back to link cards | The image may exceed 1 MB or be unreachable. Check logs for details |
| `Gemini returned HTTP 403` | The API key is invalid or restricted — regenerate it in Google AI Studio |
| `Gemini rate limit persisted after 3 retries` | You've hit the free-tier daily limit (≈250 req/day). The item is deferred and retried next cycle |
| Item deferred for many cycles | Alt-text is consistently failing (quota, network). After `ALT_TEXT_MAX_RETRIES` cycles the item posts without alt text |
| `OpenAI returned HTTP 401` | The OpenAI API key is invalid or revoked — regenerate it in your OpenAI dashboard |
| `OpenAI returned HTTP 429` / `OpenAI rate limit persisted after 3 retries` | You've hit your OpenAI rate or spend limit. The bot continues posting without alt-text |

## Project Structure

```
Blueskybot/
├── bot.mjs              # Main application — loop, posting, embeds, dedup
├── bot.test.mjs         # Unit tests (node:test, run with npm test)
├── providers/           # Pluggable source providers
│   ├── rss.mjs          # RSS/Atom (default, no prefix in feeds.txt)
│   └── _template.mjs    # Skeleton for writing your own provider
├── feeds.txt            # Your feeds (not tracked by git)
├── feeds.txt.example    # Feed configuration template
├── deferredItems.json   # Alt-text retry queue (auto-created, not tracked by git)
├── Dockerfile           # Container image (Alpine, non-root)
├── docker-compose.yml   # Compose orchestration
├── package.json         # Dependencies and scripts
├── .env.example         # Credential template
├── .gitignore
├── LICENSE              # MIT
└── README.md
```

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  RSS Feeds  │────>│    bot.mjs       │────>│  Bluesky (AT    │
│  (polling)  │     │  parse / filter  │     │  Protocol API)  │
└─────────────┘     └────────┬─────────┘     └─────────────────┘
                             │
                    ┌────────┴─────────┐
                    │ OG metadata      │
                    │ fetch + image    │
                    │ upload           │
                    └────────┬─────────┘
                             │
                    ┌────────┴─────────┐      ┌──────────────┐
                    │ Gemini alt-text  │─────>│ Google       │
                    │ (optional)       │      │ Gemini API   │
                    └────────┬─────────┘      └──────────────┘
                             │
                    ┌────────┴─────────┐
                    │ lastPosted       │
                    │ Links.json       │
                    └──────────────────┘
```

1. **Poll** RSS feeds at a fixed interval
2. **Filter** articles to those published within the last hour
3. **Deduplicate** against locally stored posted links
4. **Extract image** from the RSS item: checks `enclosure`, `media:thumbnail`, and `media:content` in order, then falls back to the first `<img src>` found in `item.content` HTML
5. **Fetch** Open Graph metadata (title, description, `og:image`) from the article URL when the RSS item itself is missing title, description, or image
6. **Prefetch alt text in parallel** (if `ALT_TEXT_ENABLED=true`) — up to 3 images concurrently per feed; article title and description are sent as context to the vision model
7. **Upload** image as blob to Bluesky
8. **Post** to Bluesky — with `app.bsky.embed.images` (alt-text enabled) or `app.bsky.embed.external` (link card). If alt text failed, the item is deferred to the retry queue rather than posted immediately without alt text
9. **Persist** the posted link to avoid duplicates on restart

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Invalid identifier or password` | Verify `.env` credentials. Use an [App Password](https://bsky.app/settings/app-passwords). |
| `API rate limit reached` | The bot automatically waits and retries. No action needed. |
| Thumbnails missing on some posts | The bot tries RSS media fields, content HTML `<img>` tags, and `og:image` in order. If all fail, the source site may have no accessible image or the image exceeds 1 MB. |
| `FETCH_TIMEOUT` errors | The target site is slow or unreachable. The post will still be created without a thumbnail. |
| Container unhealthy | Check logs with `docker compose logs` — likely a credential or network issue. |
| Commented-out feed still posts | `feeds.txt` is baked into the image at build time. Editing it on the host has no effect until you rebuild: `docker compose build && docker compose up -d`. Verify with `docker logs blueskybot --tail 20`. |

## Contributing

This is a personal project that I maintain on my own time, so I can't commit to reviewing issues or pull requests. That said, you're very welcome to fork the repository and adapt it to your needs — that's what open source is for.

## License

[MIT](LICENSE) &copy; Christian Gillinger
