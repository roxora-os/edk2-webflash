import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Sha256 } from '../src/sha256.js';
import { prng } from './helpers.js';

const ref = (b) => createHash('sha256').update(b).digest('hex');

test('known vectors', () => {
  assert.equal(new Sha256().hex(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(new Sha256().update(new TextEncoder().encode('abc')).hex(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('matches node:crypto for every length around block edges, split anywhere', () => {
  const rnd = prng(7);
  const data = new Uint8Array(300);
  for (let i = 0; i < data.length; i++) data[i] = rnd() & 0xff;
  for (let len = 0; len <= 300; len++) {
    const whole = data.subarray(0, len);
    const split = rnd() % (len + 1);
    const h = new Sha256().update(whole.subarray(0, split)).update(whole.subarray(split));
    assert.equal(h.hex(), ref(whole), `length ${len} split ${split}`);
  }
});

test('a few MB in odd-sized chunks', () => {
  const rnd = prng(3);
  const data = new Uint8Array(5 * 1024 * 1024 + 13);
  for (let i = 0; i < data.length; i++) data[i] = rnd() & 0xff;
  const h = new Sha256();
  for (let p = 0; p < data.length; ) {
    const n = 1 + (rnd() % 200000);
    h.update(data.subarray(p, p + n));
    p += n;
  }
  assert.equal(h.hex(), ref(data));
});
