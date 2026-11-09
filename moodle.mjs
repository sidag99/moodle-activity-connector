import { convert } from 'html-to-text';

const names = {
  assign: 'Assignment', quiz: 'Quiz', forum: 'Forum', lesson: 'Lesson',
  workshop: 'Workshop', feedback: 'Feedback', choice: 'Choice', lti: 'External activity',
};
const truth = value => [true, 1, '1'].includes(value);
const instant = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= 253402300799 ? n : null;
};
const iso = value => instant(value) ? new Date(Number(value) * 1000).toISOString() : null;
const clean = (input, limit = 500) => convert(String(input ?? '').slice(0, 20000), {
  wordwrap: false, selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
  ],
}).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, limit);

const array = (value, label) => {
  if (!Array.isArray(value)) throw new Error(label + ' returned an unexpected response');
  return value;
};

function siteConfig(url, token, isExam = false) {
  const field = isExam ? 'MOODLE_EXAM_URL' : 'MOODLE_URL';
  let base;
  try { base = new URL(url?.trim()); } catch { throw new Error('Set ' + field + ' to the Moodle home URL in .env.'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error(field + ' must be an HTTPS Moodle home URL without credentials, query or fragment.');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return { name: (isExam ? 'Moodle Exam' : 'Moodle') + ' (' + base.host + ')',
    base: base.href, token: token.trim(), isExam };
}

export function configuredSites(env = process.env) {
  if (!env.MOODLE_TOKEN?.trim()) throw new Error('Set MOODLE_TOKEN in the private .env file first.');
  const sites = [siteConfig(env.MOODLE_URL, env.MOODLE_TOKEN)];
  if (env.MOODLE_EXAM_TOKEN?.trim()) {
    sites.push(siteConfig(env.MOODLE_EXAM_URL, env.MOODLE_EXAM_TOKEN, true));
  }
  return sites;
}

export function client(site, fetcher = fetch) {
  return async (method, args = {}) => {
    let response;
    try {
      response = await fetcher(new URL('webservice/rest/server.php', site.base), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        body: new URLSearchParams({
          ...args, wstoken: site.token, wsfunction: method, moodlewsrestformat: 'json',
        }),
      });
    } catch {
      throw new Error(method + ': Moodle could not be reached (connection failed or timed out)');
    }
    if (!response.ok) throw new Error(method + ': Moodle returned HTTP ' + response.status);
    let result;
    try { result = await response.json(); }
    catch { throw new Error(method + ': Moodle returned non-JSON data; verify web services access'); }
    if (result?.exception || result?.errorcode) {
      const code = /^[a-z_]{1,60}$/i.test(result.errorcode ?? '') ? result.errorcode : 'api_error';
      throw new Error(method + ': ' + code);
    }
    if (!result || typeof result !== 'object') throw new Error(method + ': invalid Moodle response');
    return result;
  };
}

const typeOf = event => event.modulename || event.component?.replace(/^mod_/, '') || '';
const key = id => 'cm:' + Number(id);
const dateOf = (m, ids) => (m?.dates ?? []).filter(d => ids.includes(d.dataid))
  .map(d => instant(d.timestamp)).filter(Boolean).sort((a,b) => a - b)[0] ?? null;
const dueIds = ['duedate', 'timeclose', 'closedate', 'cutoffdate', 'submissionend', 'assessmentend'];
const dueEvents = new Set(['due', 'close', 'cutoff', 'expectcompletion', 'submissionend', 'assessmentend', 'end', 'gradingdue']);
const openEvents = new Set(['open', 'start', 'submissionstart', 'assessmentstart', 'allowsubmissionsfromdate']);
const openIds = ['timeopen', 'allowsubmissionsfromdate', 'opendate', 'submissionstart', 'assessmentstart'];

function safeLink(base, candidate) {
  try {
    const url = new URL(candidate, base);
    if (url.origin === new URL(base).origin && !url.username && !url.password) {
      for (const name of [...url.searchParams.keys()]) {
        if (/token|sesskey|password/i.test(name)) url.searchParams.delete(name);
      }
      return url.href;
    }
  } catch { /* Use the Moodle base URL instead. */ }
  return base;
}

function row(site, { type, course, title, details, url, due, when, action, status, source }) {
  return {
    site: site.name, course: clean(course, 180), type: site.isExam && type === 'quiz' ? 'Exam quiz' : names[type] || clean(type, 48) || 'Activity',
    title: clean(title, 200), description: clean(details), action: clean(action, 100),
    status, deadline: iso(due), eventTime: iso(when), link: safeLink(site.base, url), source,
  };
}

async function timeline(call) {
  const events = [];
  const cursors = new Set();
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    const page = await call('core_calendar_get_action_events_by_timesort', {
      timesortfrom: 0, aftereventid: cursor, limitnum: 50, limittononsuspendedevents: 1,
    });
    const items = array(page.events, 'Moodle Timeline');
    if (!items.length) return events;
    events.push(...items);
    cursor = Number(page.lastid || items.at(-1)?.id);
    if (!cursor || cursors.has(cursor)) throw new Error('Moodle Timeline pagination stalled');
    cursors.add(cursor);
  }
  throw new Error('Moodle Timeline exceeded the pagination safety limit');
}

async function eachLimit(items, fn, n = 5) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export async function scanSite(site, call = client(site), now = Math.floor(Date.now() / 1000)) {
  const warnings = new Set();
  const capture = async (label, fn) => {
    try { return await fn(); }
    catch (err) { warnings.add(site.name + ' — ' + label + ': ' + err.message); return null; }
  };
  const info = await call('core_webservice_get_site_info');
  if (!Number(info.userid)) throw new Error('Moodle did not return an authenticated account');
  const funcs = Array.isArray(info.functions) ? new Set(info.functions.map(f => f.name)) : null;
  const [events, courses] = await Promise.all([
    capture('Timeline', () => timeline(call)),
    capture('Course list', async () => array(await call('core_enrol_get_users_courses', { userid: info.userid, returnusercount: 0 }), 'Course list')),
  ]);
  if (!events && !courses) throw new Error([...warnings].join('; '));
  const byModule = new Map();
  await eachLimit(courses ?? [], course => capture('Course ' + Number(course.id), async () => {
    const sections = array(await call('core_course_get_contents', {
      courseid: course.id, 'options[0][name]': 'excludecontents', 'options[0][value]': 1,
    }), 'Course contents');
    for (const section of sections) {
      for (const m of section.modules ?? []) {
        if (Number(m.id)) byModule.set(key(m.id), { m, course });
      }
    }
  }));

  // Let Moodle apply student-specific dates, access and completion in its Timeline.
  const grouped = new Map();
  for (const e of events ?? []) {
    const type = typeOf(e);
    // The calendar exporter calls this field instance, but it is a course module ID.
    const id = type && Number(e.instance) ? key(e.instance) : 'event:' + e.id;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(e);
  }
  const activities = [];
  for (const [id, related] of grouped) {
    const active = related.filter(e => truth(e.action?.actionable) && !['gradingdue', 'grading'].includes(e.eventtype));
    if (!active.length) continue;
    const { m, course } = byModule.get(id) ?? {};
    const preferred = active.find(e => dueEvents.has(e.eventtype)) ?? active.find(e => !openEvents.has(e.eventtype)) ?? active[0];
    const type = typeOf(preferred);
    const due = active.filter(e => dueEvents.has(e.eventtype) && e.eventtype !== 'gradingdue')
      .map(e => instant(e.timestart)).filter(Boolean).sort((a,b) => a - b)[0] ?? dateOf(m, dueIds);
    if (type === 'quiz' && due && due <= now) continue;
    activities.push(row(site, {
      type, due, when: !due && !openEvents.has(preferred.eventtype) ? preferred.timestart : null,
      course: course?.fullname ?? preferred.course?.fullname ?? preferred.course?.shortname,
      title: m?.name ?? preferred.activityname ?? preferred.name,
      details: m?.description || preferred.description,
      url: m?.url ?? preferred.url ?? preferred.action?.url,
      action: preferred.action?.name, status: due && due <= now ? 'Overdue; still actionable' : 'Open',
      source: 'Moodle Timeline',
    }));
  }

  // Without a Timeline event, only add work that has independent evidence of being open.
  await eachLimit([...byModule], async ([id, { m, course }]) => {
    if (grouped.has(id) || !truth(m.uservisible) || !m.url || Number(m.completiondata?.state) > 0) return;
    const type = m.modname;
    if (['label', 'subsection'].includes(type) || (dateOf(m, openIds) ?? 0) > now) return;
    let due = dateOf(m, dueIds);
    let source;
    if (type === 'assign') {
      const method = 'mod_assign_get_submission_status';
      if (funcs && !funcs.has(method)) {
        warnings.add(site.name + ' — Assignments outside Timeline could not be checked: submission status is not enabled.');
        return;
      }
      const status = await capture('Assignment ' + m.id, () => call(method, { assignid: m.instance }));
      const a = status?.lastattempt;
      if (!a || !truth(a.caneditowner) || a.submission?.status === 'submitted') return;
      if (a.teamsubmission?.status === 'submitted' &&
          !(a.submissiongroupmemberswhoneedtosubmit ?? []).map(Number).includes(Number(info.userid))) return;
      due = instant(a.extensionduedate) ?? due;
      source = 'Moodle submission status';
    } else if (type === 'quiz') {
      // Dated quizzes use Timeline so course-wide dates cannot override personal dates.
      if (!events || due || dateOf(m, openIds)) return;
      const accessMethod = 'mod_quiz_get_quiz_access_information';
      const attemptsMethod = 'mod_quiz_get_user_attempts';
      if (funcs && (!funcs.has(accessMethod) || !funcs.has(attemptsMethod))) {
        warnings.add(site.name + ' — Quizzes outside Timeline could not be checked: quiz access or attempt status is not enabled.');
        return;
      }
      const access = await capture('Quiz ' + m.id, () => call(accessMethod, { quizid: m.instance }));
      if (!truth(access?.canattempt) || !Array.isArray(access.preventaccessreasons) ||
          access.preventaccessreasons.length) return;
      const attempts = await capture('Quiz ' + m.id, async () => array(
        (await call(attemptsMethod, { quizid: m.instance, status: 'all' })).attempts, 'Quiz attempts'));
      if (!attempts || attempts.some(a => ['finished', 'abandoned'].includes(a.state))) return;
      source = 'Moodle quiz access and attempt status';
    } else {
      // Completion tracking is a signal of unfinished work, not proof of a deadline.
      if (!events || !Number(m.completion) || m.completiondata?.state == null ||
          Number(m.completiondata.state) !== 0 || (m.dates ?? []).length) return;
      source = 'Moodle activity completion';
    }
    activities.push(row(site, {
      type, course: course.fullname, title: m.name, details: m.description, url: m.url, due,
      status: due && due <= now ? 'Overdue; still actionable' :
        source === 'Moodle activity completion' ? 'Incomplete; availability from course page' : 'Open',
      source,
    }));
  });

  return { activities, warnings: [...warnings].sort() };
}

export async function collect(sites = configuredSites(), scan = scanSite) {
  const results = await Promise.allSettled(sites.map(site => scan(site)));
  const activities = [], warnings = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      activities.push(...result.value.activities);
      warnings.push(...result.value.warnings);
    } else {
      warnings.push(sites[i].name + ': ' + result.reason.message);
    }
  }
  if (results.every(result => result.status === 'rejected')) throw new Error(warnings.join('; '));
  activities.sort((a,b) =>
    (a.deadline ?? a.eventTime ?? 'Z').localeCompare(b.deadline ?? b.eventTime ?? 'Z') ||
    a.course.localeCompare(b.course) || a.title.localeCompare(b.title));
  return { checkedAt: new Date().toISOString(), sites: sites.map(s => s.name), activities, warnings };
}
