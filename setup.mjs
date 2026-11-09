import { spawnSync } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const file = name => new URL(name, import.meta.url);
const env = file('.env');
const command = process.execPath;
const args = ['--env-file=' + fileURLToPath(env), fileURLToPath(file('server.mjs'))];

function connectionSettings() {
  console.log('\nChatGPT desktop: Settings → MCP servers → Add server. Choose STDIO.');
  console.log('Name: Moodle\nCommand: ' + command);
  console.log('Arguments (add each separately):\n  ' + args.join('\n  '));
  console.log('Save and restart, then use /mcp to check that Moodle is connected.');
  console.log('\nClaude Desktop: merge this entry into your local MCP configuration and restart:');
  console.log(JSON.stringify({ mcpServers: { moodle: { command, args } } }, null, 2));
  console.log('\nClaude Code: use the same JSON with claude mcp add-json (pass only the inner moodle entry).');
  console.log('To check your Moodle connection first, run npm run digest -- --preview.');
}

async function readSettings() {
  try { return parseEnv(await readFile(env, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function configure() {
  const settings = await readSettings();
  if (settings?.MOODLE_TOKEN?.trim()) {
    console.log('Found an existing Moodle token. No settings were changed.');
    return;
  }
  if (!process.stdin.isTTY) throw new Error('Run setup in a terminal, or use --print for connection settings only.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let useBrowser;
  try {
    let url = settings?.MOODLE_URL?.trim();
    if (!url || url === 'https://moodle.example.edu/') {
      const input = (await rl.question('Moodle home URL (https://…): ')).trim();
      let home;
      try { home = new URL(input); } catch { throw new Error('Enter a valid Moodle home URL.'); }
      if (home.protocol !== 'https:' || home.username || home.password || home.search || home.hash) {
        throw new Error('Use an HTTPS URL with no username, password, query or fragment.');
      }
      if (!home.pathname.endsWith('/')) home.pathname += '/';
      url = home.href;
      if (settings) {
        // Node dotenv uses the last definition. Preserve all other settings and comments.
        await writeFile(env, '\nMOODLE_URL=' + JSON.stringify(url) + '\n', { flag: 'a' });
      } else {
        const sample = await readFile(file('.env.example'), 'utf8');
        await writeFile(env, sample.replace(/^MOODLE_URL=.*$/m, () => 'MOODLE_URL=' + JSON.stringify(url)),
          { flag: 'wx', mode: 0o600 });
      }
    }
    if (process.platform !== 'win32') await chmod(env, 0o600);
    console.log('\n1. I have a Moodle Security key.\n2. Use browser sign-in (opens your default browser).');
    const option = (await rl.question('Choose 1 or 2: ')).trim();
    if (!['1', '2'].includes(option)) throw new Error('Choose 1 or 2. Run setup again to continue.');
    useBrowser = option === '2';
  } finally {
    rl.close();
  }
  if (useBrowser) {
    const result = spawnSync(command, [fileURLToPath(file('mobile-login.mjs'))], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Browser sign-in did not finish. Your Moodle URL was saved; run npm run setup to retry.');
  } else {
    console.log('Open ' + fileURLToPath(env) + ' in a local editor and set MOODLE_TOKEN to your Security key.');
    console.log('Do not paste it into the client configuration or a chat.');
  }
}

try {
  const flags = process.argv.slice(2);
  if (flags.length && (flags.length !== 1 || flags[0] !== '--print')) throw new Error('Usage: npm run setup [-- --print]');
  if (!flags.length) await configure();
  connectionSettings();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
