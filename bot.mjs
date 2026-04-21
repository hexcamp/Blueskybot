// Import necessary modules
import { BskyAgent } from '@atproto/api';
import RSSParser from 'rss-parser';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

// Load environment variables from .env file (for Bluesky credentials)
dotenv.config();

// Configuration constants
const POLL_INTERVAL_MS = 60 * 1000;              // 1 minute — RSS conditional requests make this cheap
const PUBLICATION_WINDOW_MS = 60 * 60 * 1000;    // 1 hour
const MAX_TRACKED_LINKS_PER_FEED = 100;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_SIZE = 1_000_000;                 // 1 MB (Bluesky limit)

const ALT_TEXT_ENABLED = process.env.ALT_TEXT_ENABLED === 'true';
const ALT_TEXT_LANGUAGE = process.env.ALT_TEXT_LANGUAGE || 'en';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ALT_IMAGE_MAX_DIMENSION = 512;

// Rate limit configuration based on Bluesky's API documentation
const RATE_LIMIT_API_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes
const MAX_API_CALLS_PER_5_MINUTES = 3000;
const MAX_CREATES_PER_HOUR = 1666;

// File paths
const FEEDS_FILE = 'feeds.txt';
const LAST_POSTED_LINKS_FILE = 'lastPostedLinks.json';

/**
 * Load RSS feeds from feeds.txt.
 * Format: one feed per line, optional title after " | ".
 * Lines starting with # and empty lines are ignored.
 */
async function loadFeeds() {
  let content;
  try {
    content = await fs.readFile(FEEDS_FILE, 'utf-8');
  } catch {
    console.error(`Missing ${FEEDS_FILE} — copy feeds.txt.example to feeds.txt and add your feeds.`);
    process.exit(1);
  }

  const feeds = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [url, title] = line.split('|').map(part => part.trim());
      return { url, title: title || null };
    });

  if (feeds.length === 0) {
    console.error(`No feeds found in ${FEEDS_FILE}. Add at least one RSS feed URL.`);
    process.exit(1);
  }

  return feeds;
}

// Initialize Bluesky agent with service URL
const agent = new BskyAgent({ service: 'https://bsky.social' });
const parser = new RSSParser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
    ],
  },
});

// State
let lastPostedLinks = {};
let apiCallCount = 0;
let createActionCount = 0;
let lastApiReset = Date.now();
let lastCreateReset = Date.now();
let isLoggedIn = false;

// Cache for conditional RSS requests (ETag / Last-Modified per feed URL)
const feedHttpCache = new Map();

/**
 * Fetch with timeout to prevent hanging requests.
 */
function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

/**
 * Validate URL scheme to prevent SSRF (only allow http/https).
 */
function isValidHttpUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Load last posted entries from file if it exists
async function loadLastPostedLinks() {
  try {
    const data = await fs.readFile(LAST_POSTED_LINKS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// Save last posted entries to file
async function saveLastPostedLinks() {
  await fs.writeFile(LAST_POSTED_LINKS_FILE, JSON.stringify(lastPostedLinks, null, 2));
}

/**
 * Rate limiting function
 * Ensures the bot adheres to Bluesky's API rate limits.
 * @param {boolean} isCreate - Whether this is a create action (post/upload)
 */
async function rateLimit(isCreate = false) {
  const now = Date.now();

  if (now - lastApiReset >= RATE_LIMIT_API_WINDOW_MS) {
    apiCallCount = 0;
    lastApiReset = now;
  }
  if (now - lastCreateReset >= PUBLICATION_WINDOW_MS) {
    createActionCount = 0;
    lastCreateReset = now;
  }

  if (apiCallCount >= MAX_API_CALLS_PER_5_MINUTES) {
    const waitTime = RATE_LIMIT_API_WINDOW_MS - (now - lastApiReset);
    console.log(`API rate limit reached. Waiting ${Math.ceil(waitTime / 1000)}s.`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    apiCallCount = 0;
    lastApiReset = Date.now();
  }

  if (isCreate && createActionCount >= MAX_CREATES_PER_HOUR) {
    const waitTime = PUBLICATION_WINDOW_MS - (now - lastCreateReset);
    console.log(`CREATE limit reached. Waiting ${Math.ceil(waitTime / 1000)}s.`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    createActionCount = 0;
    lastCreateReset = Date.now();
  }

  apiCallCount++;
  if (isCreate) createActionCount++;
}

/**
 * Check if an RSS entry was published within the publication window.
 */
function isPublishedWithinWindow(pubDate) {
  return new Date(pubDate).getTime() >= Date.now() - PUBLICATION_WINDOW_MS;
}

/**
 * Check if a link has already been posted (across ALL feeds).
 * Different feeds can contain the same article, so we check globally.
 */
function isAlreadyPosted(feedUrl, link) {
  return Object.values(lastPostedLinks).some(links => links.includes(link));
}

/**
 * Record a link as posted.
 */
function recordPostedLink(feedUrl, link) {
  if (!lastPostedLinks[feedUrl]) {
    lastPostedLinks[feedUrl] = [];
  }
  if (!lastPostedLinks[feedUrl].includes(link)) {
    lastPostedLinks[feedUrl].push(link);
  }
  if (lastPostedLinks[feedUrl].length > MAX_TRACKED_LINKS_PER_FEED) {
    lastPostedLinks[feedUrl].shift();
  }
}

/**
 * Remove a link from the posted list (rollback on failed post).
 */
function unrecordPostedLink(feedUrl, link) {
  if (!lastPostedLinks[feedUrl]) return;
  const idx = lastPostedLinks[feedUrl].indexOf(link);
  if (idx !== -1) lastPostedLinks[feedUrl].splice(idx, 1);
}

/**
 * Ensure we have a valid Bluesky session. Logs in only when needed.
 */
async function ensureLoggedIn() {
  if (isLoggedIn && agent.session) return;

  if (!process.env.BLUESKY_USERNAME || !process.env.BLUESKY_PASSWORD) {
    throw new Error('Bluesky credentials missing in .env file.');
  }

  await agent.login({
    identifier: process.env.BLUESKY_USERNAME,
    password: process.env.BLUESKY_PASSWORD,
  });
  isLoggedIn = true;
  console.log('Logged in to Bluesky.');
}

/**
 * Fetch an RSS feed using conditional HTTP requests (ETag / If-Modified-Since).
 * Returns parsed feed data if the feed has new content, or null if unchanged (304).
 * This keeps polling cheap: unchanged feeds return ~200 bytes instead of the full XML.
 */
async function fetchFeedIfModified(feedUrl) {
  const cached = feedHttpCache.get(feedUrl);
  const headers = {};
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const response = await fetchWithTimeout(feedUrl, { headers });

  if (response.status === 304) {
    return null;
  }

  // Update cache with new headers
  feedHttpCache.set(feedUrl, {
    etag: response.headers.get('etag') || null,
    lastModified: response.headers.get('last-modified') || null,
  });

  const xml = await response.text();
  return parser.parseString(xml);
}

/**
 * Extract the first image URL from an RSS item's media fields.
 * Checks enclosure, mediaThumbnail, and mediaContent in order.
 */
function getImageUrlFromItem(item) {
  if (item.enclosure?.url && item.enclosure.type?.startsWith('image/') && isValidHttpUrl(item.enclosure.url)) {
    return item.enclosure.url;
  }
  const thumbUrl = item.mediaThumbnail?.[0]?.$.url;
  if (thumbUrl && isValidHttpUrl(thumbUrl)) {
    return thumbUrl;
  }
  const mc = item.mediaContent?.[0];
  if (mc) {
    const mcUrl = mc.$.url;
    if (mcUrl && (mc.$.medium === 'image' || mc.$.type?.startsWith('image/')) && isValidHttpUrl(mcUrl)) {
      return mcUrl;
    }
  }
  if (item.content) {
    const match = item.content.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match && isValidHttpUrl(match[1])) return match[1];
  }
  return null;
}

export { getImageUrlFromItem, resizeImageForAltText, generateAltText };

/**
 * Scrape OG metadata from a URL. Returns { title, description, imageUrl } or null on failure.
 */
async function fetchOgMetadata(url) {
  try {
    await rateLimit();
    const response = await fetchWithTimeout(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const title = $('meta[property="og:title"]').attr('content') || '';
    const description = $('meta[property="og:description"]').attr('content') || '';
    const imageUrl = $('meta[property="og:image"]').attr('content') || null;

    return { title, description, imageUrl: imageUrl && isValidHttpUrl(imageUrl) ? imageUrl : null };
  } catch (error) {
    console.error(`Failed to fetch OG metadata for ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Resize an image so its longest side is ≤ maxDim and convert to JPEG.
 * The result is used only for the Gemini API call; the original is uploaded to Bluesky.
 * @returns {{ buffer: Buffer, mimeType: string }}
 */
async function resizeImageForAltText(imageBuffer, maxDim = ALT_IMAGE_MAX_DIMENSION) {
  try {
    const resized = await sharp(imageBuffer)
      .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { buffer: resized, mimeType: 'image/jpeg' };
  } catch (err) {
    console.warn(`Image resize for alt text failed: ${err.message}`);
    return { buffer: imageBuffer, mimeType: 'image/jpeg' };
  }
}

/**
 * Ask Gemini 2.5 Flash to describe an image for visually impaired users.
 * Returns a trimmed string ≤ 300 chars, or '' on any error (graceful degradation).
 * Retries up to 3 times with exponential backoff on HTTP 429.
 *
 * @param {Buffer} imageBuffer
 * @param {string} mimeType
 * @param {Function} [fetchFn] - injectable for testing (defaults to fetchWithTimeout)
 * @param {number} [retryDelayMs] - base retry delay in ms; override in tests for speed
 */
async function generateAltText(imageBuffer, mimeType, fetchFn = fetchWithTimeout, retryDelayMs = 1000) {
  const base64Data = imageBuffer.toString('base64');
  const prompt = `Describe this image as alt text for visually impaired users. Write in ${ALT_TEXT_LANGUAGE}. Be concise, max 250 characters. Describe only what is visible.`;
  const requestBody = {
    contents: [{
      parts: [
        { inlineData: { mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
  };
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchFn(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (response.status === 429) {
        const delayMs = Math.pow(2, attempt + 1) * retryDelayMs;
        console.warn(`Gemini rate limit (429). Retry ${attempt + 1}/3 in ${delayMs / 1000}s.`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      if (!response.ok) {
        console.warn(`Gemini returned HTTP ${response.status}. Skipping alt text.`);
        return '';
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        console.warn('Gemini returned no usable text. Skipping alt text.');
        return '';
      }
      return text.trim().slice(0, 300);
    } catch (err) {
      console.warn(`Gemini alt text error: ${err.message}`);
      return '';
    }
  }

  console.warn('Gemini rate limit persisted after 3 retries. Skipping alt text.');
  return '';
}

/**
 * Build the embed for a post.
 * When ALT_TEXT_ENABLED and the item has an image: returns app.bsky.embed.images with AI alt text.
 * Otherwise: returns app.bsky.embed.external (link card with optional thumbnail).
 */
async function buildEmbedCard(item, url) {
  try {
    if (!isValidHttpUrl(url)) {
      console.error(`Skipping invalid URL: ${url}`);
      return null;
    }

    let title = item.title || '';
    let description = item.contentSnippet || item.summary || '';
    let imageUrl = getImageUrlFromItem(item);

    // Fetch OG metadata if RSS is missing title or description
    let ogData = null;
    if (!title || !description) {
      ogData = await fetchOgMetadata(url);
      if (ogData) {
        title = title || ogData.title;
        description = description || ogData.description;
        imageUrl = imageUrl || ogData.imageUrl;
      }
    }

    // If still no image, try OG just for image (avoid re-fetching if already done)
    if (!imageUrl && !ogData) {
      ogData = await fetchOgMetadata(url);
      imageUrl = ogData?.imageUrl || null;
    }

    if (description.length > 300) {
      description = description.slice(0, 297) + '...';
    }

    // --- Images embed with Gemini alt text ---
    if (ALT_TEXT_ENABLED && imageUrl) {
      try {
        const imageResponse = await fetchWithTimeout(imageUrl);
        const contentType = imageResponse.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        const imageData = Buffer.from(await imageResponse.arrayBuffer());

        if (imageData.length > MAX_IMAGE_SIZE) {
          console.log(`Image too large (${imageData.length} bytes), falling back to embed.external without thumbnail.`);
        } else {
          let aspectRatio;
          try {
            const meta = await sharp(imageData).metadata();
            if (meta.width && meta.height) aspectRatio = { width: meta.width, height: meta.height };
          } catch (metaErr) {
            console.warn(`Could not read image dimensions: ${metaErr.message}`);
          }

          const { buffer: resizedBuffer, mimeType: resizedMime } = await resizeImageForAltText(imageData);
          const altText = await generateAltText(resizedBuffer, resizedMime);

          await rateLimit(true);
          const { data: { blob } } = await agent.uploadBlob(imageData, contentType);

          const imageEntry = { alt: altText, image: blob };
          if (aspectRatio) imageEntry.aspectRatio = aspectRatio;

          return {
            $type: 'app.bsky.embed.images',
            images: [imageEntry],
          };
        }
      } catch (imgError) {
        console.error(`Failed to build images embed: ${imgError.message}`);
      }
      // Alt-text path failed — return link card without thumbnail so the post still goes through
      return {
        $type: 'app.bsky.embed.external',
        external: { uri: url, title: title || 'Link', description },
      };
    }

    // --- Standard external link card ---
    const card = {
      $type: 'app.bsky.embed.external',
      external: { uri: url, title: title || 'Link', description },
    };

    if (imageUrl) {
      try {
        const imageResponse = await fetchWithTimeout(imageUrl);
        const contentType = imageResponse.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        const imageData = Buffer.from(await imageResponse.arrayBuffer());

        if (imageData.length > MAX_IMAGE_SIZE) {
          console.log(`Image too large (${imageData.length} bytes), skipping thumbnail.`);
        } else {
          await rateLimit(true);
          const uploadResponse = await agent.uploadBlob(imageData, contentType);
          card.external.thumb = uploadResponse.data.blob;
        }
      } catch (imgError) {
        console.error(`Failed to fetch/upload thumbnail: ${imgError.message}`);
      }
    }

    return card;
  } catch (error) {
    console.error(`Failed to build embed card for ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Process a single RSS feed and post new entries from the last hour.
 * Uses conditional HTTP requests — if the feed hasn't changed, skips immediately.
 */
async function processFeed(feed) {
  const { url: feedUrl, title: feedTitle } = feed;

  const feedData = await fetchFeedIfModified(feedUrl);

  if (!feedData) {
    return; // Feed unchanged (304) — nothing to do
  }

  let newPostsFound = false;

  for (const item of feedData.items) {
    if (!isPublishedWithinWindow(item.pubDate) || isAlreadyPosted(feedUrl, item.link)) {
      continue;
    }

    // Record link BEFORE posting to close the race-condition window.
    // If another cycle checks while we're posting, it will see the link as taken.
    recordPostedLink(feedUrl, item.link);
    await saveLastPostedLinks();

    try {
      const embedCard = await buildEmbedCard(item, item.link);
      await rateLimit(true);

      const postText = `${feedTitle ? `${feedTitle}: ` : ''}${item.title}\n\n${item.link}`;
      await agent.post({
        text: postText,
        embed: embedCard || undefined,
        langs: [ALT_TEXT_LANGUAGE],
      });

      console.log(`Posted: ${postText}`);
      newPostsFound = true;
    } catch (postError) {
      // Post failed — rollback so the link can be retried next cycle
      console.error(`Failed to post ${item.link}: ${postError.message}`);
      unrecordPostedLink(feedUrl, item.link);
      await saveLastPostedLinks();
    }
  }

  if (!newPostsFound) {
    console.log(`No new entries for ${feedUrl} in the last hour.`);
  }
}

/**
 * Main function to process RSS feeds.
 * Maintains a persistent session across poll cycles.
 */
async function postLatestRSSItems(feeds) {
  try {
    await ensureLoggedIn();

    for (const feed of feeds) {
      try {
        await processFeed(feed);
      } catch (error) {
        console.error(`Error processing feed ${feed.url}: ${error.message}`);
      }
    }
  } catch (error) {
    if (error?.status === 429) {
      console.log('Rate limit exceeded server-side. Waiting for next cycle.');
    } else if (error?.message?.includes('Authentication') || error?.message?.includes('token')) {
      console.error('Session expired, will re-login on next cycle.');
      isLoggedIn = false;
    } else {
      console.error('An error occurred:', error.message || error);
    }
  }
}

/**
 * Scheduling loop using setTimeout chaining.
 * Guarantees the next cycle only starts after the previous one finishes,
 * eliminating the race condition that setInterval would cause.
 */
async function runLoop(feeds) {
  while (true) {
    await postLatestRSSItems(feeds);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Bot starting up...');
  if (ALT_TEXT_ENABLED && !GEMINI_API_KEY) {
    console.error('ALT_TEXT_ENABLED=true but GEMINI_API_KEY is not set. Add it to .env and restart.');
    process.exit(1);
  }
  const feeds = await loadFeeds();
  console.log(`Loaded ${feeds.length} feed(s) from ${FEEDS_FILE}.`);
  lastPostedLinks = await loadLastPostedLinks();
  runLoop(feeds);
}
