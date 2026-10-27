const brevo = require('./brevoMailService');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, '../templates/email');
const SITE_URL = (process.env.SITE_URL || 'https://starbook.com').replace(/\/+$/, '');


async function sendTransactional({ to, toName, subject, html, replyTo }) {
  const apiSent = await brevo.send({ to, toName, subject, html, replyTo });
  if (apiSent) return true;

  const host = process.env.SMTP_HOST || 'smtp-relay.brevo.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.BREVO_SENDER_EMAIL || '';
  if (!host || !user || !pass || !fromEmail) {
    console.error('[Email] API send failed and SMTP fallback is not fully configured.');
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      host, port, secure: port === 465,
      auth: { user, pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
    });
    await transporter.sendMail({
      from: { name: process.env.SMTP_FROM_NAME || process.env.BREVO_SENDER_NAME || 'StarBook', address: fromEmail },
      to: toName ? { name: toName, address: to } : to,
      subject, html, ...(replyTo ? { replyTo } : {})
    });
    console.log(`[SMTP fallback] sent transactional email: ${subject}`);
    return true;
  } catch (error) {
    console.error('[SMTP fallback] Transactional email failed:', error.message);
    return false;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadTemplate(name, vars = {}) {
  const file = path.join(TEMPLATE_DIR, `${name}.html`);
  if (!fs.existsSync(file)) throw new Error(`Required email template is missing: ${name}`);
  let html = fs.readFileSync(file, 'utf8');
  const merged = { year: String(new Date().getFullYear()), ...vars };
  Object.entries(merged).forEach(([key, value]) => {
    html = html.split(`{{${key}}}`).join(escapeHtml(value));
  });
  return html;
}

async function sendBookingApproved({ user, booking }) {
  const html = loadTemplate('booking-approved', {
    userName: user.fullName || user.username || 'StarBook member',
    celebName: booking.celebrityName || 'your selected celebrity',
    eventType: booking.eventType || 'Celebrity booking',
    eventDate: booking.eventDate || 'To be confirmed',
    bookingId: booking.id || booking._id || '',
    dashboardUrl: `${SITE_URL}/dashboard.html`
  });
  return sendTransactional({
    to: user.email,
    toName: user.fullName || user.username || user.email,
    subject: `Your ${booking.celebrityName || 'StarBook'} booking is confirmed`,
    html
  });
}

async function sendFanCardDelivered({ user, fanCard }) {
  const cardImageUrl = fanCard.adminCardUrl
    ? new URL(fanCard.adminCardUrl, `${SITE_URL}/`).toString()
    : `${SITE_URL}/dashboard.html`;
  const html = loadTemplate('fancard-delivered', {
    userName: user.fullName || user.username || 'StarBook member',
    celebName: fanCard.celebrityName || fanCard.celebName || 'your selected celebrity',
    tier: fanCard.membershipLevel || fanCard.tier || 'Fan',
    fanId: fanCard.fanId || '',
    serialNumber: fanCard.serialNumber || 'Not assigned',
    cardImageUrl,
    dashboardUrl: `${SITE_URL}/dashboard.html`
  });
  return sendTransactional({
    to: user.email,
    toName: user.fullName || user.username || user.email,
    subject: `Your physical ${fanCard.membershipLevel || fanCard.tier || ''} Fan Card is ready`,
    html
  });
}

async function sendRegistrationVerification({ email, fullName, code, expiresMinutes }) {
  const html = loadTemplate('verification-code', {
    fullName: fullName || 'StarBook member',
    code,
    expiresMinutes
  });
  return sendTransactional({
    to: email,
    toName: fullName,
    subject: 'Verify your StarBook email address',
    html
  });
}

async function sendPasswordResetCode({ email, fullName, code, expiresMinutes }) {
  const name = escapeHtml(fullName || 'StarBook member');
  const html = `<p>Hi ${name},</p><p>Use this one-time code to reset your StarBook password:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${escapeHtml(code)}</p><p>This code expires in ${escapeHtml(expiresMinutes)} minutes. If you did not request a reset, you can ignore this email.</p>`;
  return sendTransactional({
    to: email,
    toName: fullName,
    subject: 'Your StarBook password reset code',
    html
  });
}

async function sendWelcome({ user }) {
  const name = escapeHtml(user.fullName || user.username || 'StarBook member');
  const html = `<p>Hi ${name},</p><p>Welcome to StarBook! Your account is ready. You can manage bookings and fan cards from your dashboard.</p><p><a href="${escapeHtml(`${SITE_URL}/dashboard.html`)}">Open your dashboard</a></p>`;
  return sendTransactional({
    to: user.email,
    toName: user.fullName || user.username || user.email,
    subject: 'Welcome to StarBook',
    html
  });
}

module.exports = {
  sendBookingApproved,
  sendFanCardDelivered,
  sendRegistrationVerification,
  sendPasswordResetCode,
  sendWelcome
};
