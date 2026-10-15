'use strict';

/**
 * Mail delivery over a REAL SMTP conversation (security audit 2026-10-15: nodemailer 8 → 10 upgrade). A local SMTP sink
 * on 127.0.0.1 receives what the platform would send to Amazon SES, so nothing leaves the machine. Covers the shapes the
 * platform uses: plain transactional mail (verification / Sasha replies / notifications), HTML + text, a PDF
 * attachment (invoices, seller reports), custom headers (List-Unsubscribe), reply-to, bcc, display-name senders, the SES
 * message id read from the 250 reply, the separate marketing pool, and the close-email transport.
 */

const net = require('net');

const messages = [];
let sink, port;
function startSink() {
  return new Promise((resolve) => {
    sink = net.createServer((sock) => {
      let buf = '', inData = false, cur = null, authStep = 0;
      const send = (l) => sock.write(l + '\r\n');
      send('220 sink ESMTP');
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = inData ? buf.indexOf('\r\n.\r\n') : buf.indexOf('\r\n')) !== -1) {
          if (inData) {
            cur.data = buf.slice(0, i); buf = buf.slice(i + 5); inData = false; messages.push(cur);
            send('250 Ok 0100019a-ses-test-' + messages.length); continue;
          }
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (authStep === 1) { authStep = 2; send('334 UGFzc3dvcmQ6'); continue; }
          if (authStep === 2) { authStep = 0; send('235 Authentication successful'); continue; }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') { sock.write('250-sink\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n'); }
          else if (cmd === 'AUTH') { if (/^AUTH LOGIN/i.test(line)) { authStep = 1; send('334 VXNlcm5hbWU6'); } else send('235 Authentication successful'); }
          else if (cmd === 'MAIL') { cur = { from: line, rcpt: [] }; send('250 Ok'); }
          else if (cmd === 'RCPT') { cur.rcpt.push(line); send('250 Ok'); }
          else if (cmd === 'DATA') { inData = true; send('354 End data with <CR><LF>.<CR><LF>'); }
          else if (cmd === 'RSET' || cmd === 'NOOP') send('250 Ok');
          else if (cmd === 'QUIT') { send('221 Bye'); sock.end(); }
          else send('250 Ok');
        }
      });
      sock.on('error', () => {});
    }).listen(0, '127.0.0.1', () => { port = sink.address().port; resolve(); });
  });
}

let emailService;
beforeAll(async () => {
  await startSink();
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'test-user', SMTP_PASS: 'test-pass', SMTP_SECURE: 'false',
    EMAIL_FROM: 'notifications@advantage.bid' });
  jest.resetModules();
  emailService = require('../src/services/emailService');
});
afterAll(() => { try { emailService._closeTransports && emailService._closeTransports(); } catch (_) { /* */ } sink.close(); });
beforeEach(() => { messages.length = 0; });

test('the installed nodemailer is a patched 10.x release', () => {
  const v = require('nodemailer/package.json').version;
  expect(v).toMatch(/^10\./);
  const [, minor, patch] = v.split('.').map(Number);
  expect(minor > 0 || patch >= 6).toBe(true);   // every advisory against <= 10.0.5 is fixed
});

test('transactional mail (verification, Sasha reply, notification): HTML + text, reply-to, display name, SES id', async () => {
  const r = await emailService.sendEmail({ to: 'buyer@example.com', subject: 'Confirm your email — Advantage.Bid', html: '<p>Hello <b>there</b></p>',
    text: 'Hello there', replyTo: 'info@advantage.bid', fromName: 'Sasha — Advantage.Bid' });
  expect(r.sesMessageId).toBe('0100019a-ses-test-1');
  const m = messages[0];
  expect(m.from).toMatch(/<notifications@advantage\.bid>/);
  expect(m.rcpt).toEqual(['RCPT TO:<buyer@example.com>']);
  expect(m.data).toMatch(/^From: "?Sasha — Advantage\.Bid"? <notifications@advantage\.bid>|From: =\?UTF-8\?/m);
  expect(m.data).toMatch(/^Reply-To: info@advantage\.bid/m);
  expect(m.data).toMatch(/Content-Type: multipart\/alternative/);
  expect(m.data).toMatch(/Hello there/);
});

test('invoice / report mail with a PDF attachment, bcc and List-Unsubscribe headers', async () => {
  const pdf = Buffer.from('%PDF-1.4\n% test\n');
  await emailService.sendEmail({ to: 'seller@example.com', bcc: 'records@advantage.bid', subject: 'Invoice AAC-000123', html: '<p>Invoice</p>', text: 'Invoice',
    attachments: [{ filename: 'invoice-AAC-000123.pdf', content: pdf, contentType: 'application/pdf' }],
    headers: { 'List-Unsubscribe': '<https://bid.advantage.bid/u/x>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
  const m = messages[0];
  expect(m.rcpt.sort()).toEqual(['RCPT TO:<records@advantage.bid>', 'RCPT TO:<seller@example.com>']);
  expect(m.data).not.toMatch(/^Bcc:/m);
  expect(m.data).toMatch(/^List-Unsubscribe: <https:\/\/bid\.advantage\.bid\/u\/x>/m);
  expect(m.data).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
  expect(m.data).toMatch(/filename="?invoice-AAC-000123\.pdf"?/);
  expect(m.data).toContain(pdf.toString('base64').trim());
});

test('a header value carrying CR/LF cannot inject another header', async () => {
  await emailService.sendEmail({ to: 'a@example.com', subject: 'Hi\r\nBcc: victim@example.com', html: '<p>x</p>', text: 'x' });
  const m = messages[0];
  expect(m.rcpt).toEqual(['RCPT TO:<a@example.com>']);
  expect(m.data).not.toMatch(/^Bcc: victim@example\.com/m);
});

test('the marketing stream uses its own pool and still delivers', async () => {
  await emailService.sendEmail({ to: 'sub@example.com', subject: 'Sales near you', html: '<p>x</p>', text: 'x', mailStream: 'marketing' });
  expect(messages).toHaveLength(1);
});

test('the auction-close email transport (separate module) delivers over the same SMTP settings', async () => {
  jest.doMock('../src/db', () => ({ query: jest.fn(async (sql) => {
    if (/AS gross_total_cents/.test(sql)) return { rows: [{ title: 'Estate', id: 'a1', seller_email: 'seller@example.com', gross_total_cents: 100 }] };
    if (/AS paddle_number/.test(sql)) return { rows: [] };
    if (/unpaid_count/.test(sql)) return { rows: [{ unpaid_count: 0 }] };
    return { rows: [] };
  }) }));
  const svc = require('../src/services/operationalCloseEmailService');
  await svc.sendOperationalCloseEmail('a1');
  expect(messages[0].rcpt).toEqual(['RCPT TO:<seller@example.com>']);
  expect(messages[0].data).toMatch(/Auction Closed: Estate/);
});
