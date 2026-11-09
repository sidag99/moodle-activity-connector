// Windows and Linux launch this entry point directly via the operating system's URL handler.
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const [inbox, scheme, link, ...extra] = process.argv.slice(2);
if (extra.length === 0 && inbox && basename(inbox) === 'callback' &&
    basename(dirname(inbox)).startsWith('moodle-handoff-') &&
    /^moodle-link-[a-f0-9]{16}$/.test(scheme ?? '') &&
    link?.startsWith(scheme + '://token=') && link.length <= 600) {
  // Publish the complete callback atomically. The waiting process validates site and nonce.
  const temporary = inbox + '.partial-' + process.pid;
  try {
    await writeFile(temporary, link, { mode: 0o600, flag: 'wx' });
    await rename(temporary, inbox);
  } catch { /* The sign-in may already have ended. Never print the callback. */ }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
