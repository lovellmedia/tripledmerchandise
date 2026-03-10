/**
 * configure-dns.cjs — Configure Namecheap DNS records for Netlify
 *
 * Usage: Copy to project root, then run:
 *   node configure-dns.cjs
 *   node configure-dns.cjs --dry-run
 *
 * Reads from .env:
 *   DOMAIN, NETLIFY_SITE_URL, NAMECHEAP_API_USER, NAMECHEAP_API_KEY, NAMECHEAP_CLIENT_IP
 *
 * What it does (in EXACT order):
 *   1. setDefault — Reset domain to Namecheap BasicDNS
 *   2. Wait 3 seconds for propagation
 *   3. getHosts — Retrieve current DNS records (logs them)
 *   4. setHosts — Set A record (@→75.2.60.5) + CNAME (www→netlify)
 *   5. getHosts — Verify records are set correctly
 *
 * CRITICAL:
 *   - setDefault MUST be called BEFORE getHosts
 *   - Apex domain (@) uses A record, NOT CNAME
 *   - CNAME address is bare hostname (NO https:// prefix)
 *   - All credentials from .env, never hardcoded
 *
 * Requirements:
 *   - Node.js v18+ (uses built-in fetch)
 *   - .cjs extension (Astro projects have "type": "module")
 *
 * After use, DELETE this script from the project root.
 */

require('dotenv').config();

const DOMAIN = process.env.DOMAIN;
const NETLIFY_SITE_URL = process.env.NETLIFY_SITE_URL;
const API_USER = process.env.NAMECHEAP_API_USER;
const API_KEY = process.env.NAMECHEAP_API_KEY;
const CLIENT_IP = process.env.NAMECHEAP_CLIENT_IP;
const DRY_RUN = process.argv.includes('--dry-run');

const NETLIFY_IP = '75.2.60.5';
const API_BASE = 'https://api.namecheap.com/xml.response';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
}

function parseDomain(domain) {
  // Handle .co.uk, .com.au etc.
  const parts = domain.split('.');
  if (parts.length === 2) {
    return { sld: parts[0], tld: parts[1] };
  } else if (parts.length === 3) {
    // Check for compound TLDs
    const compoundTlds = ['co.uk', 'com.au', 'co.nz', 'org.uk', 'com.br'];
    const lastTwo = parts.slice(1).join('.');
    if (compoundTlds.includes(lastTwo)) {
      return { sld: parts[0], tld: lastTwo };
    }
    return { sld: parts[0], tld: parts.slice(1).join('.') };
  }
  return { sld: parts[0], tld: parts.slice(1).join('.') };
}

function buildBaseParams() {
  const { sld, tld } = parseDomain(DOMAIN);
  return `ApiUser=${API_USER}&ApiKey=${API_KEY}&UserName=${API_USER}&ClientIp=${CLIENT_IP}&SLD=${sld}&TLD=${tld}`;
}

async function callNamecheap(command, extraParams = '') {
  const baseParams = buildBaseParams();
  const url = `${API_BASE}?Command=${command}&${baseParams}${extraParams ? '&' + extraParams : ''}`;

  if (DRY_RUN) {
    log(`[DRY RUN] Would call: ${command}`);
    log(`[DRY RUN] URL (credentials masked): ${url.replace(API_KEY, '***').replace(API_USER, '***')}`);
    return '<ApiResponse Status="OK"><CommandResponse></CommandResponse></ApiResponse>';
  }

  log(`Calling: ${command}`);
  const res = await fetch(url);
  const text = await res.text();

  if (text.includes('Status="ERROR"')) {
    logError(`API Error for ${command}:`);
    logError(text);
    return text;
  }

  log(`Response status: OK`);
  return text;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validateInputs() {
  const missing = [];
  if (!DOMAIN) missing.push('DOMAIN');
  if (!NETLIFY_SITE_URL) missing.push('NETLIFY_SITE_URL');
  if (!API_USER) missing.push('NAMECHEAP_API_USER');
  if (!API_KEY) missing.push('NAMECHEAP_API_KEY');
  if (!CLIENT_IP) missing.push('NAMECHEAP_CLIENT_IP');

  if (missing.length > 0) {
    logError(`Missing .env variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Validate NETLIFY_SITE_URL has no https:// prefix
  if (NETLIFY_SITE_URL.startsWith('http')) {
    logError(`NETLIFY_SITE_URL must be bare hostname (e.g., "example.netlify.app"), got: "${NETLIFY_SITE_URL}"`);
    process.exit(1);
  }

  const { sld, tld } = parseDomain(DOMAIN);
  log(`Domain parsed: SLD=${sld}, TLD=${tld}`);
}

async function main() {
  console.log('=== Namecheap DNS Configuration ===\n');

  if (DRY_RUN) {
    log('--- DRY RUN MODE — no changes will be made ---');
  }

  validateInputs();

  // Step 1: Reset to BasicDNS (MUST BE FIRST)
  log('\n--- Step 1: Reset to BasicDNS ---');
  const setDefaultResult = await callNamecheap('namecheap.domains.dns.setDefault');
  if (setDefaultResult.includes('Status="ERROR"')) {
    logError('setDefault failed. Check API credentials and domain ownership.');
    process.exit(1);
  }
  log('setDefault: OK');

  // Wait 3 seconds for propagation
  log('Waiting 3 seconds for DNS propagation...');
  if (!DRY_RUN) await sleep(3000);

  // Step 2: Get current records (for logging)
  log('\n--- Step 2: Retrieve current DNS records ---');
  const currentRecords = await callNamecheap('namecheap.domains.dns.getHosts');
  log('Current records retrieved (logged above).');

  // Step 3: Set DNS records for Netlify
  log('\n--- Step 3: Set DNS records ---');
  log(`  A record: @ → ${NETLIFY_IP} (TTL 3600)`);
  log(`  CNAME: www → ${NETLIFY_SITE_URL} (TTL 3600)`);

  const hostParams = [
    'HostName1=@', 'RecordType1=A', `Address1=${NETLIFY_IP}`, 'TTL1=3600',
    'HostName2=www', 'RecordType2=CNAME', `Address2=${NETLIFY_SITE_URL}`, 'TTL2=3600'
  ].join('&');

  const setResult = await callNamecheap('namecheap.domains.dns.setHosts', hostParams);
  if (setResult.includes('Status="ERROR"')) {
    logError('setHosts failed. Check the error above.');
    process.exit(1);
  }
  log('setHosts: OK');

  // Step 4: Verify records
  log('\n--- Step 4: Verify DNS records ---');
  const verifyResult = await callNamecheap('namecheap.domains.dns.getHosts');

  // Check for expected records in response
  const hasARecord = verifyResult.includes(NETLIFY_IP);
  const hasCNAME = verifyResult.includes(NETLIFY_SITE_URL);

  console.log('\n=== VERIFICATION ===');
  console.log(`A record (@→${NETLIFY_IP}): ${hasARecord || DRY_RUN ? 'FOUND' : 'NOT FOUND'}`);
  console.log(`CNAME (www→${NETLIFY_SITE_URL}): ${hasCNAME || DRY_RUN ? 'FOUND' : 'NOT FOUND'}`);

  if ((hasARecord && hasCNAME) || DRY_RUN) {
    console.log('\n=== SUCCESS ===');
    console.log('DNS records configured correctly.');
    console.log(`\nNext steps:`);
    console.log(`  1. Wait 5-30 minutes for DNS propagation`);
    console.log(`  2. Check: nslookup ${DOMAIN}`);
    console.log(`  3. Or visit: https://www.whatsmydns.net/?d=${DOMAIN}&t=A`);
    console.log(`  4. Verify https://${DOMAIN} loads the site`);
    console.log(`  5. SSL auto-provisions once DNS resolves to Netlify`);
  } else {
    logError('DNS verification failed — records not found in response.');
    logError('Full API response:');
    console.error(verifyResult);
    process.exit(1);
  }

  console.log('\nRemember to DELETE this script before committing.');
}

main().catch(err => {
  logError(err.message);
  process.exit(1);
});
