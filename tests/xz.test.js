import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { XzDecoder, xzUncompressedSize } from '../src/xz.js';
import { xzDecompressStream } from '../src/image-source.js';
import { diskLikeImage, tempDir, xzFile, xzWasmModule, collect } from './helpers.js';

async function decodeAll(bytes, pieceSize = 65536) {
  const d = await XzDecoder.create(await xzWasmModule());
  const out = [];
  for (let p = 0; p < bytes.length; p += pieceSize) out.push(...d.push(bytes.subarray(p, p + pieceSize)));
  out.push(...d.finish());
  return Buffer.concat(out);
}

const sizeOf = (bytes) => xzUncompressedSize(async (s, e) => bytes.subarray(s, e), bytes.length);

const image = diskLikeImage(6 * 1024 * 1024 + 4321, 11);

for (const [label, args] of [
  ['default (CRC64)', []],
  ['-9, as Armbian compresses', ['-9']],
  ['multi-threaded, several blocks', ['-T4', '--block-size=1MiB']],
  ['CRC32 check', ['--check=crc32']],
  ['no check', ['--check=none']],
]) {
  test(`decodes xz ${label}`, async (t) => {
    const dir = tempDir(t);
    const xz = readFileSync(xzFile(dir, 'a.img', image, args));
    for (const piece of [1, 4093, 65536, 1 << 20]) {
      if (piece === 1 && xz.length > 300000) continue; // too slow byte by byte
      assert.ok(Buffer.from(image).equals(await decodeAll(xz, piece)), `piece ${piece}`);
    }
    assert.equal(await sizeOf(xz), image.length);
  });
}

test('rejects SHA-256 check type with a clear message', async (t) => {
  const xz = readFileSync(xzFile(tempDir(t), 'a.img', image, ['--check=sha256']));
  await assert.rejects(decodeAll(xz), /integrity check this decoder does not support/);
});

test('rejects a truncated file', async (t) => {
  const xz = readFileSync(xzFile(tempDir(t), 'a.img', image));
  await assert.rejects(decodeAll(xz.subarray(0, xz.length - 100)), /truncated|corrupt/);
});

test('rejects a corrupted file', async (t) => {
  const xz = Buffer.from(readFileSync(xzFile(tempDir(t), 'a.img', image)));
  xz[Math.floor(xz.length / 2)] ^= 0x55;
  await assert.rejects(decodeAll(xz), /corrupt|xz:/);
});

test('decodes concatenated streams and stream padding', async (t) => {
  const dir = tempDir(t);
  const a = readFileSync(xzFile(dir, 'a.img', image.subarray(0, 100000)));
  const b = readFileSync(xzFile(dir, 'b.img', image.subarray(100000, 300000)));
  const joined = Buffer.concat([a, b, Buffer.alloc(8)]);
  assert.ok(Buffer.from(image.subarray(0, 300000)).equals(await decodeAll(joined)));
  assert.equal(await sizeOf(joined), 300000);
});

test('xzUncompressedSize returns null for non-xz data', async () => {
  assert.equal(await sizeOf(new Uint8Array(4096).fill(7)), null);
});

test('streaming a file from disk through xzDecompressStream', async (t) => {
  const path = xzFile(tempDir(t), 'a.img', image, ['-T4', '--block-size=1MiB']);
  const blob = await openAsBlob(path);
  const out = await collect(xzDecompressStream(blob.stream(), await xzWasmModule()));
  assert.ok(Buffer.from(image).equals(Buffer.from(out)));
});
