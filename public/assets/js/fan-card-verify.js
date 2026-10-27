(() => {
  const root = document.getElementById('fanCardVerification');
  if (!root) return;

  const reference = new URLSearchParams(window.location.search).get('ref') || '';
  const cardIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const displayDate = value => {
    if (!value) return 'Not available';
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
    return Number.isNaN(date.getTime())
      ? 'Not available'
      : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  };
  const cardState = card => {
    const status = String(card.status || '').toLowerCase();
    if (status === 'pending') return { label: 'Pending review', className: 'fan-verify__status--pending' };
    if (status === 'rejected') return { label: 'Rejected', className: 'fan-verify__status--rejected' };
    if (status === 'approved' && card.expiryDate) {
      const expiry = new Date(/^\d{4}-\d{2}-\d{2}$/.test(card.expiryDate) ? `${card.expiryDate}T23:59:59` : card.expiryDate);
      if (!Number.isNaN(expiry.getTime()) && expiry.getTime() < Date.now())
        return { label: 'Expired', className: 'fan-verify__status--rejected' };
    }
    if (status === 'approved') return { label: 'Active', className: 'fan-verify__status--active' };
    return { label: status || 'Unknown', className: 'fan-verify__status--rejected' };
  };
  const renderError = message => {
    root.innerHTML = `<section class="fan-verify__panel" role="alert"><h1>Card could not be verified</h1><p>${escapeHTML(message)}</p></section>`;
  };

  async function verify() {
    if (!cardIdPattern.test(reference)) {
      renderError('This verification link is missing a valid card reference.');
      return;
    }
    try {
      const response = await fetch(`/api/fancards/verify/${encodeURIComponent(reference)}`, { cache: 'no-store' });
      const card = await response.json();
      if (!response.ok) throw new Error(card.message || 'No matching membership was found.');
      const status = cardState(card);
      root.innerHTML = `
        <section class="fan-verify__panel" aria-labelledby="fanVerifyTitle">
          <p class="fan-verify__eyebrow">STARBOOK · MEMBERSHIP CHECK</p>
          <div class="fan-verify__status ${status.className}" role="status">${escapeHTML(status.label)}</div>
          <h1 id="fanVerifyTitle">${escapeHTML(card.celebrityName || 'Fan membership')}</h1>
          <p class="fan-verify__intro">This page shows the current membership details returned by StarBook. Status may change after review or expiry.</p>
          <div id="fanVerifyCard" class="fan-verify__card"></div>
          <dl class="fan-verify__details">
            <div><dt>Cardholder</dt><dd>${escapeHTML(card.holderName || 'StarBook Member')}</dd></div>
            <div><dt>Membership tier</dt><dd>${escapeHTML(card.membershipLevel || 'Silver')}</dd></div>
            <div><dt>Fan ID</dt><dd>${escapeHTML(card.fanId || 'Not assigned')}</dd></div>
            ${card.serialNumber ? `<div><dt>Serial number</dt><dd>${escapeHTML(card.serialNumber)}</dd></div>` : ''}
            <div><dt>Applied</dt><dd>${escapeHTML(displayDate(card.createdAt))}</dd></div>
            <div><dt>Approved</dt><dd>${escapeHTML(displayDate(card.approvedAt))}</dd></div>
            <div><dt>Expires</dt><dd>${escapeHTML(displayDate(card.expiryDate))}</dd></div>
          </dl>
          <p class="fan-verify__privacy">Only membership details are shown here. Account contact details and payment information are not included.</p>
        </section>`;
      FanCardTemplates.mount(document.getElementById('fanVerifyCard'), {
        id: reference,
        celebrityName: card.celebrityName,
        fanName: card.holderName,
        cardNumber: card.fanId || 'Fan ID not assigned',
        tierLabel: card.membershipLevel || 'Silver',
        status: card.status,
        issueDate: card.approvedAt ? displayDate(card.approvedAt) : '',
        expiryDate: card.expiryDate ? displayDate(card.expiryDate) : ''
      }, String(card.membershipLevel || 'silver').toLowerCase());
    } catch (error) {
      renderError(error.message || 'Could not reach the membership verification service.');
    }
  }

  verify();
})();
