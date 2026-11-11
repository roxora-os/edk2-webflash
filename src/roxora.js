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
 * Split an image file name per the contract:
 *   roxora-<board>-<release>-<branch>-<version>.img.xz
 * Board names contain dashes, so the known board names are tried as prefixes.
 * Returns null for other names.
 */
export function parseImageName(file) {
  const m = /^roxora-(.+)\.img\.xz$/.exec(file);
  if (!m) return null;
  for (const board of Object.values(ROXORA_BOARDS)) {
    if (!m[1].startsWith(board + '-')) continue;
    const parts = m[1].slice(board.length + 1).split('-');
    if (parts.length < 3) return null;
    const version = parts.pop();
    if (!VERSION_RE.test(version)) return null;
    const release = parts.shift();
    return { board, release, branch: parts.join('-'), version };
  }
  return null;
}

/**
 * Images per release from a GET /repos/roxora-os/build/releases response.
 * Drafts are skipped; newest release first, as the API returns them.
 */
export function imagesFromReleases(releases) {
  const out = [];
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (rel.draft) continue;
    for (const asset of rel.assets ?? []) {
      const parsed = parseImageName(asset.name);
      if (!parsed) continue;
      const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')
        ? asset.digest.slice(7).toLowerCase() : null;
      out.push({
        ...parsed,
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
 * The file is either the release file itself (.img.xz) or the .img a user
 * extracted from it.  Returns null when the name is not a known image.
 */
export function expectedForFile(images, fileName) {
  for (const img of images) {
    if (fileName === img.file) {
      return { image: img, compressed: true, size: img.size, sha256: img.sha256 };
    }
    if (fileName === img.file.replace(/\.xz$/, '')) {
      return { image: img, compressed: false, size: img.extractSize, sha256: img.extractSha256 };
    }
  }
  return null;
}
