/**
 * Writing a picked image with rkdeveloptool, once the board is in Loader mode.
 *
 * `rk` is the Worker proxy from proxy.js (mountBlob, umount, run, readFile,
 * unlink).  Nothing here touches the DOM, so the tests drive it with a fake
 * `rk` that keeps the "storage" in memory.
 */

import { SECTOR } from './image-source.js';

/** Bytes per `wl` call when the image is streamed (compressed files). */
export const PIECE_SIZE = 32 * 1024 * 1024;

/**
 * How much is read back after writing.  With the RK3576 loader used here,
 * `rl` has been seen to return 0xCC filler, without an error, for everything
 * past 32 MiB of the eMMC; reads below that were correct.  So only the first
 * 32 MiB (partition table and bootloader) can be checked from here.
 */
export const VERIFY_BYTES = 32 * 1024 * 1024;

/**
 * Parse `rkdeveloptool rfi` output.  Returns the storage size in bytes, or
 * null if the output has no "Flash Size: N Sectors" line.
 */
export function parseFlashSize(lines) {
  for (const line of lines) {
    const m = /Flash Size:\s*(\d+)\s*Sectors/i.exec(line);
    if (m) return Number(m[1]) * SECTOR;
  }
  return null;
}

/** Run an rkdeveloptool command, collecting what it prints. */
export async function runCollect(rk, args, capture) {
  const lines = [];
  capture.push(lines);
  try {
    const { exitCode } = await rk.run(args);
    return { exitCode, lines };
  } finally {
    capture.splice(capture.indexOf(lines), 1);
  }
}

/**
 * Write a raw image file in one `wl 0` call.  WORKERFS reads the File in
 * slices as rkdeveloptool asks for them, so it is not loaded into memory.
 */
export async function writeRawFile({ rk, file, log }) {
  const mount = await rk.mountBlob('image.img', file);
  try {
    log(`\n$ rkdeveloptool wl 0 ${file.name || 'image.img'}`);
    const wl = await rk.run(['wl', '0', mount.path]);
    if (wl.exitCode !== 0) throw new Error(`WriteLBA failed (exit ${wl.exitCode})`);
  } finally {
    await rk.umount(mount).catch(() => {});
  }
  return { written: file.size };
}

/**
 * Write a stream of pieces ({ offset, data }, see imageChunks) with one
 * `wl <lba>` call per piece.
 *
 *   nextPiece()          resolves to the next piece, or null at the end
 *   total                image size in bytes if known, else null
 *   onProgress(done, total, pieceFraction)
 *   setPieceListener(fn) the caller routes wl's "(NN%)" lines to fn
 *
 * Keeps a copy of the first VERIFY_BYTES for verifyHead().
 */
export async function writePieces({ rk, nextPiece, total, log, onProgress, setPieceListener }) {
  let done = 0;
  let calls = 0;
  const head = new Uint8Array(total == null ? VERIFY_BYTES : Math.min(VERIFY_BYTES, total));
  let headLen = 0;
  try {
    for (;;) {
      const piece = await nextPiece();
      if (!piece) break;
      const { offset, data } = piece;
      if (offset !== done) throw new Error(`internal: piece at ${offset}, expected ${done}`);
      if (offset % SECTOR) throw new Error(`internal: piece offset ${offset} is not sector aligned`);
      if (headLen < head.length && offset === headLen) {
        const n = Math.min(head.length - headLen, data.length);
        head.set(data.subarray(0, n), headLen);
        headLen += n;
      }
      const lba = offset / SECTOR;
      const mount = await rk.mountBlob('piece.img', new Blob([data]));
      try {
        setPieceListener?.((pct) => onProgress?.(done, total, pct / 100, data.length));
        if (calls === 0) log(`\n$ rkdeveloptool wl ${lba} piece.img  (one call per ${PIECE_SIZE >> 20} MiB)`);
        const wl = await rk.run(['wl', String(lba), mount.path]);
        calls++;
        if (wl.exitCode !== 0) {
          throw new Error(`WriteLBA failed at LBA ${lba} (byte ${offset}), exit ${wl.exitCode}`);
        }
      } finally {
        setPieceListener?.(null);
        await rk.umount(mount).catch(() => {});
      }
      done += data.length;
      onProgress?.(done, total, 0, 0);
    }
  } finally {
    setPieceListener?.(null);
  }
  return { written: done, calls, head: head.subarray(0, headLen) };
}

/**
 * Read back the first `expected.length` bytes and compare.
 * Returns { ok: true } or { ok: false, reason, offset? }.
 */
export async function verifyHead({ rk, expected, log, capture }) {
  const sectors = Math.ceil(expected.length / SECTOR);
  const path = '/tmp/readback.bin';
  log(`\n$ rkdeveloptool rl 0 ${sectors} readback.bin`);
  try {
    const rl = await runCollect(rk, ['rl', '0', String(sectors), path], capture);
    if (rl.exitCode !== 0) return { ok: false, reason: `ReadLBA failed (exit ${rl.exitCode})` };
    const got = await rk.readFile(path);
    if (got.length < expected.length) {
      return { ok: false, reason: `read back ${got.length} bytes, expected ${expected.length}` };
    }
    const at = firstDifference(got, expected);
    if (at < 0) return { ok: true };
    const filler = isFiller(got.subarray(at, Math.min(got.length, at + 4096)));
    return {
      ok: false,
      offset: at,
      reason: filler
        ? `from byte ${at} the loader returned 0xCC filler instead of data, so this part cannot be checked over USB`
        : `the data read back differs from the image at byte ${at}`,
      filler,
    };
  } finally {
    await rk.unlink(path).catch(() => {});
  }
}

export function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function isFiller(bytes) {
  return bytes.length > 0 && bytes.every((v) => v === 0xcc);
}
