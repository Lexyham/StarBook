(() => {
  const root = document.querySelector('[data-ticket-mode]');
  const code = new URLSearchParams(window.location.search).get('code');
  if (!root) return;

  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const formatDate = value => {
    if (!value) return 'Date to be confirmed';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date to be confirmed'
      : new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
  };
  const renderError = message => {
    root.innerHTML = `<div class="ticket-error" role="alert">${escapeHTML(message)}</div>`;
  };
  const renderFacts = ticket => `
    <div class="ticket-facts">
      <div class="ticket-fact"><span class="ticket-fact-label">Event</span><strong class="ticket-fact-value">${escapeHTML(ticket.eventType || 'Celebrity booking')}</strong></div>
      <div class="ticket-fact"><span class="ticket-fact-label">Date</span><strong class="ticket-fact-value">${escapeHTML(formatDate(ticket.eventDate))}</strong></div>
      ${ticket.eventTime ? `<div class="ticket-fact"><span class="ticket-fact-label">Start time</span><strong class="ticket-fact-value">${escapeHTML(ticket.eventTime)}</strong></div>` : ''}
      ${ticket.recipientName ? `<div class="ticket-fact"><span class="ticket-fact-label">Admit</span><strong class="ticket-fact-value">${escapeHTML(ticket.recipientName)}</strong></div>` : ''}
    </div>`;

  async function loadTicket() {
    if (!code || !/^[a-f0-9]{64}$/i.test(code)) {
      renderError('This event pass link is missing or invalid. Open your booking from the StarBook dashboard for the current pass.');
      return;
    }
    try {
      const response = await fetch(`/api/bookings/verify/${encodeURIComponent(code)}`, { cache: 'no-store' });
      const ticket = await response.json();
      if (!response.ok || ticket.valid !== true) throw new Error(ticket.message || 'This event pass is not valid.');
      if (root.dataset.ticketMode === 'verify') {
        root.innerHTML = `
          <section class="ticket-verify-card">
            <div class="verify-icon" aria-hidden="true">✓</div>
            <span class="ticket-overline">StarBook event security</span>
            <h1 class="ticket-event-title" style="margin-top:12px">Pass verified</h1>
            <p style="color:var(--ticket-muted);line-height:1.6">This event pass is authentic and the booking is confirmed.</p>
            <div class="verify-grid">
              <div class="verify-fact"><span>Celebrity</span><strong>${escapeHTML(ticket.celebrityName)}</strong></div>
              <div class="verify-fact"><span>Event</span><strong>${escapeHTML(ticket.eventType)}</strong></div>
              <div class="verify-fact"><span>Date</span><strong>${escapeHTML(formatDate(ticket.eventDate))}</strong></div>
              <div class="verify-fact"><span>Booking reference</span><strong>${escapeHTML(ticket.bookingReference)}</strong></div>
            </div>
          </section>`;
        return;
      }

      const verifyUrl = `/booking-verify.html?code=${encodeURIComponent(code)}`;
      const qrUrl = `/api/bookings/ticket/${encodeURIComponent(code)}/qr.png`;
      root.innerHTML = `
        <div class="ticket-brand">
          <div><div class="ticket-brand-name">✦ STARBOOK</div><div class="ticket-brand-note">Your confirmed event pass</div></div>
          <div class="ticket-actions">
            <button class="ticket-button" type="button" data-print-ticket>▣ Print / Save PDF</button>
            <button class="ticket-button secondary" type="button" data-download-ticket>↓ Download ticket image</button>
          </div>
        </div>
        <p class="ticket-download-status" data-ticket-download-status role="status" aria-live="polite">To make a PDF, choose “Save as PDF” in the print dialog.</p>
        <article class="ticket-shell">
          <div class="ticket-main">
            <div class="ticket-info">
              <div class="ticket-topline"><span class="ticket-overline">Official celebrity event pass</span><span class="ticket-status">Confirmed</span></div>
              <div><h1 class="ticket-event-title">${escapeHTML(ticket.celebrityName || 'StarBook Celebrity')}</h1><p class="ticket-recipient">${ticket.recipientName ? `Admit one · ${escapeHTML(ticket.recipientName)}` : 'Your StarBook booking is confirmed'}</p></div>
              ${renderFacts(ticket)}
              <div class="ticket-reference">BOOKING REFERENCE<br><strong>${escapeHTML(ticket.bookingReference)}</strong></div>
            </div>
            <aside class="ticket-stub">
              <div class="ticket-qr-frame"><img class="ticket-qr" src="${qrUrl}" alt="QR code to verify this confirmed event pass"></div>
              <strong class="ticket-scan-title">Scan to verify</strong>
              <span class="ticket-scan-copy">This pass is valid only while the booking remains confirmed.</span>
            </aside>
          </div>
        </article>
        <p class="ticket-footer">Keep this pass available for your event. A QR scan verifies the booking status without exposing payment details.</p>`;
      root.querySelector('[data-print-ticket]').addEventListener('click', () => window.print());
      root.querySelector('[data-download-ticket]').addEventListener('click', () => downloadTicketImage(ticket, qrUrl));
    } catch (error) {
      renderError(error.message || 'Could not verify this event pass. Please try again.');
    }
  }

  async function downloadTicketImage(ticket, qrUrl) {
    const button = root.querySelector('[data-download-ticket]');
    const status = root.querySelector('[data-ticket-download-status]');
    button.disabled = true;
    let svgUrl = null;
    let pngUrl = null;
    try {
      const response = await fetch(qrUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load the pass verification code.');
      const qrBlob = await response.blob();
      if (!qrBlob.type.startsWith('image/')) throw new Error('The pass verification code was not an image.');
      const qrBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not prepare the ticket image.'));
        reader.readAsDataURL(qrBlob);
      });
      const xml = value => escapeHTML(value);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#19172a"/><stop offset="1" stop-color="#101421"/></linearGradient><linearGradient id="gold" x2="1"><stop stop-color="#f7d477"/><stop offset="1" stop-color="#d99a32"/></linearGradient></defs><rect width="1200" height="675" rx="36" fill="url(#bg)"/><rect x="2" y="2" width="1196" height="671" rx="34" fill="none" stroke="#b99447" stroke-width="3"/><text x="72" y="86" fill="url(#gold)" font-family="Arial,sans-serif" font-size="30" font-weight="800" letter-spacing="6">✦ STARBOOK</text><rect x="825" y="44" width="300" height="52" rx="26" fill="#17392f" stroke="#4ac994"/><circle cx="857" cy="70" r="8" fill="#5be3a2"/><text x="881" y="78" fill="#81f0bc" font-family="Arial,sans-serif" font-size="20" font-weight="700" letter-spacing="2">CONFIRMED PASS</text><text x="72" y="183" fill="#f7d477" font-family="Arial,sans-serif" font-size="17" font-weight="700" letter-spacing="4">OFFICIAL CELEBRITY EVENT</text><text x="72" y="264" fill="#ffffff" font-family="Arial,sans-serif" font-size="54" font-weight="800">${xml(ticket.celebrityName || 'StarBook Celebrity')}</text><text x="72" y="310" fill="#e8d8aa" font-family="Arial,sans-serif" font-size="23">${ticket.recipientName ? `ADMIT ONE · ${xml(ticket.recipientName)}` : 'YOUR BOOKING IS CONFIRMED'}</text><text x="72" y="382" fill="#a2a8ba" font-family="Arial,sans-serif" font-size="17" font-weight="700" letter-spacing="3">EVENT</text><text x="72" y="415" fill="#ffffff" font-family="Arial,sans-serif" font-size="24">${xml(ticket.eventType || 'Celebrity booking')}</text><text x="72" y="478" fill="#a2a8ba" font-family="Arial,sans-serif" font-size="17" font-weight="700" letter-spacing="3">DATE</text><text x="72" y="511" fill="#ffffff" font-family="Arial,sans-serif" font-size="24">${xml(formatDate(ticket.eventDate))}</text><text x="72" y="592" fill="#a2a8ba" font-family="monospace" font-size="17">BOOKING REF · ${xml(ticket.bookingReference)}</text><rect x="906" y="172" width="222" height="222" rx="18" fill="#ffffff"/><image x="921" y="187" width="192" height="192" href="${qrBase64}"/><text x="1017" y="435" fill="#f7d477" font-family="Arial,sans-serif" font-size="17" font-weight="700" letter-spacing="3" text-anchor="middle">SCAN TO VERIFY</text><text x="1017" y="474" fill="#a2a8ba" font-family="Arial,sans-serif" font-size="15" text-anchor="middle">Valid while booking is confirmed</text><path d="M72 625H1128" stroke="#ffffff" stroke-opacity=".14"/></svg>`;
      svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Could not render the ticket image.'));
        image.src = svgUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 2400;
      canvas.height = 1350;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser cannot create the ticket image.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!png || png.type !== 'image/png') throw new Error('Could not encode the ticket as a PNG image.');
      pngUrl = URL.createObjectURL(png);
      const link = document.createElement('a');
      link.href = pngUrl;
      link.download = `starbook-ticket-${String(ticket.bookingReference || 'booking').slice(0, 8)}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      status.textContent = 'PNG ticket downloaded.';
    } catch (error) {
      status.textContent = error.message || 'Could not download the event pass image.';
      window.alert(error.message || 'Could not download the event pass image.');
    } finally {
      if (svgUrl) URL.revokeObjectURL(svgUrl);
      if (pngUrl) window.setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
      button.disabled = false;
    }
  }

  loadTicket();
})();
