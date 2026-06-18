#!/usr/bin/env node

const SOURCE_URLS = [
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md',
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/main/README.md',
];

const SKIP_PATTERNS = [
  /🛂/u,
  /🇺🇸/u,
  /🔒/u,
  /~~/,
  /we are unable to offer sponsorship for this role/i,
  /unable to offer sponsorship/i,
  /no visa sponsorship/i,
  /no sponsorship/i,
  /will not sponsor/i,
  /won'?t sponsor/i,
  /cannot sponsor/i,
  /without visa support or sponsorship/i,
  /requires? u\.?s\.? citizenship/i,
  /u\.?s\.? citizenship/i,
  /citizenship status/i,
  /advanced degree/i,
  /master(?:'s)?\s+(?:only|required|preferred)/i,
  /masters?\/?phds?/i,
  /phds?\s+(?:only|required|preferred)/i,
  /mba\s+(?:only|required|preferred)/i,
];

const NON_US_LOCATION_PATTERNS = [
  /\bcanada\b/i,
  /\btoronto\b/i,
  /\bvancouver\b/i,
  /\bmontreal\b/i,
  /\bcalgary\b/i,
  /\bedmonton\b/i,
  /\bon\b/i,
  /\bbc\b/i,
  /\balberta\b/i,
  /\bquebec\b/i,
  /\bbritish columbia\b/i,
  /\bunited kingdom\b/i,
  /\buk\b/i,
  /\blondon\b/i,
  /\bireland\b/i,
  /\bdublin\b/i,
  /\bgermany\b/i,
  /\bberlin\b/i,
  /\bfrance\b/i,
  /\bparis\b/i,
  /\bnetherlands\b/i,
  /\bamsterdam\b/i,
  /\bswitzerland\b/i,
  /\bzurich\b/i,
  /\bindia\b/i,
  /\bbengaluru\b/i,
  /\bbangalore\b/i,
  /\bsingapore\b/i,
  /\baustralia\b/i,
  /\bnew zealand\b/i,
  /\bbrazil\b/i,
  /\bmexico\b/i,
  /\bremote in canada\b/i,
  /\bremote in uk\b/i,
  /\bremote in europe\b/i,
];

const US_LOCATION_PATTERNS = [
  /\busa\b/i,
  /\bunited states\b/i,
  /\bus remote\b/i,
  /\bremote in usa\b/i,
  /\bremote - us\b/i,
  /\bremote\s+us\b/i,
];

function stripMarkdown(value = '') {
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/br>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/~~/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUrls(value = '') {
  const matches = String(value).match(/https?:\/\/[^\s"')>]+/g) || [];
  return [...new Set(matches.map(url => url.replace(/[),.;]+$/, '')))].filter(Boolean);
}

function shouldSkip(rawText) {
  const text = String(rawText || '');
  return SKIP_PATTERNS.some(pattern => pattern.test(text));
}

function isUsLocation(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return true;
  if (US_LOCATION_PATTERNS.some(pattern => pattern.test(text))) return true;
  if (NON_US_LOCATION_PATTERNS.some(pattern => pattern.test(text))) return false;
  return true;
}

function splitMultiValueCell(value = '') {
  return String(value)
    .split(/<br\s*\/?>|<\/br>|\n|;/i)
    .map(part => stripMarkdown(part))
    .filter(Boolean);
}

function parseTableRows(markdown) {
  const jobs = [];
  let lastCompany = '';

  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    if (/^\|\s*:?[- ]{3,}/.test(line)) continue;

    const cells = line
      .replace(/^\|\s*/, '')
      .replace(/\s*\|\s*$/, '')
      .split('|')
      .map(cell => cell.trim());
    if (cells.length < 4) continue;

    const companyCell = cells[0] || '';
    const roleCell = cells[1] || '';
    const locationCell = cells[2] || '';
    const applyCell = cells[3] || '';
    const rowText = cells.join(' | ');

    if (shouldSkip(rowText)) continue;

    let company = stripMarkdown(companyCell);
    if (!company || company === '↳') company = lastCompany;
    if (!company) continue;
    if (company !== '↳') lastCompany = company;

    const titles = splitMultiValueCell(roleCell);
    const urls = extractUrls(applyCell);
    const fallbackUrls = urls.length > 0 ? urls : extractUrls(rowText);
    if (fallbackUrls.length === 0) continue;

    const location = stripMarkdown(locationCell);
    if (!isUsLocation(location)) continue;
    const titleList = titles.length > 0 ? titles : [stripMarkdown(roleCell)];
    const pairedCount = Math.min(titleList.length, fallbackUrls.length);

    if (pairedCount > 1) {
      for (let index = 0; index < pairedCount; index += 1) {
        const title = titleList[index];
        const url = fallbackUrls[index];
        if (!title || !url) continue;
        jobs.push({ title, url, company, location });
      }
      continue;
    }

    const title = titleList[0];
    const url = fallbackUrls[0];
    if (!title || !url) continue;
    jobs.push({ title, url, company, location });
  }

  return jobs;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'career-ops-parser',
        accept: 'text/plain, text/markdown, */*',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const sample = [
      '| **Acme** | Software Engineer - New Grad | Remote | [Apply](https://example.com/jobs/1) | Jan 01 |',
      '| **Bad Corp** | Software Engineer - New Grad | Remote | [Apply](https://example.com/jobs/2) | Jan 01 | 🛂',
      '| **Bad Corp 2** | Software Engineer - New Grad | Remote | [Apply](https://example.com/jobs/3) | Jan 01 | we are unable to offer sponsorship for this role',
      '| **Bad Corp 3** | Software Engineer - New Grad | Remote | [Apply](https://example.com/jobs/4) | Jan 01 | Advanced degree required',
      '| **Maple Co** | Software Engineer - New Grad | Toronto, ON, Canada | [Apply](https://example.com/jobs/5) | Jan 01 |',
      '| ~~Closed Co~~ | Software Engineer - New Grad | Remote | 🔒 | Jan 01 |',
    ].join('\n');
    const parsed = parseTableRows(sample);
    if (parsed.length !== 1 || parsed[0].company !== 'Acme') {
      throw new Error(`self-test failed: ${JSON.stringify(parsed)}`);
    }
    console.log(JSON.stringify(parsed, null, 2));
    return;
  }

  const results = [];
  const seen = new Set();
  for (const url of SOURCE_URLS) {
    try {
      console.error(`Fetching: ${url}`);
      const markdown = await fetchText(url);
      console.error(`Fetched ${markdown.length} bytes`);
      const parsed = parseTableRows(markdown);
      console.error(`Parsed ${parsed.length} jobs from this URL`);
      for (const job of parsed) {
        const key = `${job.company}::${job.title}::${job.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(job);
      }
      if (results.length > 0) break;
    } catch (error) {
      console.error(`Failed to fetch ${url}: ${error.message}`);
    }
  }

  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});