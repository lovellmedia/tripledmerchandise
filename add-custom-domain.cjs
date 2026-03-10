/**
 * add-custom-domain.cjs — Add custom domain to Netlify site via API
 *
 * Usage: Copy to project root, then run:
 *   node add-custom-domain.cjs
 *   node add-custom-domain.cjs --dry-run
 *
 * Reads from .env:
 *   NETLIFY_PAT, NETLIFY_SITE_ID, DOMAIN
 *
 * What it does:
 *   1. Validates Netlify PAT and SITE_ID
 *   2. PATCHes site with custom_domain
 *   3. Verifies domain is set in response
 *   4. Reports DNS records needed for Namecheap
 *
 * CRITICAL:
 *   - Custom domain MUST be added to Netlify BEFORE configuring DNS
 *   - DNS pointing to Netlify without domain config returns 404
 *
 * Requirements:
 *   - Node.js v18+ (uses built-in fetch)
 *   - .cjs extension (Astro projects have "type": "module")
 *
 * After use, DELETE this script from the project root.
 */

require('dotenv').config();

const NETLIFY_PAT = process.env.NETLIFY_PAT;
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID;
const NETLIFY_SITE_URL = process.env.NETLIFY_SITE_URL;
const DOMAIN = process.env.DOMAIN;
const DRY_RUN = process.argv.includes('--dry-run');

const API_BASE = 'https://api.netlify.com/api/v1';
const HEADERS = {
  'Authorization': `Bearer ${NETLIFY_PAT}`,
  'Content-Type': 'application/json'
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
}

function validateInputs() {
  const missing = [];
  if (!NETLIFY_PAT) missing.push('NETLIFY_PAT');
  if (!NETLIFY_SITE_ID) missing.push('NETLIFY_SITE_ID');
  if (!DOMAIN) missing.push('DOMAIN');

  if (missing.length > 0) {
    logError(`Missing .env variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (DOMAIN.startsWith('http')) {
    logError(`DOMAIN must be bare domain (e.g., "example.com"), got: "${DOMAIN}"`);
    process.exit(1);
  }
}

async function getCurrentSiteInfo() {
  log('Fetching current site info...');
  const res = await fetch(`${API_BASE}/sites/${NETLIFY_SITE_ID}`, { headers: HEADERS });

  if (!res.ok) {
    logError(`Failed to get site info: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const site = await res.json();
  log(`Current site: ${site.name}`);
  log(`Current custom_domain: ${site.custom_domain || 'none'}`);
  return site;
}

async function addCustomDomain() {
  log(`Adding custom domain: ${DOMAIN}`);

  const body = { custom_domain: DOMAIN };

  if (DRY_RUN) {
    log(`[DRY RUN] Would PATCH /api/v1/sites/${NETLIFY_SITE_ID} with:`);
    log(JSON.stringify(body, null, 2));
    return { custom_domain: DOMAIN, name: 'dry-run' };
  }

  const res = await fetch(`${API_BASE}/sites/${NETLIFY_SITE_ID}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify(body)
  });

  if (res.ok) {
    const site = await res.json();
    log(`Custom domain set: ${site.custom_domain}`);
    return site;
  } else {
    const text = await res.text();
    logError(`Failed to set custom domain: ${res.status} — ${text}`);

    if (res.status === 422) {
      log('422 may mean the domain is already assigned to another Netlify site.');
      log('Remove it from the other site first, then retry.');
    }
    process.exit(1);
  }
}

async function main() {
  console.log('=== Netlify Custom Domain Setup ===\n');

  if (DRY_RUN) {
    log('--- DRY RUN MODE — no changes will be made ---');
  }

  validateInputs();

  if (!DRY_RUN) {
    const current = await getCurrentSiteInfo();
    if (current.custom_domain === DOMAIN) {
      log('Custom domain already set. No changes needed.');
      console.log('\n=== ALREADY CONFIGURED ===');
      console.log(`Domain: ${DOMAIN}`);
      console.log('Proceeding to DNS records needed...');
    } else {
      await addCustomDomain();
    }
  } else {
    await addCustomDomain();
  }

  // Report DNS records needed
  const bareNetlifyUrl = (NETLIFY_SITE_URL || '').replace(/^https?:\/\//, '');
  console.log('\n=== DNS RECORDS NEEDED (for Namecheap Phase 09) ===');
  console.log(`  A record:     @ → 75.2.60.5 (TTL 3600)`);
  console.log(`  CNAME record: www → ${bareNetlifyUrl || '[NETLIFY_SITE_URL from .env]'} (TTL 3600)`);

  console.log('\n=== NEXT STEPS ===');
  console.log('1. Update astro.config.mjs: site: \'https://' + DOMAIN + '\'');
  console.log('2. Run: npm run build');
  console.log('3. Redeploy (git push or netlify deploy --prod --dir=./dist)');
  console.log('4. Then configure DNS with configure-dns.cjs');
  console.log('\nRemember to DELETE this script before committing.');
}

main().catch(err => {
  logError(err.message);
  process.exit(1);
});
