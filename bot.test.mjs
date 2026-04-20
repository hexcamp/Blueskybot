import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getImageUrlFromItem } from './bot.mjs';

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
