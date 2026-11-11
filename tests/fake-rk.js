/**
 * A stand-in for the rkdeveloptool Worker proxy (src/proxy.js) with the
 * storage held in memory.  It follows what main.cpp does for the commands
 * the page uses:
 *   wl <lba> <file>   write_lba: 512 KiB reads, last sector zero-padded;
 *                     a file starting with a sparse/UBI magic is refused here
 *                     (the real tool would write it differently)
 *   rl <lba> <n> <f>  read_lba: n sectors into a file
 *   rfi               read_flash_info: prints "Flash Size: N Sectors"
 * plus mountBlob/umount/readFile/unlink like the Worker.
 */
import { hasSpecialMagic } from '../src/image-source.js';

export class FakeRk {
  constructor({ capacity, fillerFrom = Infinity, onStdout = () => {} }) {
    this.storage = new Uint8Array(capacity);
    this.storage.fill(0xa5); // old contents
    this.fillerFrom = fillerFrom;
    this.onStdout = onStdout;
    this.mounts = new Map();
    this.files = new Map();
    this.commands = [];
    this.seq = 0;
  }

  async mountBlob(name, blob) {
    const dir = `/tmp/mounts/${++this.seq}`;
    const path = `${dir}/${name}`;
    this.mounts.set(path, blob);
    return { dir, path };
  }

  async umount({ dir }) {
    for (const p of [...this.mounts.keys()]) if (p.startsWith(dir + '/')) this.mounts.delete(p);
  }

  async readFile(path) {
    const f = this.files.get(path);
    if (!f) throw new Error('ENOENT ' + path);
    return f.slice();
  }

  async unlink(path) { this.files.delete(path); }

  async run(args) {
    this.commands.push(args.join(' '));
    const [cmd] = args;
    if (cmd === 'rfi') {
      this.onStdout('Flash Info:');
      this.onStdout(`\tFlash Size: ${this.storage.length / 512 / 2048} MB`);
      this.onStdout(`\tFlash Size: ${this.storage.length / 512} Sectors`);
      return { exitCode: 0 };
    }
    if (cmd === 'wl') {
      const lba = Number(args[1]);
      const blob = this.mounts.get(args[2]);
      if (!blob) return { exitCode: -255 };
      const data = new Uint8Array(await blob.arrayBuffer());
      if (hasSpecialMagic(data)) throw new Error('fake rk: wl given a file with a sparse/UBI magic');
      const padded = Math.ceil(data.length / 512) * 512;
      const at = lba * 512;
      if (at + padded > this.storage.length) {
        this.onStdout('Write LBA failed!');
        return { exitCode: -255 };
      }
      const step = 512 * 1024;
      for (let p = 0; p < data.length; p += step) {
        const piece = data.subarray(p, p + step);
        const buf = new Uint8Array(Math.ceil(piece.length / 512) * 512);
        buf.set(piece);
        this.storage.set(buf, at + p);
        this.onStdout(`Write LBA from file (${Math.floor(((p + piece.length) / data.length) * 100)}%)`);
      }
      return { exitCode: 0 };
    }
    if (cmd === 'rl') {
      const lba = Number(args[1]);
      const n = Number(args[2]);
      const out = this.storage.slice(lba * 512, (lba + n) * 512);
      for (let i = Math.max(0, this.fillerFrom - lba * 512); i < out.length; i++) out[i] = 0xcc;
      this.files.set(args[3], out);
      this.onStdout('Read LBA to file (100%)');
      return { exitCode: 0 };
    }
    throw new Error('fake rk: unexpected command ' + args.join(' '));
  }
}
