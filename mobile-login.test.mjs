import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { moodleHome, mobileLaunch, parseCallback } from './mobile-login.mjs';

test('app sign-in uses the school installation and accepts only a matching callback', () => {
  const home = moodleHome('https://moodle.example.edu/learning');
  const passport = 'fixture-passport';
  const launch = mobileLaunch(home, null, passport);
  assert.equal(launch.pathname, '/learning/admin/tool/mobile/launch.php');
  assert.equal(launch.searchParams.get('service'), 'moodle_mobile_app');
  assert.equal(launch.searchParams.get('passport'), passport);
  const scheme = launch.searchParams.get('urlscheme');
  const hash = createHash('md5').update(home.href.slice(0, -1) + passport).digest('hex');
  const expected = 'a'.repeat(32);
  const encoded = Buffer.from(hash + ':::' + expected + ':::' + 'b'.repeat(32)).toString('base64');
  const link = scheme + '://token=' + encoded;
  assert.equal(parseCallback(link, home, passport), expected);
  assert.equal(parseCallback('moodlemobile://token=' + encoded, home, passport), null);
  assert.throws(() => parseCallback(link, home, 'another-attempt'), /did not match/);
  assert.throws(() => parseCallback(link, moodleHome('https://other.example.edu'), passport), /did not match/);
  assert.throws(() => mobileLaunch(home, 'https://other.example.edu/admin/tool/mobile/launch.php', passport), /outside/);
  assert.throws(() => mobileLaunch(home, '/admin/tool/mobile/launch.php', passport), /outside/);
});
