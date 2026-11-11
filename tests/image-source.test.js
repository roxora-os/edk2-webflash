import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectFormat, hasSpecialMagic, imageChunks, inspectImage, imageStream, SECTOR,
} from '../src/image-source.js';
import { diskLikeImage, tempDir, xzFile, gzFile, xzWasmModule, collect } from './helpers.js';

const bytes = (...b) => new Uint8Array(b);

function streamOf(data, piece = 7777) {
  let p = 0;
  return new ReadableStream({
    pull(c) {
      if (p >= data.length) { c.close(); return; }
      c.enqueue(data.slice(p, p + piece));
      p += piece;
    },
  });
}

async function allChunks(data, chunkSize, piece) {
  const out = [];
  for await (const c of imageChunks(streamOf(data, piece), chunkSize)) out.push(c);
  return out;
}

function joinChunks(chunks) {
  return Buffer.concat(chunks.map((c) => c.data));
}

test('detectFormat', () => {
  assert.equal(detectFormat(bytes(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 4)).format, 'xz');
  assert.equal(detectFormat(bytes(0x1f, 0x8b, 8, 0)).format, 'gzip');
  assert.equal(detectFormat(new Uint8Array(16)).format, 'raw');
  for (const [head, word] of [
    [bytes(0x50, 0x4b, 0x03, 0x04), '.zip'],
    [bytes(0x28, 0xb5, 0x2f, 0xfd), 'zstd'],
    [bytes(0x42, 0x5a, 0x68, 0x39), 'bzip2'],
    [bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c), '.7z'],
  ]) {
    const r = detectFormat(head, 'x.bin');
    assert.equal(r.format, 'unsupported');
    assert.match(r.message, new RegExp(word.replace('.', '\\.')));
    assert.match(r.message, /Extract the \.img/);
  }
});

test('hasSpecialMagic: sparse, UBI, UBIFS', () => {
  assert.ok(hasSpecialMagic(bytes(0x3a, 0xff, 0x26, 0xed)));
  assert.ok(hasSpecialMagic(bytes(0x55, 0x42, 0x49, 0x23).reverse()));
  assert.ok(hasSpecialMagic(bytes(0x31, 0x18, 0x10, 0x06)));
  assert.ok(!hasSpecialMagic(bytes(0, 0, 0, 0)));
  assert.ok(!hasSpecialMagic(bytes(0x3a)));
});

test('imageChunks: exact multiple, offsets, reassembly', async () => {
  const data = diskLikeImage(4 * 65536, 2);
  const chunks = await allChunks(data, 65536, 5000);
  assert.deepEqual(chunks.map((c) => c.offset), [0, 65536, 131072, 196608]);
  assert.ok(chunks.every((c) => c.data.length === 65536));
  assert.ok(Buffer.from(data).equals(joinChunks(chunks)));
});

test('imageChunks: short last piece is padded to a sector', async () => {
  const data = diskLikeImage(65536 + 1000, 3);
  const chunks = await allChunks(data, 65536, 4096);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].data.length, 1024);
  const joined = joinChunks(chunks);
  assert.ok(Buffer.from(data).equals(joined.subarray(0, data.length)));
  assert.ok(joined.subarray(data.length).every((b) => b === 0));
});

test('imageChunks: a piece never starts with a sparse/UBI magic', async () => {
  const data = diskLikeImage(5 * 65536, 4);
  // Plant magics at piece boundaries, two sectors in a row at one of them.
  data.set([0x3a, 0xff, 0x26, 0xed], 65536);
  data.set([0x31, 0x18, 0x10, 0x06], 2 * 65536);
  data.set([0x31, 0x18, 0x10, 0x06], 2 * 65536 + SECTOR);
  data.set([0x23, 0x49, 0x42, 0x55], 4 * 65536);
  const chunks = await allChunks(data, 65536, 3000);
  for (const c of chunks.slice(1)) assert.ok(!hasSpecialMagic(c.data), `piece at ${c.offset}`);
  for (const c of chunks) assert.equal(c.offset % SECTOR, 0);
  assert.ok(Buffer.from(data).equals(joinChunks(chunks)));
  assert.equal(chunks[1].offset, 65536 + SECTOR);
  assert.equal(chunks[2].offset, 2 * 65536 + 2 * SECTOR);
});

test('inspectImage and imageStream for raw, xz and gzip files', async (t) => {
  const dir = tempDir(t);
  const data = diskLikeImage(3 * 1024 * 1024 + 512, 5);
  const raw = join(dir, 'r.img');
  writeFileSync(raw, data);
  const mod = await xzWasmModule();
  for (const [path, format, size] of [
    [raw, 'raw', data.length],
    [xzFile(dir, 'x.img', data, ['-T2', '--block-size=1MiB']), 'xz', data.length],
    [gzFile(dir, 'g.img', data), 'gzip', null],
  ]) {
    const blob = await openAsBlob(path);
    const info = await inspectImage(blob);
    assert.equal(info.format, format);
    assert.equal(info.imageSize, size);
    if (format === 'gzip') assert.equal(info.imageSizeHint, data.length);
    const out = await collect(imageStream(blob, format, mod));
    assert.ok(Buffer.from(data).equals(Buffer.from(out)), format);
  }
});
