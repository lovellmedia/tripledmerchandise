/**
 * create-github-repo.cjs — Create a GitHub repository via API
 *
 * Usage: Copy to project root, then run:
 *   node create-github-repo.cjs
 *   node create-github-repo.cjs --dry-run
 *
 * Reads from .env:
 *   GITHUB_PAT, GITHUB_USERNAME, GITHUB_REPO
 *
 * What it does:
 *   1. Validates PAT by calling GET /user
 *   2. Checks if repo already exists
 *   3. Creates repo via POST /user/repos (auto_init: false)
 *   4. Sets git remote with PAT-authenticated URL
 *   5. Reports success with clone URL
 *
 * Requirements:
 *   - Node.js v18+ (uses built-in fetch)
 *   - .cjs extension (Astro projects have "type": "module")
 *   - .env file with credentials
 *
 * After use, DELETE this script from the project root.
 */

require('dotenv').config();

const GITHUB_PAT = process.env.GITHUB_PAT;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GITHUB_REPO = process.env.GITHUB_REPO;
const DRY_RUN = process.argv.includes('--dry-run');

const API_BASE = 'https://api.github.com';
const HEADERS = {
  'Authorization': `token ${GITHUB_PAT}`,
  'Accept': 'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
  'User-Agent': 'PBN-Site-Builder/1.0'
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
}

async function validateCredentials() {
  log('Validating GitHub PAT...');

  if (!GITHUB_PAT || !GITHUB_USERNAME || !GITHUB_REPO) {
    logError('Missing required .env variables: GITHUB_PAT, GITHUB_USERNAME, GITHUB_REPO');
    process.exit(1);
  }

  const res = await fetch(`${API_BASE}/user`, { headers: HEADERS });
  if (!res.ok) {
    logError(`PAT validation failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const user = await res.json();
  const scopes = res.headers.get('x-oauth-scopes') || '';
  log(`Authenticated as: ${user.login}`);
  log(`Scopes: ${scopes}`);

  if (!scopes.includes('repo')) {
    logError('PAT missing "repo" scope. Regenerate with repo scope enabled.');
    process.exit(1);
  }

  if (user.login.toLowerCase() !== GITHUB_USERNAME.toLowerCase()) {
    logError(`PAT user "${user.login}" does not match GITHUB_USERNAME "${GITHUB_USERNAME}"`);
    process.exit(1);
  }

  return user;
}

async function checkRepoExists() {
  log(`Checking if repo "${GITHUB_USERNAME}/${GITHUB_REPO}" exists...`);
  const res = await fetch(`${API_BASE}/repos/${GITHUB_USERNAME}/${GITHUB_REPO}`, { headers: HEADERS });

  if (res.status === 200) {
    const repo = await res.json();
    log(`Repo already exists: ${repo.html_url}`);
    return repo;
  } else if (res.status === 404) {
    log('Repo does not exist — will create.');
    return null;
  } else {
    logError(`Unexpected status checking repo: ${res.status}`);
    process.exit(1);
  }
}

async function createRepo() {
  log(`Creating repo: ${GITHUB_REPO}`);

  const body = {
    name: GITHUB_REPO,
    private: false,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    auto_init: false  // CRITICAL: do NOT auto_init — causes unrelated-histories conflict
  };

  if (DRY_RUN) {
    log('[DRY RUN] Would POST /user/repos with:');
    log(JSON.stringify(body, null, 2));
    return { html_url: `https://github.com/${GITHUB_USERNAME}/${GITHUB_REPO}`, clone_url: `https://github.com/${GITHUB_USERNAME}/${GITHUB_REPO}.git` };
  }

  const res = await fetch(`${API_BASE}/user/repos`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body)
  });

  if (res.status === 201) {
    const repo = await res.json();
    log(`Repo created: ${repo.html_url}`);
    return repo;
  } else if (res.status === 422) {
    const err = await res.json();
    if (err.errors && err.errors.some(e => e.message === 'name already exists on this account')) {
      log('Repo already exists (422). Fetching existing repo info...');
      return await checkRepoExists();
    }
    logError(`422 Unprocessable Entity: ${JSON.stringify(err)}`);
    process.exit(1);
  } else {
    const text = await res.text();
    logError(`Failed to create repo: ${res.status} — ${text}`);
    process.exit(1);
  }
}

async function main() {
  console.log('=== GitHub Repository Setup ===\n');

  if (DRY_RUN) {
    log('--- DRY RUN MODE — no changes will be made ---');
  }

  await validateCredentials();
  const existing = await checkRepoExists();

  let repo;
  if (existing) {
    repo = existing;
    log('Using existing repo.');
  } else {
    repo = await createRepo();
  }

  // Print git remote command for the user
  const remoteUrl = `https://${GITHUB_PAT}@github.com/${GITHUB_USERNAME}/${GITHUB_REPO}.git`;
  console.log('\n=== NEXT STEPS ===');
  console.log('Run these commands to set remote and push:');
  console.log(`  git remote add origin ${remoteUrl}`);
  console.log('  git push -u origin main');
  console.log('\nIf remote already exists, update it:');
  console.log(`  git remote set-url origin ${remoteUrl}`);
  console.log('  git push -u origin main');

  console.log('\n=== SUMMARY ===');
  console.log(`Repo: ${repo.html_url}`);
  console.log(`Clone URL: ${repo.clone_url || `https://github.com/${GITHUB_USERNAME}/${GITHUB_REPO}.git`}`);
  console.log('Status: READY');
  console.log('\nRemember to DELETE this script before committing.');
}

main().catch(err => {
  logError(err.message);
  process.exit(1);
});
