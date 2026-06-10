'use strict';

/**
 * Unit tests for emailService (Amazon SES via SMTP / nodemailer).
 * nodemailer is mocked — no network. Each case loads emailService in an isolated
 * module registry with a controlled env + transport so the load-time env capture
 * is deterministic.
 */

const CONFIGURED = {
  SMTP_HOST:      'email-smtp.us-east-1.amazonaws.com',
  SMTP_PORT:      '587',
  SMTP_SECURE:    'false',
  SMTP_USER:      'AKIAEXAMPLEUSER',
  SMTP_PASS:      'ses-smtp-password',
  EMAIL_FROM:     'notifications@advantage.bid',
  EMAIL_REPLY_TO: 'info@advantage.bid',
};
// Empty strings (present-but-falsy) so dotenv.config() won't repopulate from a
// local .env — keeps the "unconfigured" case hermetic.
const UNCONFIGURED = { SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '' };

function loadEmailService(env, sendMailImpl) {
  let svc, sendMail, createTransport;
  const saved = process.env;
  process.env = { ...saved, ...env };
  jest.isolateModules(() => {
    jest.doMock('nodemailer', () => {
      sendMail = sendMailImpl || jest.fn().mockResolvedValue({ messageId: 'msg-123' });
      createTransport = jest.fn(() => ({ sendMail }));
      return { createTransport };
    });
    svc = require('../src/services/emailService');
  });
  process.env = saved;
  return { svc, sendMail, createTransport };
}

describe('emailService — SES SMTP (nodemailer)', () => {
  test('skip-safe: returns { skipped:true } and does not send when unconfigured', async () => {
    const { svc, sendMail } = loadEmailService(UNCONFIGURED);
    const res = await svc.sendEmail({ to: 'x@example.com', subject: 'Hi', html: '<p>Hi</p>' });
    expect(res).toEqual({ skipped: true });
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('configured: maps fields to nodemailer and returns { messageId }', async () => {
    const { svc, sendMail } = loadEmailService(CONFIGURED);
    const res = await svc.sendEmail({
      to: 'buyer@example.com', subject: 'You were outbid', html: '<p>Outbid</p>', text: 'Outbid',
    });
    expect(res).toEqual({ messageId: 'msg-123' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      from:    'notifications@advantage.bid',
      to:      'buyer@example.com',
      subject: 'You were outbid',
      html:    '<p>Outbid</p>',
      text:    'Outbid',
      replyTo: 'info@advantage.bid',
    });
  });

  test('omits text when not provided', async () => {
    const { svc, sendMail } = loadEmailService(CONFIGURED);
    await svc.sendEmail({ to: 'a@b.com', subject: 'S', html: '<p>h</p>' });
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty('text');
  });

  test('rethrows on transport failure and exposes statusCode from responseCode', async () => {
    const failing = jest.fn().mockRejectedValue(Object.assign(new Error('554 message rejected'), { responseCode: 554 }));
    const { svc } = loadEmailService(CONFIGURED, failing);
    await expect(svc.sendEmail({ to: 'a@b.com', subject: 'S', html: '<p>h</p>' }))
      .rejects.toMatchObject({ message: expect.stringContaining('554'), statusCode: 554 });
  });

  test('builds the SES transport with host/port 587/STARTTLS/auth', async () => {
    const { svc, createTransport } = loadEmailService(CONFIGURED);
    await svc.sendEmail({ to: 'a@b.com', subject: 'S', html: '<p>h</p>' });
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0][0]).toMatchObject({
      host:   'email-smtp.us-east-1.amazonaws.com',
      port:   587,
      secure: false,
      auth:   { user: 'AKIAEXAMPLEUSER', pass: 'ses-smtp-password' },
    });
  });
});
