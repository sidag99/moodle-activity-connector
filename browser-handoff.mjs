import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const run = (command, args, options) => exec(command, args, {
  timeout: 15000, windowsHide: true, ...options,
});
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const receiver = fileURLToPath(new URL('./receive-handoff.mjs', import.meta.url));
const ignore = promise => promise.catch(() => {});

async function macHandler(scheme, inbox) {
  const appDir = await mkdtemp(fileURLToPath(new URL('./moodle-callback-app-', import.meta.url)));
  const app = join(appDir, 'Moodle Activity Connector.app');
  // Apple events deliver the link directly; no shell or process arguments carry the token.
  const script = [
    'use framework "Foundation"',
    'use scripting additions',
    'on open location callbackURL',
    `  if callbackURL does not start with "${scheme}://token=" then return`,
    '  if (length of callbackURL) is greater than 600 then return',
    '  set textValue to current application\'s NSString\'s stringWithString:callbackURL',
    `  textValue's writeToFile:${JSON.stringify(inbox)} atomically:true encoding:4 |error|:(missing value)`,
    'end open location',
  ].join('\n');
  const cleanup = async () => {
    await ignore(run(lsregister, ['-u', app]));
    await rm(appDir, { recursive: true, force: true });
  };
  try {
    await run('/usr/bin/osacompile', ['-o', app, '-e', script]);
    const plist = join(app, 'Contents', 'Info.plist');
    await run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'org.moodleactivity.' + scheme, plist]);
    await run('/usr/bin/plutil', ['-insert', 'CFBundleURLTypes', '-json', JSON.stringify([
      { CFBundleTypeRole: 'Viewer', CFBundleURLName: 'Moodle sign-in', CFBundleURLSchemes: [scheme] },
    ]), plist]);
    await run('/usr/bin/plutil', ['-insert', 'LSUIElement', '-bool', 'YES', plist]);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    await run(lsregister, ['-f', app]);
    await run('/usr/bin/open', ['-g', '-a', app]);
    return cleanup;
  } catch (error) { await cleanup(); throw error; }
}

function winQuote(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

async function windowsHandler(scheme, inbox) {
  const key = 'HKCU\\Software\\Classes\\' + scheme;
  const cleanup = () => ignore(run('reg.exe', ['delete', key, '/f']));
  try {
    await run('reg.exe', ['add', key, '/ve', '/d', 'URL:Moodle Activity Connector', '/f']);
    await run('reg.exe', ['add', key, '/v', 'URL Protocol', '/d', '', '/f']);
    const command = [process.execPath, receiver, inbox, scheme, '%1'].map(winQuote).join(' ');
    await run('reg.exe', ['add', key + '\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', command, '/f']);
    return cleanup;
  } catch (error) { await cleanup(); throw error; }
}

function desktopQuote(value) {
  // Desktop Entry Exec quoting is not shell quoting: first escape Exec metacharacters,
  // then escape each backslash again for the desktop file's string parser.
  return '"' + value.replace(/%/g, '%%').replace(/[\\"$`]/g, c => '\\' + c).replace(/\\/g, '\\\\') + '"';
}

async function linuxHandler(scheme, inbox) {
  const dir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications');
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const desktop = scheme + '.desktop';
  const path = join(dir, desktop);
  const mime = 'x-scheme-handler/' + scheme;
  await mkdir(dir, { recursive: true });
  const command = [process.execPath, receiver, inbox, scheme].map(desktopQuote).join(' ') + ' %u';
  await writeFile(path, [
    '[Desktop Entry]', 'Type=Application', 'Name=Moodle Activity Connector',
    'NoDisplay=true', 'Terminal=false', 'Exec=' + command, 'MimeType=' + mime + ';', '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  const cleanup = async () => {
    await rm(path, { force: true });
    // xdg-mime may use a desktop-specific list. Remove only this attempt's unique association.
    for (const folder of [dir, config]) {
      const names = await readdir(folder).catch(() => []);
      for (const name of names.filter(n => /^(?:[a-zA-Z0-9_-]+-)?mimeapps\.list$/.test(n))) {
        const file = join(folder, name);
        await ignore((async () => {
          const text = await readFile(file, 'utf8');
          const updated = text.split('\n').filter(line =>
            !line.startsWith(mime + '=') || line.slice(mime.length + 1).trim() !== desktop + ';' &&
              line.slice(mime.length + 1).trim() !== desktop).join('\n');
          if (updated !== text) await writeFile(file, updated);
        })());
      }
    }
    await ignore(run('update-desktop-database', [dir]));
  };
  try {
    await ignore(run('update-desktop-database', [dir]));
    await run('xdg-mime', ['default', desktop, mime]);
    return cleanup;
  } catch (error) { await cleanup(); throw error; }
}

export async function openDefaultBrowser(url) {
  if (process.platform === 'darwin') return run('/usr/bin/open', [url.href]);
  if (process.platform === 'linux') return new Promise((resolve, reject) => {
    // xdg-open sometimes waits for the browser process to exit.
    const opener = spawn('xdg-open', [url.href], { stdio: 'ignore', detached: true });
    opener.once('error', reject);
    opener.once('spawn', () => { opener.unref(); resolve(); });
  });
  if (process.platform === 'win32') {
    // Windows PowerShell uses the URL handler selected by the user. No URL is interpolated into code.
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:MOODLE_SIGN_IN_URL'], {
      env: { ...process.env, MOODLE_SIGN_IN_URL: url.href },
    });
  }
  throw new Error('This operating system has no supported default browser launcher.');
}

export async function makeHandoff(scheme) {
  if (!/^moodle-link-[a-f0-9]{16}$/.test(scheme)) throw new Error('Invalid callback scheme.');
  const folder = await mkdtemp(join(tmpdir(), 'moodle-handoff-'));
  const inbox = join(folder, 'callback');
  let unregister;
  try {
    if (process.platform === 'darwin') unregister = await macHandler(scheme, inbox);
    else if (process.platform === 'win32') unregister = await windowsHandler(scheme, inbox);
    else if (process.platform === 'linux') unregister = await linuxHandler(scheme, inbox);
    else throw new Error('Browser sign-in is not available on this operating system.');
    return {
      async receive(signal) {
        for (;;) {
          signal.throwIfAborted();
          try {
            const link = await readFile(inbox, 'utf8');
            await rm(inbox, { force: true });
            return link;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await delay(250, undefined, { signal });
        }
      },
      async close() {
        try { await unregister(); } finally { await rm(folder, { recursive: true, force: true }); }
      },
    };
  } catch {
    await rm(folder, { recursive: true, force: true });
    throw new Error('Could not register a local Moodle sign-in callback. Use a Security key if available.');
  }
}
