/**
 * XZ decoding on top of vendor/xzwasm/xzwasm.wasm (xz-embedded).
 *
 * The wasm exports create_context / supply_input / get_next_output /
 * destroy_context.  A context is a struct in wasm memory; as 32-bit words:
 *   [0] buffer size, [1] input buffer pointer, [2] in_pos, [3] in_size,
 *   [4] output buffer pointer, [5] out_pos, [6] out_size.
 * supply_input(ctx, 0) marks the end of the input.
 *
 * Every output chunk is copied out of wasm memory before it is returned,
 * because the decoder reuses its output buffer on the next call.
 */

const XZ_RESULT = [
  'OK', 'STREAM_END',
  'the file uses an integrity check this decoder does not support (recompress with xz --check=crc64)',
  'out of memory', 'the dictionary is larger than 64 MiB',
  'not an xz file',
  'the file uses xz options or an integrity check this decoder does not support (xz with its default CRC64 check works)',
  'the file is corrupt',
  'the file is truncated',
];

export class XzError extends Error {}

export class XzDecoder {
  /** `wasmModule` is a compiled WebAssembly.Module of xzwasm.wasm. */
  static async create(wasmModule) {
    const instance = await WebAssembly.instantiate(wasmModule, {});
    return new XzDecoder(instance);
  }

  constructor(instance) {
    this.x = instance.exports;
    this.ptr = this.x.create_context();
    if (!this.ptr) throw new XzError('xz: cannot allocate a decoder');
    this.ended = false;
    const w = this._words();
    this.bufSize = w[0];
  }

  _words() { return new Uint32Array(this.x.memory.buffer, this.ptr, 7); }
  _bytes(ptr, len) { return new Uint8Array(this.x.memory.buffer, ptr, len); }

  /**
   * Feed compressed bytes.  Returns the decompressed output produced so far
   * as an array of Uint8Array copies (possibly empty).
   */
  push(input) {
    if (this.ended) {
      if (input.length) throw new XzError('xz: data after the end of the stream');
      return [];
    }
    const out = [];
    for (let pos = 0; pos < input.length; ) {
      const n = Math.min(this.bufSize, input.length - pos);
      const w = this._words();
      this._bytes(w[1], n).set(input.subarray(pos, pos + n));
      this.x.supply_input(this.ptr, n);
      pos += n;
      this._drain(out, false);
    }
    return out;
  }

  /** Signal end of input.  Returns the remaining output; throws if truncated. */
  finish() {
    const out = [];
    if (this.ended) return out;
    this.x.supply_input(this.ptr, 0);
    this._drain(out, true);
    if (!this.ended) throw new XzError('xz: ' + XZ_RESULT[8]);
    return out;
  }

  _drain(out, finishing) {
    for (let idle = 0; ; ) {
      const ret = this.x.get_next_output(this.ptr);
      const w = this._words();
      const produced = w[5];
      if (produced > 0) out.push(this._bytes(w[4], produced).slice());
      w[5] = 0; // reset out_pos
      if (ret === 1) { this.ended = true; this.dispose(); return; }
      if (ret !== 0) {
        this.dispose();
        throw new XzError('xz: ' + (XZ_RESULT[ret] ?? `error ${ret}`));
      }
      const inputUsed = w[2] === w[3];
      if (produced === this.bufSize) { idle = 0; continue; } // output was full: call again
      if (inputUsed && !finishing) return;
      if (produced === 0 && ++idle > 2) return; // no progress
    }
  }

  dispose() {
    if (this.ptr) { this.x.destroy_context(this.ptr); this.ptr = 0; }
  }
}

function readVli(bytes, pos) {
  let value = 0, mul = 1;
  for (let i = 0; i < 9; i++) {
    if (pos >= bytes.length) return null;
    const b = bytes[pos++];
    value += (b & 0x7f) * mul;
    if (!(b & 0x80)) return { value, pos };
    mul *= 128;
  }
  return null;
}

/**
 * Read the decompressed size of an .xz file from its indexes, without
 * decompressing.  `readRange(start, end)` returns a Promise<Uint8Array> for
 * that byte range of the file.  Walks back over concatenated streams and
 * stream padding.  Returns null if the file does not parse as .xz.
 */
export async function xzUncompressedSize(readRange, fileSize) {
  let end = fileSize;
  let total = 0;
  for (let streams = 0; end > 0; streams++) {
    if (streams > 1000) return null;
    // Skip stream padding (multiples of 4 zero bytes).
    for (;;) {
      if (end < 4) return null;
      const pad = await readRange(end - 4, end);
      if (pad[0] || pad[1] || pad[2] || pad[3]) break;
      end -= 4;
    }
    if (end < 32) return null;
    const footer = await readRange(end - 12, end);
    if (footer[10] !== 0x59 || footer[11] !== 0x5a) return null; // "YZ"
    const backward = (((footer[4] | (footer[5] << 8) | (footer[6] << 16)) >>> 0) + footer[7] * 0x1000000 + 1) * 4;
    const indexStart = end - 12 - backward;
    if (indexStart < 12) return null;
    const index = await readRange(indexStart, end - 12);
    if (index[0] !== 0x00) return null;
    let r = readVli(index, 1);
    if (!r) return null;
    let records = r.value, pos = r.pos, blocks = 0;
    while (records-- > 0) {
      r = readVli(index, pos); if (!r) return null; // unpadded size
      blocks += Math.ceil(r.value / 4) * 4;
      r = readVli(index, r.pos); if (!r) return null; // uncompressed size
      total += r.value;
      pos = r.pos;
    }
    const streamStart = indexStart - blocks - 12;
    if (streamStart < 0) return null;
    const header = await readRange(streamStart, streamStart + 6);
    if (header[0] !== 0xfd || header[1] !== 0x37 || header[2] !== 0x7a ||
        header[3] !== 0x58 || header[4] !== 0x5a || header[5] !== 0x00) return null;
    end = streamStart;
  }
  return total;
}
