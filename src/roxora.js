/**
 * Roxora images: which ones exist for a board, and what a picked file should
 * hash to.
 *
 * Release layout: https://github.com/roxora-os/build/blob/main/docs/release-contract.md
 *
 * The page cannot read release assets themselves (GitHub serves release
 * downloads without CORS headers), so roxora-catalog.json is out of reach
 * from the browser.  The releases API is readable and lists every asset with
 * its size and sha256 (`digest`), which is what checking a download needs.
 * parseCatalog() handles the catalog format for when it is served from a
 * CORS-enabled place.
 */

export const RELEASES_API = 'https://api.github.com/repos/roxora-os/build/releases?per_page=20';
export const RELEASES_PAGE = 'https://github.com/roxora-os/build/releases';

/** This page's board keys and the Roxora board names (boards.conf column 1). */
export const ROXORA_BOARDS = {
  rock4d: 'radxa-rock-4d',
  cm5io:  'armsom-cm5-io',
};

const VERSION_RE = /^\d{4}\.\d{2}\.\d+$/;

/**
 * Split a release file name per the contract:
 *   roxora-<board>-<release>-<branch>-<version>.img.xz      disk image
 *   roxora-<board>-<release>-<branch>-<version>-spi.img     SPI bootloader
 * Board names contain dashes, so the known board names are tried as prefixes.
 * Returns null for other names; `kind` is 'disk' or 'spi'.
 */
export function parseImageName(file) {
  let kind = 'disk';
  let m = /^roxora-(.+)-spi\.img$/.exec(file);
  if (m) kind = 'spi';
  else m = /^roxora-(.+)\.img\.xz$/.exec(file);
  if (!m) return null;
  for (const board of Object.values(ROXORA_BOARDS)) {
    if (!m[1].startsWith(board + '-')) continue;
    const parts = m[1].slice(board.length + 1).split('-');
    if (parts.length < 3) return null;
    const version = parts.pop();
    if (!VERSION_RE.test(version)) return null;
    const release = parts.shift();
    return { board, release, branch: parts.join('-'), version, kind };
  }
  return null;
}

function assetSha256(asset) {
  return typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')
    ? asset.digest.slice(7).toLowerCase() : null;
}

/**
 * Images per release from a GET /repos/roxora-os/build/releases response.
 * Drafts are skipped; newest release first, as the API returns them.  An SPI
 * bootloader asset is attached to the disk image of the same build as `spi`.
 */
export function imagesFromReleases(releases) {
  const out = [];
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (rel.draft) continue;
    const spis = new Map();
    for (const asset of rel.assets ?? []) {
      const parsed = parseImageName(asset.name);
      if (parsed?.kind !== 'spi') continue;
      spis.set(asset.name.replace(/-spi\.img$/, '.img.xz'), {
        file: asset.name, url: asset.browser_download_url, size: asset.size, sha256: assetSha256(asset),
      });
    }
    for (const asset of rel.assets ?? []) {
      const parsed = parseImageName(asset.name);
      if (parsed?.kind !== 'disk') continue;
      const digest = assetSha256(asset);
      out.push({
        ...parsed,
        spi: spis.get(asset.name) ?? null,
        tag: rel.tag_name,
        prerelease: !!rel.prerelease,
        releaseUrl: rel.html_url,
        file: asset.name,
        url: asset.browser_download_url,
        size: asset.size,
        sha256: digest,
        extractSize: null,
        extractSha256: null,
      });
    }
  }
  return out;
}

/** Images from a roxora-catalog.json (schema 1).  Throws on another schema. */
export function parseCatalog(catalog) {
  if (!catalog || catalog.schema !== 1) {
    throw new Error(`Unsupported catalog schema: ${catalog?.schema}`);
  }
  const rel = catalog.release ?? {};
  return (catalog.images ?? []).map((img) => ({
    board: img.board,
    release: img.release,
    branch: img.branch,
    version: rel.version,
    tag: rel.tag,
    prerelease: !!rel.prerelease,
    releaseUrl: rel.url,
    file: img.file,
    url: img.url,
    size: img.size,
    sha256: img.sha256 ?? null,
    extractSize: img.extract_size ?? null,
    extractSha256: img.extract_sha256 ?? null,
    status: img.status,
    spi: img.spi ? { file: img.spi.file, url: img.spi.url, size: img.spi.size, sha256: img.spi.sha256 } : null,
  }));
}

/**
 * Fetch the list of Roxora images.  Returns { images, message }: `message`
 * is a sentence for the page when there is nothing to show.
 */
export async function fetchRoxoraImages(fetchFn = fetch) {
  let resp;
  try {
    resp = await fetchFn(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
  } catch (e) {
    return { images: [], message: 'Could not reach GitHub to list Roxora releases.' };
  }
  if (resp.status === 403 || resp.status === 429) {
    return { images: [], message: 'GitHub is limiting requests from this address. Try again in an hour.' };
  }
  if (!resp.ok) {
    return { images: [], message: `GitHub answered ${resp.status} when listing Roxora releases.` };
  }
  const images = imagesFromReleases(await resp.json());
  if (!images.length) {
    return { images, message: 'There are no Roxora releases yet.' };
  }
  return { images, message: '' };
}

/**
 * What a picked file should match, given the known images.
 * The file is the release file itself (.img.xz), the .img a user extracted
 * from it, or the SPI bootloader image (`spi: true`).  Returns null when the
 * name is not a known release file.
 */
export function expectedForFile(images, fileName) {
  for (const img of images) {
    if (img.spi && fileName === img.spi.file) {
      return { image: img, spi: true, compressed: false, size: img.spi.size, sha256: img.spi.sha256 };
    }
    if (fileName === img.file) {
      return { image: img, compressed: true, size: img.size, sha256: img.sha256 };
    }
    if (fileName === img.file.replace(/\.xz$/, '')) {
      return { image: img, compressed: false, size: img.extractSize, sha256: img.extractSha256 };
    }
  }
  return null;
}
