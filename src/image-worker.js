/**
 * Image Worker: reads the picked file, decompresses it and hashes it, off the
 * main thread.  The flash sequencer pulls the image from here piece by piece,
 * so neither the compressed file nor the image is ever held in memory whole.
 *
 * Methods (see image-proxy.js):
 *   open  { file }            -> format and sizes (inspectImage)
 *   hash  {}                  -> sha256 of the file as picked; emits progress
 *   start { chunkSize }       -> begin streaming the image
 *   next  {}                  -> { offset, data } (data transferred) or
 *                                { done: true, size, sha256 } of the image
 *   cancel {}
 */

import { inspectImage, imageStream, imageChunks } from './image-source.js';
import { Sha256 } from './sha256.js';

let file = null;
let info = null;
let wasmModule = null;
let pieces = null;
let imageHash = null;
let imageBytes = 0;

async function xzModule() {
  if (!wasmModule) {
    const url = new URL('../vendor/xzwasm/xzwasm.wasm', import.meta.url);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Cannot load the xz decoder (HTTP ${resp.status})`);
    wasmModule = await WebAssembly.compile(await resp.arrayBuffer());
  }
  return wasmModule;
}

function progress(phase, done, total) {
  self.postMessage({ id: null, type: 'progress', data: { phase, done, total } });
}

self.addEventListener('message', async ({ data: msg }) => {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'open': {
        file = params.file;
        pieces = null;
        info = await inspectImage(file);
        self.postMessage({ id, type: 'ok', data: info });
        break;
      }
      case 'hash': {
        const h = new Sha256();
        const reader = file.stream().getReader();
        let done = 0, last = 0;
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          h.update(r.value);
          done += r.value.length;
          if (done - last >= 16 << 20) { progress('hash', done, file.size); last = done; }
        }
        progress('hash', done, file.size);
        self.postMessage({ id, type: 'ok', data: { sha256: h.hex(), size: done } });
        break;
      }
      case 'start': {
        const mod = info.format === 'xz' ? await xzModule() : null;
        const stream = imageStream(file, info.format, mod);
        imageHash = new Sha256();
        imageBytes = 0;
        // Hash the image bytes as they come out of the decompressor.
        const hashed = stream.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            imageHash.update(chunk);
            imageBytes += chunk.length;
            controller.enqueue(chunk);
          },
        }));
        pieces = imageChunks(hashed, params.chunkSize);
        self.postMessage({ id, type: 'ok', data: {} });
        break;
      }
      case 'next': {
        const r = await pieces.next();
        if (r.done) {
          self.postMessage({ id, type: 'ok', data: { done: true, size: imageBytes, sha256: imageHash.hex() } });
        } else {
          const { offset, data } = r.value;
          self.postMessage({ id, type: 'ok', data: { done: false, offset, data } }, [data.buffer]);
        }
        break;
      }
      case 'cancel': {
        if (pieces) await pieces.return().catch(() => {});
        pieces = null;
        self.postMessage({ id, type: 'ok', data: {} });
        break;
      }
      default:
        throw new Error('Unknown image worker method: ' + method);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', data: { message: String(err?.message ?? err) } });
  }
});
