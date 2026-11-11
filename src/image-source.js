/**
 * Turning a picked file into the bytes that go to storage.
 *
 * Pure functions with no DOM or WebUSB use, so they run in a Worker, on the
 * main thread and under Node for the tests.
 */

import { XzDecoder, xzUncompressedSize } from './xz.js';

export const SECTOR = 512;

const MAGIC = {
  xz:     [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  gzip:   [0x1f, 0x8b],
  zip:    [0x50, 0x4b, 0x03, 0x04],
  zstd:   [0x28, 0xb5, 0x2f, 0xfd],
  bzip2:  [0x42, 0x5a, 0x68],
  sevenz: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
};

// rkdeveloptool's `wl` treats a file that starts with one of these as an
// Android sparse image or a UBI image and changes how it writes it
// (main.cpp: is_sparse_image, is_ubifs_image).
const SPARSE_MAGIC = 0xed26ff3a;
const UBI_MAGIC    = 0x55424923; // "UBI#"
const UBIFS_MAGIC  = 0x06101831;

function startsWith(bytes, magic) {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/**
 * Classify a file by its first bytes (the name is only used in messages).
 * Returns { format: 'raw' | 'xz' | 'gzip' } or { format: 'unsupported', message }.
 */
export function detectFormat(head, name = '') {
  if (startsWith(head, MAGIC.xz))   return { format: 'xz' };
  if (startsWith(head, MAGIC.gzip)) return { format: 'gzip' };
  const other = startsWith(head, MAGIC.zip) ? 'a .zip archive'
    : startsWith(head, MAGIC.zstd) ? 'zstd-compressed'
    : startsWith(head, MAGIC.bzip2) ? 'bzip2-compressed'
    : startsWith(head, MAGIC.sevenz) ? 'a .7z archive'
    : null;
  if (other) {
    return {
      format: 'unsupported',
      message: `${name || 'This file'} is ${other}. Extract the .img from it first, ` +
               'or use the .img.xz or .img.gz file.',
    };
  }
  return { format: 'raw' };
}

/** First four bytes as a little-endian uint32, or -1 if too short. */
function le32(bytes) {
  if (bytes.length < 4) return -1;
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

/** True if rkdeveloptool `wl` would not write a file starting with `bytes` as plain data. */
export function hasSpecialMagic(bytes) {
  const v = le32(bytes);
  return v === SPARSE_MAGIC || v === UBI_MAGIC || v === UBIFS_MAGIC;
}

/** Wrap a ReadableStream of compressed .xz bytes into one of decompressed bytes. */
export function xzDecompressStream(compressed, wasmModule) {
  let decoder;
  return compressed.pipeThrough(new TransformStream({
    async start() { decoder = await XzDecoder.create(wasmModule); },
    transform(chunk, controller) {
      for (const out of decoder.push(chunk)) controller.enqueue(out);
    },
    flush(controller) {
      for (const out of decoder.finish()) controller.enqueue(out);
    },
  }));
}

/**
 * Inspect a Blob/File: format and, where it can be known up front, the size
 * of the image that will be written.
 */
export async function inspectImage(blob) {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const info = { name: blob.name ?? '', compressedSize: blob.size, ...detectFormat(head, blob.name) };
  if (info.format === 'raw') {
    info.imageSize = blob.size;
  } else if (info.format === 'xz') {
    const readRange = async (s, e) => new Uint8Array(await blob.slice(s, e).arrayBuffer());
    info.imageSize = await xzUncompressedSize(readRange, blob.size);
  } else if (info.format === 'gzip' && blob.size >= 18) {
    // ISIZE: the size modulo 2^32, so only a hint.
    const t = new Uint8Array(await blob.slice(blob.size - 4).arrayBuffer());
    info.imageSizeHint = le32(t);
    info.imageSize = null;
  } else {
    info.imageSize = null;
  }
  return info;
}

/** A ReadableStream of the image bytes for a Blob in one of the supported formats. */
export function imageStream(blob, format, wasmModule) {
  if (format === 'raw') return blob.stream();
  if (format === 'xz') return xzDecompressStream(blob.stream(), wasmModule);
  if (format === 'gzip') return blob.stream().pipeThrough(new DecompressionStream('gzip'));
  throw new Error('Unsupported image format: ' + format);
}

/**
 * Split a byte stream into pieces for `rkdeveloptool wl <lba> <piece>`.
 *
 * Yields { offset, data } with `offset` a multiple of 512.  Pieces are
 * `chunkSize` bytes, except that:
 *   - a piece other than the first never starts with a sparse or UBI magic
 *     (wl would treat it specially); such a piece gives its first sector to
 *     the piece before it;
 *   - the last piece is padded with zeros to a whole sector, as wl does.
 *
 * If the image itself starts with such a magic, the first piece does too:
 * the caller checks that with hasSpecialMagic() and refuses.
 *
 * `onBytes(n)` is called with every n bytes read from the stream.
 */
export async function* imageChunks(stream, chunkSize, onBytes) {
  if (chunkSize % SECTOR) throw new Error('chunkSize must be a multiple of 512');
  const reader = stream.getReader();
  let buf = new Uint8Array(chunkSize * 2);
  let len = 0;          // bytes in buf
  let offset = 0;       // image offset of buf[0]
  let eof = false;

  async function fill(want) {
    while (!eof && len < want) {
      const { done, value } = await reader.read();
      if (done) { eof = true; break; }
      onBytes?.(value.length);
      if (len + value.length > buf.length) {
        const bigger = new Uint8Array(Math.max(buf.length * 2, len + value.length));
        bigger.set(buf.subarray(0, len));
        buf = bigger;
      }
      buf.set(value, len);
      len += value.length;
    }
  }

  try {
    for (;;) {
      // Enough for this piece, plus the head of the next one so its magic
      // can be checked, plus room for sectors that may move back.
      await fill(chunkSize + SECTOR * 64);
      if (len === 0) return;
      let take = Math.min(chunkSize, len);
      if (take < len) {
        // Move sectors from the next piece into this one while the next
        // piece would start with a magic.
        while (take < len && hasSpecialMagic(buf.subarray(take, take + 4))) {
          take = Math.min(take + SECTOR, len);
          if (take + 4 > len && !eof) await fill(take + SECTOR * 64);
        }
      }
      let data;
      if (take === len && eof && take % SECTOR) {
        data = new Uint8Array(Math.ceil(take / SECTOR) * SECTOR);
        data.set(buf.subarray(0, take));
      } else {
        data = buf.slice(0, take);
      }
      yield { offset, data };
      buf.copyWithin(0, take, len);
      len -= take;
      offset += take;
      if (len === 0 && eof) return;
    }
  } finally {
    reader.releaseLock();
  }
}
