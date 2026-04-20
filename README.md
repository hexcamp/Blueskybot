# Blueskybot

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Bluesky](https://img.shields.io/badge/Bluesky-AT%20Protocol-0085ff?logo=bluesky&logoColor=white)](https://bsky.app/)

A lightweight Node.js bot that monitors RSS feeds and posts new articles to [Bluesky](https://bsky.app) with rich embed cards.

## Features

- Monitors multiple RSS feeds on a configurable polling interval
- Posts new articles with rich embed cards (title, description, thumbnail)
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

### 3. Configure RSS feeds

```bash
cp feeds.txt.example feeds.txt
```

Edit `feeds.txt` — one feed per line, no quotes or brackets needed:

```
https://example.com/feed.xml | Example News
https://another.site/rss     | Another Feed
https://minimal.org/rss
```

Lines starting with `#` are comments. The title after `|` is optional — if provided, it prefixes the Bluesky post.

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
| `MAX_IMAGE_SIZE`            | `1000000`  | Max thumbnail size in bytes (1 MB)          |

## Project Structure

```
Blueskybot/
├── bot.mjs              # Main application
├── bot.test.mjs         # Unit tests (node:test, run with npm test)
├── feeds.txt            # Your RSS feeds (not tracked by git)
├── feeds.txt.example    # Feed configuration template
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
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  RSS Feeds  │────>│   bot.mjs    │────>│  Bluesky (AT     │
│  (polling)  │     │  parse/filter│     │  Protocol API)   │
└─────────────┘     └──────┬───────┘     └─────────────────┘
                           │
                    ┌──────┴───────┐
                    │ OG metadata  │
                    │ fetch + image│
                    │ upload       │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │ lastPosted   │
                    │ Links.json   │
                    └──────────────┘
```

1. **Poll** RSS feeds at a fixed interval
2. **Filter** articles to those published within the last hour
3. **Deduplicate** against locally stored posted links
4. **Extract image** from the RSS item: checks `enclosure`, `media:thumbnail`, and `media:content` in order, then falls back to the first `<img src>` found in `item.content` HTML
5. **Fetch** Open Graph metadata (title, description, `og:image`) from the article URL when the RSS item itself is missing title, description, or image
6. **Upload** thumbnail image as blob to Bluesky
7. **Post** to Bluesky with `app.bsky.embed.external` embed card
8. **Persist** the posted link to avoid duplicates on restart

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Invalid identifier or password` | Verify `.env` credentials. Use an [App Password](https://bsky.app/settings/app-passwords). |
| `API rate limit reached` | The bot automatically waits and retries. No action needed. |
| Thumbnails missing on some posts | The bot tries RSS media fields, content HTML `<img>` tags, and `og:image` in order. If all fail, the source site may have no accessible image or the image exceeds 1 MB. |
| `FETCH_TIMEOUT` errors | The target site is slow or unreachable. The post will still be created without a thumbnail. |
| Container unhealthy | Check logs with `docker compose logs` — likely a credential or network issue. |

## Contributing

This is a personal project that I maintain on my own time, so I can't commit to reviewing issues or pull requests. That said, you're very welcome to fork the repository and adapt it to your needs — that's what open source is for.

## License

[MIT](LICENSE) &copy; Christian Gillinger
