(function (root, createPolicy) {
  const policy = createPolicy();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.StarBookEmailPolicy = policy;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const approvedDomains = new Set([
    'gmail.com',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'yahoo.com', 'ymail.com', 'att.net', 'rogers.com', 'shaw.ca',
    'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'aim.com',
    'proton.me', 'protonmail.com',
    'zoho.com',
    'gmx.com', 'gmx.de'
  ]);
  const approvedDomainsLabel = [...approvedDomains].join(', ');
  const unsupportedMessage = 'This email provider is not supported.';

  function validate(value) {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!email || !email.includes('@'))
      return { valid: false, complete: false, message: 'Enter a complete email address.' };

    const match = /^[^\s@]+@([a-z0-9.-]+)$/.exec(email);
    if (!match)
      return { valid: false, complete: false, message: 'Enter a complete email address.' };
    if (!approvedDomains.has(match[1]))
      return { valid: false, complete: true, message: unsupportedMessage };
    return { valid: true, complete: true, message: '' };
  }

  return { approvedDomains, approvedDomainsLabel, validate };
});
