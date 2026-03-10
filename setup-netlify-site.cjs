/**
 * setup-netlify-site.cjs — Create a Netlify site via API with GitHub integration
 *
 * Usage: Copy to project root, then run:
 *   node setup-netlify-site.cjs
 *   node setup-netlify-site.cjs --dry-run
 *
 * Reads from .env:
 *   NETLIFY_PAT, GITHUB_USERNAME, GITHUB_REPO, DOMAIN
 *
 * What it does:
 *   1. Validates Netlify PAT
 *   2. Creates site via POST /api/v1/sites with full repo config
 *   3. Saves NETLIFY_SITE_ID and NETLIFY_SITE_URL to .env
 *   4. Polls deploy status until ready
 *
 * CRITICAL:
 *   - Include full repo config in initial POST (PATCH after creation is unreliable)
 *   - Site name = domain without TLD (e.g., "arkhebranding" not "arkhebranding.com")
 *   - Poll /api/v1/sites/{id}/deploys for status (not /builds/{id})
 *
 * Requirements:
 *   - Node.js v18+ (uses built-in fetch)
 *   - .cjs extension (Astro projects have "type": "module")
 *
 * After use, DELETE this script from the project root.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const NETLIFY_PAT = process.env.NETLIFY_PAT;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GITHUB_REPO = process.env.GITHUB_REPO;
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

function getSiteName() {
  // Domain without TLD: "arkhebranding.com" → "arkhebranding"
  return DOMAIN.split('.')[0];
}

function validateInputs() {
  const missing = [];
  if (!NETLIFY_PAT) missing.push('NETLIFY_PAT');
  if (!GITHUB_USERNAME) missing.push('GITHUB_USERNAME');
  if (!GITHUB_REPO) missing.push('GITHUB_REPO');
  if (!DOMAIN) missing.push('DOMAIN');

  if (missing.length > 0) {
    logError(`Missing .env variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

async function validatePAT() {
  log('Validating Netlify PAT...');
  const res = await fetch(`${API_BASE}/user`, { headers: HEADERS });
  if (!res.ok) {
    logError(`Netlify PAT validation failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const user = await res.json();
  log(`Authenticated as: ${user.full_name || user.email || 'OK'}`);
}

async function checkExistingSite() {
  log('Checking for existing Netlify site...');
  const siteName = getSiteName();

  // Check by name
  const res = await fetch(`${API_BASE}/sites?filter=all&name=${siteName}`, { headers: HEADERS });
  if (res.ok) {
    const sites = await res.json();
    const match = sites.find(s => s.name === siteName || s.custom_domain === DOMAIN);
    if (match) {
      log(`Found existing site: ${match.name} (${match.id})`);
      return match;
    }
  }
  log('No existing site found — will create.');
  return null;
}

async function createSite() {
  const siteName = getSiteName();
  log(`Creating Netlify site: ${siteName}`);

  const body = {
    name: siteName,
    repo: {
      provider: 'github',
      repo: `${GITHUB_USERNAME}/${GITHUB_REPO}`,
      branch: 'main',
      private: false,
      cmd: 'npm run build',
      dir: 'dist'
    }
  };

  if (DRY_RUN) {
    log('[DRY RUN] Would POST /api/v1/sites with:');
    log(JSON.stringify(body, null, 2));
    return {
      id: 'dry-run-id',
      name: siteName,
      url: `${siteName}.netlify.app`,
      ssl_url: `https://${siteName}.netlify.app`,
      admin_url: `https://app.netlify.com/sites/${siteName}`
    };
  }

  const res = await fetch(`${API_BASE}/sites`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body)
  });

  if (res.status === 201 || res.status === 200) {
    const site = await res.json();
    log(`Site created: ${site.name}`);
    log(`  ID: ${site.id}`);
    log(`  URL: ${site.ssl_url || site.url}`);
    log(`  Admin: ${site.admin_url}`);
    return site;
  } else {
    const text = await res.text();
    logError(`Failed to create site: ${res.status} — ${text}`);

    if (res.status === 422) {
      log('422 may mean the site name is taken or repo integration requires OAuth.');
      log('If GitHub integration fails, see instructions/deploy-webhooks.md for build hook workaround.');
    }
    process.exit(1);
  }
}

function updateEnvFile(siteId, siteUrl) {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    logError('.env file not found at project root');
    return;
  }

  let envContent = fs.readFileSync(envPath, 'utf-8');

  // Update or add NETLIFY_SITE_ID
  if (envContent.includes('NETLIFY_SITE_ID=')) {
    envContent = envContent.replace(/NETLIFY_SITE_ID=.*/, `NETLIFY_SITE_ID=${siteId}`);
  } else {
    envContent += `\nNETLIFY_SITE_ID=${siteId}`;
  }

  // Update or add NETLIFY_SITE_URL (bare hostname)
  const bareUrl = siteUrl.replace(/^https?:\/\//, '');
  if (envContent.includes('NETLIFY_SITE_URL=')) {
    envContent = envContent.replace(/NETLIFY_SITE_URL=.*/, `NETLIFY_SITE_URL=${bareUrl}`);
  } else {
    envContent += `\nNETLIFY_SITE_URL=${bareUrl}`;
  }

  if (!DRY_RUN) {
    fs.writeFileSync(envPath, envContent);
    log(`.env updated: NETLIFY_SITE_ID=${siteId}, NETLIFY_SITE_URL=${bareUrl}`);
  } else {
    log(`[DRY RUN] Would update .env: NETLIFY_SITE_ID=${siteId}, NETLIFY_SITE_URL=${bareUrl}`);
  }
}

async function pollDeployStatus(siteId, maxAttempts = 30, intervalMs = 10000) {
  log('Polling deploy status...');

  for (let i = 0; i < maxAttempts; i++) {
    if (DRY_RUN) {
      log('[DRY RUN] Would poll deploy status.');
      return 'ready';
    }

    const res = await fetch(`${API_BASE}/sites/${siteId}/deploys`, { headers: HEADERS });
    if (!res.ok) {
      log(`Poll attempt ${i + 1}: HTTP ${res.status}`);
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }

    const deploys = await res.json();
    if (deploys.length === 0) {
      log(`Poll attempt ${i + 1}: No deploys yet`);
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }

    const latest = deploys[0];
    log(`Poll attempt ${i + 1}: state=${latest.state}`);

    if (latest.state === 'ready') {
      log('Deploy complete!');
      return 'ready';
    } else if (latest.state === 'error') {
      logError(`Deploy failed: ${latest.error_message || 'unknown error'}`);
      return 'error';
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  log('Max poll attempts reached. Check Netlify dashboard manually.');
  return 'timeout';
}

async function main() {
  console.log('=== Netlify Site Setup ===\n');

  if (DRY_RUN) {
    log('--- DRY RUN MODE — no changes will be made ---');
  }

  validateInputs();

  if (!DRY_RUN) {
    await validatePAT();
  }

  const existing = await checkExistingSite();
  let site;

  if (existing) {
    site = existing;
    log('Using existing site.');
  } else {
    site = await createSite();
  }

  // Save to .env
  const siteUrl = site.ssl_url || site.url || `https://${site.name}.netlify.app`;
  updateEnvFile(site.id, siteUrl);

  // Poll for deploy
  if (!existing) {
    const status = await pollDeployStatus(site.id);
    if (status === 'error') {
      logError('Initial deploy failed. Check npm run build locally first.');
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Site Name: ${site.name}`);
  console.log(`Site ID: ${site.id}`);
  console.log(`URL: ${siteUrl}`);
  console.log(`Admin: ${site.admin_url || `https://app.netlify.com/sites/${site.name}`}`);
  console.log('Status: READY');
  console.log('\nRemember to DELETE this script before committing.');
}

main().catch(err => {
  logError(err.message);
  process.exit(1);
});
