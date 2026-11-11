import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseImageName, imagesFromReleases, parseCatalog, fetchRoxoraImages, expectedForFile,
} from '../src/roxora.js';
import { root } from './helpers.js';

const sample = JSON.parse(readFileSync(join(root, 'tests/fixtures/sample-catalog.json'), 'utf8'));

test('parseImageName follows the release contract', () => {
  assert.deepEqual(parseImageName('roxora-radxa-rock-4d-noble-edge-2026.11.0.img.xz'),
    { board: 'radxa-rock-4d', release: 'noble', branch: 'edge', version: '2026.11.0' });
  assert.deepEqual(parseImageName('roxora-armsom-cm5-io-noble-vendor-2026.12.3.img.xz'),
    { board: 'armsom-cm5-io', release: 'noble', branch: 'vendor', version: '2026.12.3' });
  assert.equal(parseImageName('roxora-armsom-cm5-io-noble-edge-2026.11.0.verify.txt'), null);
  assert.equal(parseImageName('roxora-unknown-board-noble-edge-2026.11.0.img.xz'), null);
  assert.equal(parseImageName('roxora-catalog.json'), null);
  assert.equal(parseImageName('SHA256SUMS'), null);
});

/** A releases API response built from the sample catalog. */
function fakeApi() {
  const rel = sample.release;
  return [
    { tag_name: 'v2026.12.0', draft: true, prerelease: true, assets: [
      { name: 'roxora-armsom-cm5-io-noble-edge-2026.12.0.img.xz', size: 1, digest: 'sha256:00' } ] },
    {
      tag_name: rel.tag, draft: false, prerelease: rel.prerelease, html_url: rel.url,
      assets: [
        ...sample.images.map((img) => ({
          name: img.file, size: img.size, browser_download_url: img.url,
          digest: 'sha256:' + img.sha256.toUpperCase(),
        })),
        ...sample.images.map((img) => ({ name: img.file + '.sha256', size: 100 })),
        { name: 'roxora-catalog.json', size: 1000 },
        { name: 'SHA256SUMS', size: 500 },
      ],
    },
  ];
}

test('imagesFromReleases: images only, drafts skipped, digest read', () => {
  const imgs = imagesFromReleases(fakeApi());
  assert.equal(imgs.length, 2);
  const cm5 = imgs.find((i) => i.board === 'armsom-cm5-io');
  const ref = sample.images.find((i) => i.board === 'armsom-cm5-io');
  assert.equal(cm5.file, ref.file);
  assert.equal(cm5.size, ref.size);
  assert.equal(cm5.sha256, ref.sha256);
  assert.equal(cm5.prerelease, true);
  assert.equal(cm5.tag, 'v2026.11.0');
  assert.deepEqual(imagesFromReleases(null), []);
});

test('parseCatalog reads the sample catalog', () => {
  const imgs = parseCatalog(sample);
  assert.equal(imgs.length, 2);
  const r4d = imgs.find((i) => i.board === 'radxa-rock-4d');
  assert.equal(r4d.extractSize, 2466250752);
  assert.equal(r4d.status, 'ci-only');
  assert.throws(() => parseCatalog({ schema: 2 }), /schema/);
});

test('expectedForFile matches the .img.xz and the extracted .img', () => {
  const imgs = parseCatalog(sample);
  const ref = sample.images[1];
  const a = expectedForFile(imgs, ref.file);
  assert.equal(a.compressed, true);
  assert.equal(a.sha256, ref.sha256);
  const b = expectedForFile(imgs, ref.file.replace(/\.xz$/, ''));
  assert.equal(b.compressed, false);
  assert.equal(b.sha256, ref.extract_sha256);
  assert.equal(b.size, ref.extract_size);
  assert.equal(expectedForFile(imgs, 'CM5IO-emmc-edk2-0.2.1.img'), null);
});

const respond = (status, body) => async () => ({
  status, ok: status >= 200 && status < 300, json: async () => body,
});

test('fetchRoxoraImages says so in plain words when there is nothing', async () => {
  assert.deepEqual(await fetchRoxoraImages(respond(200, [])),
    { images: [], message: 'There are no Roxora releases yet.' });
  assert.match((await fetchRoxoraImages(respond(403, {}))).message, /limiting/);
  assert.match((await fetchRoxoraImages(respond(500, {}))).message, /500/);
  assert.match((await fetchRoxoraImages(async () => { throw new TypeError('offline'); })).message,
    /Could not reach GitHub/);
  const ok = await fetchRoxoraImages(respond(200, fakeApi()));
  assert.equal(ok.images.length, 2);
  assert.equal(ok.message, '');
});
