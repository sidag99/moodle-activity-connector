import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { makeHandoff, openDefaultBrowser } from './browser-handoff.mjs';
import { client } from './moodle.mjs';

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

export function mobileLaunch(home, launchUrl, passport, scheme) {
  const endpoint = new URL(launchUrl ?? 'admin/tool/mobile/launch.php', home);
  const expected = new URL('admin/tool/mobile/launch.php', home);
  if (endpoint.origin !== expected.origin || endpoint.pathname !== expected.pathname ||
      endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('The site announced a mobile login endpoint outside its Moodle installation.');
  }
  endpoint.search = new URLSearchParams({ service: 'moodle_mobile_app', passport, urlscheme: scheme, confirmed: '1' });
  return endpoint;
}

export function parseCallback(location, home, passport, scheme) {
  const prefix = scheme + '://token=';
  if (!location?.startsWith(prefix)) return null;
  let payload;
  try { payload = decodeURIComponent(location.slice(prefix.length)); }
  catch { throw new Error('The Moodle callback did not match this sign-in.'); }
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

async function browserSignIn(home, endpoint, passport, scheme) {
  const cancelled = new AbortController();
  const cancel = () => cancelled.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let callback;
  try {
    callback = await makeHandoff(scheme);
    await openDefaultBrowser(endpoint);
    console.log('Sign in to Moodle in your default browser.');
    console.log('If Moodle shows a launch link, click it. If prompted, open Moodle Activity Connector.');
    const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(12 * 60 * 1000)]);
    for (;;) {
      const link = await callback.receive(signal);
      // A malformed or stale handoff must not interrupt the real sign-in.
      try {
        const token = parseCallback(link, home, passport, scheme);
        if (token) return token;
      } catch { /* Ignore unrecognized callbacks without logging their contents. */ }
    }
  } catch (error) {
    if (error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError') throw new Error('Sign-in timed out. Retry, then open the app link when prompted.');
    if (error.name === 'AbortError') throw new Error('Sign-in was cancelled.');
    throw error;
  } finally {
    await callback?.close().catch(() => {});
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
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
  const scheme = 'moodle-link-' + randomBytes(8).toString('hex');
  const config = await publicConfig(home);
  const endpoint = mobileLaunch(home, config.launchurl, passport, scheme);
  const token = await browserSignIn(home, endpoint, passport, scheme);
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
    // Never log browser URLs, handoff contents, or raw HTTP responses.
    const safe = /^(Set the Moodle home|Use an HTTPS|The site announced|This site (did not|does not)|Moodle (did not|public configuration)|Sign-in (was cancelled|timed)|The (Moodle callback|institution forced)|Could not register|Usage:|core_)/;
    console.error(safe.test(error.message) ? error.message : 'Sign-in failed. Check that .env exists, you have a desktop browser set as default, and your Moodle site is reachable.');
    process.exitCode = 1;
  });
}
