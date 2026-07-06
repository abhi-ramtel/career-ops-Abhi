// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// BambooHR provider — parses the public, server-rendered jobs widget at
// /jobs/embed2.php.
//
// BambooHR's legacy /careers/list JSON endpoint now returns an empty result for
// every board (deprecated; the branded careers page is a client-side React app).
// The embed2.php widget is the only stable, no-auth surface that still lists
// open roles server-side. Auto-detects from any `https://<sub>.bamboohr.com/...`
// careers_url; a tracked_companies entry can also set `provider: bamboohr`.
//
// The widget exposes no posting date, so jobs carry no `postedAt` — the freshness
// filter passes them conservatively (unless `drop_undated: true`).

const BASE_SUFFIX = '.bamboohr.com';

// extractSubdomain returns the single-label company subdomain of a
// `<sub>.bamboohr.com` host, or null for the apex or any spoofed/multi-label
// host (e.g. "x.bamboohr.com.evil.com" → null). This is the SSRF guard.
function extractSubdomain(hostname) {
  if (typeof hostname !== 'string' || !hostname.endsWith(BASE_SUFFIX)) return null;
  const sub = hostname.slice(0, -BASE_SUFFIX.length);
  if (!sub || sub.includes('.')) return null;
  return sub;
}

function resolveEmbedUrl(entry) {
  const raw = typeof entry.careers_url === 'string' ? entry.careers_url : '';
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const sub = extractSubdomain(parsed.hostname);
  if (!sub) return null;
  return `https://${sub}.bamboohr.com/jobs/embed2.php`;
}

function assertBambooHrUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`bamboohr: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`bamboohr: URL must use HTTPS: ${url}`);
  if (!extractSubdomain(parsed.hostname)) {
    throw new Error(`bamboohr: untrusted hostname "${parsed.hostname}" — must be <company>.bamboohr.com`);
  }
  return url;
}

/** @type {Provider} */
export default {
  id: 'bamboohr',

  detect(entry) {
    const url = resolveEmbedUrl(entry);
    return url ? { url } : null;
  },

  async fetch(entry, ctx) {
    const embedUrl = resolveEmbedUrl(entry);
    if (!embedUrl) throw new Error(`bamboohr: cannot derive embed URL for ${entry.name}`);
    assertBambooHrUrl(embedUrl);
    const sub = /** @type {string} */ (extractSubdomain(new URL(embedUrl).hostname));
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertBambooHrUrl above it guarantees the final hostname stays on
    // <sub>.bamboohr.com.
    const html = await ctx.fetchText(embedUrl, { redirect: 'error' });
    return parseBambooHrJobs(html, entry.name, sub);
  },
};

function stripTags(value) {
  return String(value).replace(/<[^>]+>/g, '');
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Parse the BambooHR embed2.php widget HTML. Exported for unit tests.
 *
 * Each job is a list item:
 *   <li class="BambooHR-ATS-Jobs-Item">
 *     <a href="//<sub>.bamboohr.com/careers/<id>">Title</a>
 *     <span class="BambooHR-ATS-Location">Location</span>
 *   </li>
 *
 * URLs are normalized to https and validated against `<sub>.bamboohr.com`;
 * rows whose link is off-domain or unparseable are skipped. An empty board
 * renders a "no open positions" blank state with no Jobs-Item rows, so this
 * returns [].
 *
 * @param {string} html — embed2.php body
 * @param {string} companyName — value written into job.company
 * @param {string} sub — the company subdomain, used to validate job links
 * @returns {Array<{title: string, url: string, company: string, location: string}>}
 */
export function parseBambooHrJobs(html, companyName, sub) {
  if (typeof html !== 'string') return [];
  const jobs = [];
  const itemRe = /<li[^>]*class="[^"]*BambooHR-ATS-Jobs-Item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = itemRe.exec(html)) !== null) {
    const item = match[1];
    const anchor = item.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;

    const title = decodeEntities(stripTags(anchor[2])).trim();
    if (!title) continue;

    let url = anchor[1].trim();
    if (url.startsWith('//')) url = `https:${url}`;
    else if (url.startsWith('/')) url = `https://${sub}.bamboohr.com${url}`;

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== `${sub}.bamboohr.com`) continue;

    const locMatch = item.match(/class="[^"]*BambooHR-ATS-Location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const location = locMatch ? decodeEntities(stripTags(locMatch[1])).trim() : '';

    jobs.push({ title, url: parsedUrl.href, company: companyName, location });
  }
  return jobs;
}
