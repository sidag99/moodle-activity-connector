import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { client, configuredSites, collect, scanSite } from './moodle.mjs';
import { renderDigest } from './digest.mjs';

const [site, exam] = configuredSites({
  MOODLE_URL: 'https://moodle.example.edu/learning', MOODLE_TOKEN: 'test-token',
  MOODLE_EXAM_URL: 'https://exams.example.edu/', MOODLE_EXAM_TOKEN: 'other-test-token',
});
const now = 1794229200;

test('scan joins Moodle course-module IDs, pages Timeline, filters closed work and preserves extensions', async () => {
  const url = (type, id) => site.base + 'mod/' + type + '/view.php?id=' + id;
  const course = { id: 8, fullname: 'Physics' };
  const event = (id, instance, modulename, eventtype, timestamp, actionable = true) => ({
    id, instance, modulename, eventtype, timestart: timestamp, timesort: timestamp, course,
    activityname: 'Fallback name', action: { actionable, name: 'Work on activity' },
  });
  const module = (id, instance, modname, name, extra) => ({
    id, instance, modname, name, url: url(modname, id), uservisible: true, ...extra,
  });
  const calls = [];
  const data = await scanSite(site, async (method, args) => {
    calls.push([method, args]);
    switch (method) {
      case 'core_webservice_get_site_info': return { userid: 9 };
      case 'core_enrol_get_users_courses': return [course];
      case 'core_calendar_get_action_events_by_timesort':
        assert.ok(args.timesortfrom > 0, 'Moodle needs a nonzero lower bound to apply the cursor');
        if (!args.aftereventid) return { lastid: 3, events: [
          event(1, 11, 'assign', 'due', now - 3600),
          event(2, 12, 'quiz', 'open', now - 3600),
          event(3, 12, 'quiz', 'close', now + 3600),
        ] };
        if (args.aftereventid === 3) return { lastid: 5, events: [
          event(4, 13, 'quiz', 'open', now + 600, false),
          event(5, 14, 'quiz', 'close', now - 600),
        ] };
        return { events: [] };
      case 'core_course_get_contents': return [{ modules: [
        module(11, 101, 'assign', 'Problem set', { description: '<p>Read chapter <b>3</b>.</p>' }),
        module(12, 102, 'quiz', 'Lab quiz'),
        module(13, 103, 'quiz', 'Upcoming quiz'),
        module(14, 104, 'quiz', 'Closed quiz'),
        module(15, 105, 'assign', 'Extended assignment', { dates: [{ dataid: 'duedate', timestamp: now - 20 }] }),
        module(16, 106, 'assign', 'Already submitted'),
        module(17, 107, 'page', 'Review the readings', { completion: 1, completiondata: { state: 0 } }),
        module(18, 108, 'page', 'Hidden', { uservisible: false, completion: 1, completiondata: { state: 0 } }),
        module(19, 109, 'quiz', 'Practice quiz'),
        module(20, 110, 'quiz', 'Already attempted quiz'),
      ] }];
      case 'mod_assign_get_submission_status': return { lastattempt: {
        caneditowner: true, extensionduedate: now + 10000,
        submission: { status: args.assignid === 106 ? 'submitted' : 'draft' },
      } };
      case 'mod_quiz_get_quiz_access_information': return { canattempt: true, preventaccessreasons: [] };
      case 'mod_quiz_get_user_attempts': return { attempts: args.quizid === 110 ? [{ state: 'finished' }] : [] };
      default: throw new Error('Unexpected call: ' + method);
    }
  }, now);
  assert.deepEqual(data.warnings, []);
  assert.deepEqual(new Set(data.activities.map(a => a.title)), new Set([
    'Problem set', 'Lab quiz', 'Extended assignment', 'Review the readings', 'Practice quiz',
  ]));
  assert.equal(data.activities.find(a => a.title === 'Problem set').description, 'Read chapter 3.');
  assert.match(data.activities.find(a => a.title === 'Problem set').status, /Overdue/);
  assert.equal(data.activities.find(a => a.title === 'Extended assignment').deadline,
    new Date((now + 10000) * 1000).toISOString());
  assert.equal(data.activities.find(a => a.title === 'Practice quiz').deadline, null);
  assert.deepEqual(calls.filter(([method]) => method === 'core_calendar_get_action_events_by_timesort')
    .map(([, args]) => args.aftereventid), [0, 3, 5]);
});

test('Moodle errors omit raw server messages and tokens', async () => {
  const call = client(site, async (url, options) => {
    assert.equal(url.origin, new URL(site.base).origin);
    assert.equal(url.pathname, '/learning/webservice/rest/server.php');
    assert.equal(url.search, '');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('wstoken'), site.token);
    return Response.json({ exception: 'invalid', errorcode: 'invalidtoken', message: site.token });
  });
  await assert.rejects(call('core_webservice_get_site_info'), error =>
    error.message.includes('invalidtoken') && !error.message.includes(site.token));
});

test('an inaccessible exam site marks digest as partial; Berlin deadlines are displayed', async () => {
  const data = await collect([site, exam], async s => {
    if (s === exam) throw new Error('access denied');
    return { warnings: [], activities: [{
      title: 'Homework', type: 'Assignment', course: 'Physics', site: site.name,
      deadline: '2026-11-11T08:30:00.000Z', status: 'Open', link: site.base,
    }] };
  });
  const digest = renderDigest(data, 'Europe/Berlin');
  assert.match(digest, /PARTIAL CHECK/);
  assert.match(digest, /Moodle Exam \(exams\.example\.edu\): access denied/);
  assert.match(digest, /Deadline: 11 Nov 2026, 09:30/);
});

test('MCP client discovers a read-only tool and gets a useful missing-token error', async t => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('./server.mjs', import.meta.url).pathname],
    env: { MOODLE_TOKEN: '', MOODLE_EXAM_TOKEN: '' },
  });
  const mcp = new Client({ name: 'connector-test', version: '1.0.0' });
  t.after(() => mcp.close());
  await mcp.connect(transport);
  const { tools } = await mcp.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  const result = await mcp.callTool({ name: 'list_open_moodle_activities', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /MOODLE_TOKEN/);
});

test('site configuration requires HTTPS and keeps optional exam credentials separate', () => {
  assert.equal(site.base, 'https://moodle.example.edu/learning/');
  assert.equal(exam.isExam, true);
  assert.notEqual(exam.token, site.token);
  for (const url of ['http://moodle.example.edu/', 'https://secret@moodle.example.edu/', 'https://moodle.example.edu/?x=1']) {
    assert.throws(() => configuredSites({ MOODLE_URL: url, MOODLE_TOKEN: 'example' }), /must be an HTTPS/);
  }
});
