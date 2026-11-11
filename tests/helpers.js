import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function xzWasmModule() {
  return WebAssembly.compile(readFileSync(join(root, 'vendor/xzwasm/xzwasm.wasm')));
}

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'webflash-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Deterministic pseudo-random bytes (xorshift32). */
export function prng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

/**
 * Something shaped like a disk image: runs of zeros, runs of random bytes,
 * runs of repeated text.  Compresses well and quickly.
 */
export function diskLikeImage(size, seed = 1) {
  const out = new Uint8Array(size);
  const rnd = prng(seed);
  let pos = 0;
  while (pos < size) {
    const len = Math.min(size - pos, 4096 * (1 + (rnd() % 64)));
    const kind = rnd() % 3;
    if (kind === 1) for (let i = 0; i < len; i++) out[pos + i] = rnd() & 0xff;
    else if (kind === 2) for (let i = 0; i < len; i++) out[pos + i] = 'diskimg '.charCodeAt(i % 8);
    pos += len;
  }
  return out;
}

/** Compress `data` with the system xz.  Returns the path of the .xz file. */
export function xzFile(dir, name, data, args = []) {
  const path = join(dir, name);
  writeFileSync(path, data);
  execFileSync('xz', ['-k', '-f', ...args, path]);
  return path + '.xz';
}

export function gzFile(dir, name, data) {
  const path = join(dir, name);
  writeFileSync(path, data);
  execFileSync('gzip', ['-k', '-f', path]);
  return path + '.gz';
}

export async function collect(stream) {
  const parts = [];
  let len = 0;
  for await (const c of stream) { parts.push(c); len += c.length; }
  const out = new Uint8Array(len);
  let p = 0;
  for (const c of parts) { out.set(c, p); p += c.length; }
  return out;
}
