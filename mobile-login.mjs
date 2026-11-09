import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { chromium } from 'playwright-core';
import { client } from './moodle.mjs';

const scheme = 'moodle-activity-connector';
const configFile = new URL('./.env', import.meta.url);

export function moodleHome(value) {
  let home;
  try { home = new URL(value?.trim()); } catch { throw new Error('Set the Moodle home URL in .env first.'); }
  if (home.protocol !== 'https:' || home.username || home.password || home.search || home.hash) {
    throw new Error('Use an HTTPS Moodle home URL with no credentials, query or fragment.');
  }
  if (!home.pathname.endsWith('/')) home.pathname += '/';
  return home;
}

export function mobileLaunch(home, launchUrl, passport) {
  const endpoint = new URL(launchUrl ?? 'admin/tool/mobile/launch.php', home);
  const expected = new URL('admin/tool/mobile/launch.php', home);
  if (endpoint.origin !== expected.origin || endpoint.pathname !== expected.pathname ||
      endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('The site announced a mobile login endpoint outside its Moodle installation.');
  }
  endpoint.search = new URLSearchParams({ service: 'moodle_mobile_app', passport, urlscheme: scheme });
  return endpoint;
}

export function parseCallback(location, home, passport) {
  const prefix = scheme + '://token=';
  if (!location?.startsWith(prefix)) return null;
  const payload = location.slice(prefix.length);
  const [siteId, token] = /^[A-Za-z0-9+/=]{20,512}$/.test(payload)
    ? Buffer.from(payload, 'base64').toString('utf8').split(':::') : [];
  // Moodle binds the handoff to its canonical base URL and this attempt's one-time passport.
  const expected = createHash('md5').update(home.href.replace(/\/$/, '') + passport).digest('hex');
  if (!/^[a-f0-9]{32}$/.test(siteId ?? '') ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(siteId)) ||
      !/^[a-zA-Z0-9]{32}$/.test(token ?? '')) throw new Error('The Moodle callback did not match this sign-in.');
  return token;
}

async function publicConfig(home) {
  const url = new URL('lib/ajax/service.php?info=tool_mobile_get_public_config', home);
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ index: 0, methodname: 'tool_mobile_get_public_config', args: {} }]),
  });
  if (!response.ok) throw new Error('Moodle public configuration was not reachable.');
  const [result] = await response.json();
  if (result?.error || Number(result?.data?.enablemobilewebservice) !== 1) {
    throw new Error('This site did not advertise mobile web services.');
  }
  if (![2, 3].includes(Number(result.data.typeoflogin))) {
    throw new Error('This site does not advertise the browser-based mobile sign-in flow. Use a security key if available.');
  }
  return result.data;
}

async function browserSignIn(home, endpoint, passport) {
  const profile = await mkdtemp(join(tmpdir(), 'moodle-login-'));
  let browser, timer;
  try {
    browser = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
    const page = browser.pages()[0] ?? await browser.newPage();
    const cdp = await browser.newCDPSession(page);
    const handoff = new Promise((done, fail) => {
      timer = setTimeout(() => fail(new Error('Sign-in timed out. Please retry.')), 12 * 60 * 1000);
      page.once('close', () => fail(new Error('Sign-in window was closed.')));
      cdp.on('Fetch.requestPaused', async event => {
        const { requestId } = event;
        const request = new URL(event.request.url);
        const location = event.responseHeaders?.find(h => h.name.toLowerCase() === 'location')?.value;
        if (request.origin !== endpoint.origin || request.pathname !== endpoint.pathname ||
            !/^[a-z][a-z0-9+.-]*:\/\/token=/i.test(location ?? '')) {
          await cdp.send('Fetch.continueResponse', { requestId }).catch(() => {});
          return;
        }
        try {
          const token = parseCallback(location, home, passport);
          if (!token) throw new Error('The institution forced a different app callback. Ask its Moodle support for an approved connection.');
          await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' },
              { name: 'Cache-Control', value: 'no-store' }],
            body: Buffer.from('Sign-in received. Checking read access…').toString('base64') });
          done(token);
        } catch (error) {
          await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {});
          fail(error);
        }
      });
    });
    handoff.catch(() => {});
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: endpoint.origin + endpoint.pathname + '*',
      resourceType: 'Document', requestStage: 'Response' }] });
    console.log('Sign in using your normal school account in the separate Chrome window.');
    void page.goto(endpoint.href, { waitUntil: 'commit', timeout: 0 }).catch(() => {});
    return await handoff;
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function saveToken(field, token) {
  const existing = await readFile(configFile, 'utf8');
  const pattern = new RegExp('^\\s*(?:export\\s+)?' + field + '\\s*=[^\\r\\n]*', 'gm');
  const updated = existing.replace(pattern, '').trimEnd() + '\n' + field + '=' + token + '\n';
  const temp = new URL('.env.mobile-' + randomBytes(12).toString('hex'), configFile);
  try {
    await writeFile(temp, updated, { flag: 'wx', mode: 0o600 });
    await rename(temp, configFile);
  } finally {
    await rm(temp, { force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== '--exam')) {
    throw new Error('Usage: npm run login [-- --exam]');
  }
  const exam = args[0] === '--exam';
  const settings = parseEnv(await readFile(configFile, 'utf8'));
  const home = moodleHome(settings[exam ? 'MOODLE_EXAM_URL' : 'MOODLE_URL']);
  const passport = randomBytes(24).toString('hex');
  const config = await publicConfig(home);
  const endpoint = mobileLaunch(home, config.launchurl, passport);
  const token = await browserSignIn(home, endpoint, passport);
  const call = client({ base: home.href, token });
  const profile = await call('core_webservice_get_site_info');
  if (!Number(profile.userid)) throw new Error('Moodle did not verify an authenticated account.');
  const timeline = await call('core_calendar_get_action_events_by_timesort',
    { timesortfrom: 1, limitnum: 1, limittononsuspendedevents: 1 });
  if (!Array.isArray(timeline.events)) throw new Error('Moodle did not grant readable Timeline access.');
  await saveToken(exam ? 'MOODLE_EXAM_TOKEN' : 'MOODLE_TOKEN', token);
  console.log('Read access verified. Saved the token privately in .env. Run npm run digest -- --preview to check activity coverage.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Never log Playwright errors, browser URLs, handoff contents, or raw HTTP responses.
    const safe = /^(Set the Moodle home|Use an HTTPS|The site announced|This site (did not|does not)|Moodle (did not|public configuration)|Sign-in (window|timed)|The (Moodle callback|institution forced)|Usage:|core_)/;
    console.error(safe.test(error.message) ? error.message : 'Sign-in failed. Check that .env exists, Google Chrome is installed, and your Moodle site is reachable.');
    process.exitCode = 1;
  });
}
