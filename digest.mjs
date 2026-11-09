import { mkdir, open, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import nodemailer from 'nodemailer';
import { collect } from './moodle.mjs';

export function renderDigest(data, zone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: zone,
  });
  const time = date => fmt.format(new Date(date)) + ' (' + zone + ')';
  const lines = [
    'Moodle activity digest — checked ' + time(data.checkedAt),
    'Sites: ' + data.sites.join(', '),
    '',
  ];
  if (data.warnings.length) lines.push('PARTIAL CHECK — some activities may be missing.', ...data.warnings, '');
  if (!data.activities.length) lines.push('No active activities found in the data checked.');
  for (const a of data.activities) {
    lines.push(a.title + ' — ' + a.type, [a.course, a.site].filter(Boolean).join(' | '),
      a.deadline ? 'Deadline: ' + time(a.deadline) : 'Deadline: none listed',
      ...(a.eventTime ? ['Scheduled: ' + time(a.eventTime)] : []),
      [a.status, a.action].filter(Boolean).join(' — '),
      ...(a.description ? [a.description] : []), a.link, '');
  }
  return lines.join('\n');
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--preview', '--send'].includes(args[0]))) {
    throw new Error('Use --preview or --send.');
  }
  const data = await collect();
  const zone = process.env.DIGEST_TIMEZONE || 'Europe/Berlin';
  const body = renderDigest(data, zone);
  if (args[0] !== '--send') { console.log(body); return; }
  if (!data.activities.length) {
    if (data.warnings.length) throw new Error('No email sent because the check was partial and found no activities. ' + data.warnings.join('; '));
    console.log('No active activities. No email sent.');
    return;
  }
  const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM, MAIL_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD ||
      ![MAIL_FROM, MAIL_TO].every(v => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(v ?? ''))) {
    throw new Error('Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM and a single MAIL_TO address in .env.');
  }
  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP_PORT.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(data.checkedAt));
  const day = ['year', 'month', 'day'].map(k => parts.find(p => p.type === k).value).join('-');
  const state = new URL('./.digest-state/', import.meta.url);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const receipt = new URL(day, state);
  let lock;
  try { lock = await open(receipt, 'wx', 0o600); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    console.log('A send for ' + day + ' was already recorded or is in progress.');
    return;
  }
  let smtpAccepted = false;
  try {
    const transport = nodemailer.createTransport({
      host: SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000,
      disableFileAccess: true, disableUrlAccess: true,
    });
    const info = await transport.sendMail({
      from: MAIL_FROM, to: MAIL_TO,
      subject: (data.warnings.length ? '[Partial] ' : '') +
        'Moodle: ' + data.activities.length + ' active ' +
        (data.activities.length === 1 ? 'activity' : 'activities') + ' — ' + day,
      text: body,
    });
    if (!info.accepted?.length) throw new Error('No recipient accepted');
    smtpAccepted = true;
    await lock.writeFile('sent\n');
    console.log('Moodle digest accepted by the mail server for ' + day + '.');
  } catch (err) {
    if (!smtpAccepted) {
      await unlink(receipt);
      const code = /^[A-Z0-9_]{1,30}$/.test(err.code ?? '') ? ' (' + err.code + ')' : '';
      throw new Error('Email delivery failed' + code + '. Check the SMTP settings and mail provider.');
    }
    throw new Error('The mail server accepted the digest, but the local receipt could not be written.');
  } finally { await lock.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(err => { console.error(err.message); process.exitCode = 1; });
}
