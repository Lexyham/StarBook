let apiInstance = null;
let SendSmtpEmail = null;

function init() {
  if (apiInstance) return true;
  const key = process.env.BREVO_API_KEY;
  if (!key || /your-|<|replace-me|replace-with|example/i.test(key)) return false;
  try {
    const SibApiV3Sdk = require('@getbrevo/brevo');
    SendSmtpEmail = SibApiV3Sdk.SendSmtpEmail;
    apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    apiInstance.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, key);
    return true;
  } catch (error) {
    console.error('[Brevo] Could not initialize the email API:', error.message);
    return false;
  }
}

async function send({ to, toName, subject, html, replyTo }) {
  if (!init()) {
    console.error('[Brevo] API email delivery is unavailable; trying the configured SMTP fallback.');
    return false;
  }
  const senderEmail = process.env.BREVO_SENDER_EMAIL || '';
  if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
    console.error('[Brevo] API email delivery has no valid verified sender; trying the configured SMTP fallback.');
    return false;
  }
  try {
    const email = new SendSmtpEmail();
    email.sender = {
      name: process.env.BREVO_SENDER_NAME || 'StarBook',
      email: senderEmail
    };
    email.to = [{ email: to, name: toName || to }];
    if (replyTo) email.replyTo = { email: replyTo };
    email.subject = subject;
    email.htmlContent = html;
    await apiInstance.sendTransacEmail(email);
    console.log(`[Brevo] sent: ${subject} → ${to}`);
    return true;
  } catch (error) {
    const status = error?.response?.status || error?.status || 'unknown';
    const reason = typeof error?.message === 'string' ? error.message.slice(0, 300) : 'No provider error details';
    console.error(`[Brevo] Transactional email failed (HTTP ${status}): ${reason}; trying SMTP fallback.`);
    return false;
  }
}

module.exports = { send };
