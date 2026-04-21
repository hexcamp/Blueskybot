import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { getImageUrlFromItem, resizeImageForAltText, generateAltText } from './bot.mjs';

// ---------------------------------------------------------------------------
// getImageUrlFromItem
// ---------------------------------------------------------------------------

test('enclosure image/* returns enclosure URL', () => {
  const item = { enclosure: { url: 'https://example.com/image.jpg', type: 'image/jpeg' } };
  assert.equal(getImageUrlFromItem(item), 'https://example.com/image.jpg');
});

test('mediaThumbnail returns thumbnail URL', () => {
  const item = { mediaThumbnail: [{ $: { url: 'https://example.com/thumb.jpg' } }] };
  assert.equal(getImageUrlFromItem(item), 'https://example.com/thumb.jpg');
});

test('mediaContent medium=image returns content URL', () => {
  const item = { mediaContent: [{ $: { url: 'https://example.com/media.jpg', medium: 'image' } }] };
  assert.equal(getImageUrlFromItem(item), 'https://example.com/media.jpg');
});

test('content HTML <img src> fallback returns image URL', () => {
  const item = { content: '<p>Text</p><img src="https://example.com/content.jpg" alt="x"/>' };
  assert.equal(getImageUrlFromItem(item), 'https://example.com/content.jpg');
});

test('content HTML <img> with invalid URL returns null', () => {
  const item = { content: '<img src="javascript:alert(1)" />' };
  assert.equal(getImageUrlFromItem(item), null);
});

test('item with no image fields returns null', () => {
  assert.equal(getImageUrlFromItem({}), null);
});

test('enclosure takes priority over content HTML fallback', () => {
  const item = {
    enclosure: { url: 'https://example.com/enclosure.jpg', type: 'image/jpeg' },
    content: '<img src="https://example.com/content.jpg" />',
  };
  assert.equal(getImageUrlFromItem(item), 'https://example.com/enclosure.jpg');
});

// ---------------------------------------------------------------------------
// resizeImageForAltText
// ---------------------------------------------------------------------------

test('resizeImageForAltText returns buffer with mimeType image/jpeg', async () => {
  const src = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 150, b: 200 } },
  }).jpeg().toBuffer();

  const result = await resizeImageForAltText(src, 512);

  assert.equal(result.mimeType, 'image/jpeg');
  assert.ok(Buffer.isBuffer(result.buffer), 'result.buffer must be a Buffer');
});

test('resizeImageForAltText output dimensions are ≤ maxDim', async () => {
  const src = await sharp({
    create: { width: 1024, height: 768, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).jpeg().toBuffer();

  const result = await resizeImageForAltText(src, 512);
  const meta = await sharp(result.buffer).metadata();

  assert.ok(meta.width <= 512, `width ${meta.width} should be ≤ 512`);
  assert.ok(meta.height <= 512, `height ${meta.height} should be ≤ 512`);
});

test('resizeImageForAltText does not enlarge images smaller than maxDim', async () => {
  const src = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).jpeg().toBuffer();

  const result = await resizeImageForAltText(src, 512);
  const meta = await sharp(result.buffer).metadata();

  assert.ok(meta.width <= 100, `width ${meta.width} should not exceed original 100`);
  assert.ok(meta.height <= 100, `height ${meta.height} should not exceed original 100`);
});

// ---------------------------------------------------------------------------
// generateAltText
// ---------------------------------------------------------------------------

test('generateAltText sends correct base64 and prompt, returns trimmed text', async () => {
  const capturedRequests = [];

  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    capturedRequests.push({ url, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '  A red square on white background  ' }] } }],
      }),
    };
  };

  const buf = Buffer.from('fake-image-data');
  const result = await generateAltText(buf, 'image/jpeg', mockFetch);

  assert.equal(result, 'A red square on white background');
  assert.equal(capturedRequests.length, 1);

  const parts = capturedRequests[0].body.contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'image/jpeg');
  assert.equal(parts[0].inlineData.data, buf.toString('base64'));
  assert.ok(parts[1].text.includes('alt text'), 'prompt should mention alt text');
});

test('generateAltText returns empty string on network error', async () => {
  const mockFetch = async () => { throw new Error('network error'); };
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result, '');
});

test('generateAltText returns empty string after 429 retries exhausted', async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return { ok: false, status: 429 };
  };

  // retryDelayMs=1 keeps the test near-instant
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch, 1);

  assert.equal(result, '');
  assert.equal(callCount, 3, 'should attempt exactly 3 times');
});

test('generateAltText returns empty string on non-2xx response', async () => {
  const mockFetch = async () => ({ ok: false, status: 500 });
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result, '');
});

test('generateAltText returns empty string when response has no text', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [] }),
  });
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result, '');
});

test('generateAltText truncates response to 300 characters', async () => {
  const longText = 'a'.repeat(400);
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: longText }] } }],
    }),
  });
  const result = await generateAltText(Buffer.from('x'), 'image/jpeg', mockFetch);
  assert.equal(result.length, 300);
});
