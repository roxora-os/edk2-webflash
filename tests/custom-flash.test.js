import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { imageStream, imageChunks, inspectImage, SECTOR } from '../src/image-source.js';
import {
  writePieces, writeRawFile, verifyHead, parseFlashSize, runCollect, VERIFY_BYTES,
} from '../src/custom-flash.js';
import { FakeRk } from './fake-rk.js';
import { diskLikeImage, tempDir, xzFile, xzWasmModule } from './helpers.js';

const MiB = 1024 * 1024;
const silent = () => {};

/** Image with a GPT-like head, a "bootloader" at 32 KiB and a magic on a piece boundary. */
function osLikeImage(size) {
  const img = diskLikeImage(size, 21);
  img.set(new TextEncoder().encode('EFI PART'), 512);
  img.set([0x52, 0x4b, 0x4e, 0x53], 32 * 1024); // "RKNS" idblock header
  img.set([0x3a, 0xff, 0x26, 0xed], 64 * MiB);   // sparse magic where piece 3 would start
  return img;
}

async function flashCompressed(rk, blob, info, mod, pieceSize) {
  const stream = imageStream(blob, info.format, mod);
  const it = imageChunks(stream, pieceSize);
  const progress = [];
  const res = await writePieces({
    rk,
    nextPiece: async () => { const r = await it.next(); return r.done ? null : r.value; },
    total: info.imageSize,
    log: silent,
    onProgress: (done, total, frac, len) => progress.push((done + frac * len) / total),
    setPieceListener: (fn) => { rk.pieceListener = fn; },
  });
  return { res, progress };
}

test('an .img.xz is written piece by piece to the right LBAs and reads back', async (t) => {
  const dir = tempDir(t);
  const image = osLikeImage(100 * MiB + 3 * 512 + 100); // not a whole number of sectors
  const path = xzFile(dir, 'os-image.img', image, ['-T4', '-1']);
  const blob = await openAsBlob(path);
  const info = await inspectImage(blob);
  assert.equal(info.format, 'xz');
  assert.equal(info.imageSize, image.length);

  const rk = new FakeRk({
    capacity: 128 * MiB,
    onStdout: (line) => { const m = /\((\d+)%\)/.exec(line); if (m && rk.pieceListener) rk.pieceListener(+m[1]); },
  });
  const { res, progress } = await flashCompressed(rk, blob, info, await xzWasmModule(), 32 * MiB);

  assert.equal(res.written, Math.ceil(image.length / SECTOR) * SECTOR);
  assert.equal(res.calls, 4);
  // LBAs: 0, 32 MiB, 64 MiB + 1 sector (the sparse magic moved back), ...
  assert.deepEqual(rk.commands.map((c) => c.split(' ')[1]),
    ['0', String(32 * MiB / SECTOR), String(64 * MiB / SECTOR + 1), String(96 * MiB / SECTOR + 1)]);
  // Storage holds the image, then the zero padding of the last sector, then old contents.
  assert.ok(Buffer.from(rk.storage.subarray(0, image.length)).equals(Buffer.from(image)));
  assert.ok(rk.storage.subarray(image.length, res.written).every((b) => b === 0));
  assert.ok(rk.storage.subarray(res.written).every((b) => b === 0xa5));
  // Progress only moves forward and ends at 1.
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1] - 1e-9);
  assert.ok(Math.abs(progress.at(-1) - res.written / image.length) < 1e-9);

  assert.equal(res.head.length, VERIFY_BYTES);
  const v = await verifyHead({ rk, expected: res.head, log: silent, capture: [] });
  assert.deepEqual(v, { ok: true });
  assert.equal(rk.files.size, 0, 'readback file removed');
});

test('verifyHead reports a difference, and calls 0xCC filler what it is', async () => {
  const image = diskLikeImage(VERIFY_BYTES, 5);
  const rk = new FakeRk({ capacity: 64 * MiB });
  rk.storage.set(image);
  rk.storage[12345] ^= 1;
  let v = await verifyHead({ rk, expected: image, log: silent, capture: [] });
  assert.equal(v.ok, false);
  assert.equal(v.offset, 12345);
  assert.match(v.reason, /differs/);

  rk.storage.set(image);
  rk.fillerFrom = 16 * MiB;
  v = await verifyHead({ rk, expected: image, log: silent, capture: [] });
  assert.equal(v.ok, false);
  assert.equal(v.filler, true);
  assert.match(v.reason, /0xCC filler/);
});

test('a write past the end of the storage fails with the LBA in the message', async (t) => {
  const dir = tempDir(t);
  const image = diskLikeImage(40 * MiB, 9);
  const blob = await openAsBlob(xzFile(dir, 'big.img', image, ['-T4', '-1']));
  const info = await inspectImage(blob);
  const rk = new FakeRk({ capacity: 36 * MiB });
  await assert.rejects(flashCompressed(rk, blob, info, await xzWasmModule(), 32 * MiB),
    /WriteLBA failed at LBA 65536/);
});

test('a raw file is written with one wl 0 call', async (t) => {
  const dir = tempDir(t);
  const image = diskLikeImage(5 * MiB + 512, 4);
  const path = join(dir, 'CM5IO-emmc-edk2.img');
  writeFileSync(path, image);
  const rk = new FakeRk({ capacity: 16 * MiB });
  const blob = await openAsBlob(path);
  const res = await writeRawFile({ rk, file: blob, log: silent });
  assert.equal(res.written, image.length);
  assert.deepEqual(rk.commands.map((c) => c.split(' ').slice(0, 2).join(' ')), ['wl 0']);
  assert.ok(Buffer.from(rk.storage.subarray(0, image.length)).equals(Buffer.from(image)));
});

test('parseFlashSize reads rfi output', async () => {
  const lines = [];
  const capture = [];
  const rk = new FakeRk({ capacity: 64 * MiB, onStdout: (l) => capture.forEach((c) => c.push(l)) });
  const r = await runCollect(rk, ['rfi'], capture);
  assert.equal(parseFlashSize(r.lines), 64 * MiB);
  assert.equal(capture.length, 0);
  assert.equal(parseFlashSize(lines), null);
  assert.equal(parseFlashSize(['\tFlash Size: 29824 MB', '\tFlash Size: 61079552 Sectors']), 61079552 * 512);
});

test('the decompressed bytes hash to what the catalog would say', async (t) => {
  const dir = tempDir(t);
  const image = diskLikeImage(9 * MiB, 8);
  const blob = await openAsBlob(xzFile(dir, 'h.img', image));
  const { Sha256 } = await import('../src/sha256.js');
  const h = new Sha256();
  for await (const c of imageStream(blob, 'xz', await xzWasmModule())) h.update(c);
  assert.equal(h.hex(), createHash('sha256').update(image).digest('hex'));
});
