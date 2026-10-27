function renderNavbar({ activePage = '' } = {}) {
  const loggedIn = Auth.isLoggedIn();
  const user = Auth.user();
  const mobAuthHtml = loggedIn ? `
    <a href="/dashboard.html" class="btn btn-outline" style="width:100%;justify-content:center">📊 Dashboard</a>
    <button data-logout class="btn btn-outline" style="width:100%;justify-content:center;cursor:pointer">🚪 Sign Out</button>
  ` : `
    <a href="/login.html" class="btn btn-outline" style="width:100%;justify-content:center">Sign In</a>
    <a href="/register.html" class="btn btn-gold" style="width:100%;justify-content:center">Join Free</a>
  `;
  return `
<nav class="navbar">
  <div class="nav-inner">
    <a href="/index.html" class="nav-logo">⭐<span>Star</span>Book</a>
    <ul class="nav-links">
      <li><a href="/index.html">Home</a></li>
      <li><a href="/celebrities.html">Celebrities</a></li>
      <li><a href="/fancard.html">Fan Cards</a></li>
      <li><a href="/help.html">Help</a></li>
    </ul>
    <div class="nav-actions">
    <label class="nav-currency-control" title="Change the currency used to display prices">
      <span>Currency</span>
      <select data-currency-select aria-label="Display prices in" disabled><option>USD</option></select>
    </label>
    <div class="nav-notif-wrap" style="display:${loggedIn?'':'none'}">
        <button type="button" class="nav-notif-btn" id="navNotifBtn" title="Notifications" aria-label="Notifications" aria-expanded="false" aria-controls="navNotifDropdown">
          🔔<span class="nav-notif-dot" id="navNotifDot" style="display:none"></span>
        </button>
        <div class="nav-notif-dropdown" id="navNotifDropdown" aria-label="Notifications" hidden>
          <div class="nav-notif-header">
            <strong>Notifications</strong>
            <button type="button" class="nav-notif-mark-all" id="navNotifMarkAll">Mark all read</button>
          </div>
          <div class="nav-notif-list" id="navNotifList" aria-live="polite">
            <p class="nav-notif-empty">Loading notifications…</p>
          </div>
        </div>
      </div>
      <div class="nav-dd-trigger" id="navUserTrigger">
        <button class="nav-user-btn" data-dd-toggle style="display:${loggedIn?'':'none'}" id="navUserMenu">
          <div class="nav-avatar" id="navAvatar">${loggedIn?(user?.fullName||user?.username||'U').charAt(0).toUpperCase():'U'}</div>
          <span class="nav-user-name" id="navUserName">${loggedIn?((user?.fullName||user?.username||'Account').split(' ')[0]):'Account'}</span>
          <span>▾</span>
        </button>
        <div class="nav-dropdown" id="navUserDropdown">
          <a href="/dashboard.html" class="nav-dd-item">👤 Dashboard</a>
          <a href="/dashboard.html#bookings" class="nav-dd-item">📦 My Bookings</a>
          <a href="/dashboard.html#fancards" class="nav-dd-item">🪪 Fan Cards</a>
          <div class="nav-dd-sep"></div>
          <button class="nav-dd-item danger" data-logout>🚪 Sign Out</button>
        </div>
      </div>
      <div class="nav-auth-btns" id="navAuthBtns" style="display:${loggedIn?'none':'flex'};gap:8px">
        <a href="/login.html" class="btn btn-outline" style="padding:8px 18px;font-size:.84rem">Sign In</a>
        <a href="/register.html" class="btn btn-gold" style="padding:8px 18px;font-size:.84rem">Join Free</a>
      </div>
      <button class="hamburger" id="hamburger" aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
    </div>
  </div>
</nav>
<div class="mobile-menu" id="mobileMenu">
  <a href="/index.html">🏠 Home</a>
  <a href="/celebrities.html">⭐ Celebrities</a>
  <a href="/fancard.html">🪪 Fan Cards</a>
  <a href="/help.html">❓ Help</a>
  <div class="mob-divider"></div>
  <div class="mob-actions" id="mobAuthArea">${mobAuthHtml}</div>
</div>`;
}

function renderFooter() {
  const year = new Date().getFullYear();
  if (!document.documentElement.dataset.paymentCopyBound) {
    document.addEventListener('click', async event => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest('[data-copy-payment]');
      if (!button) return;
      const status = document.getElementById('paymentCopyStatus');
      const value = button.dataset.copyPayment;

      const legacyCopy = () => {
        const field = document.createElement('textarea');
        field.value = value;
        field.setAttribute('readonly', '');
        field.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(field);
        try {
          field.select();
          return document.execCommand('copy');
        } finally {
          field.remove();
        }
      };

      try {
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(value);
          } catch (clipboardError) {
            if (!legacyCopy()) throw clipboardError;
          }
        } else if (!legacyCopy()) {
          throw new Error('Clipboard copy was unavailable.');
        }
        status.textContent = `Copied ${value}`;
        button.classList.add('is-copied');
        window.setTimeout(() => button.classList.remove('is-copied'), 1400);
      } catch (error) {
        console.error('Payment label copy failed', error);
        status.textContent = `Could not copy ${value}. Please select and copy it manually.`;
      }
    });
    document.documentElement.dataset.paymentCopyBound = 'true';
  }
  return `
<footer class="footer">
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <div class="logo">⭐<span>Star</span>Book</div>
        <p>The world's premier celebrity booking marketplace. Browse celebrity profiles and request unforgettable experiences.</p>
        <div class="footer-social">
          <a href="#" aria-label="Twitter">𝕏</a>
          <a href="#" aria-label="Instagram">📷</a>
          <a href="#" aria-label="TikTok">🎵</a>
          <a href="#" aria-label="YouTube">▶️</a>
        </div>
      </div>
      <div class="footer-col">
        <h5>Discover</h5>
        <ul>
          <li><a href="/celebrities.html">All Celebrities</a></li>
          <li><a href="/celebrities.html?category=Musician">Musicians</a></li>
          <li><a href="/celebrities.html?category=Actor">Actors</a></li>
          <li><a href="/celebrities.html?category=Footballer">Footballers</a></li>
          <li><a href="/celebrities.html?category=Athlete">Athletes</a></li>
          <li><a href="/fancard.html">Fan Cards</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h5>Company</h5>
        <ul>
          <li><a href="/policies.html#privacy">Privacy Policy</a></li>
          <li><a href="/policies.html#terms">Terms of Service</a></li>
          <li><a href="/policies.html#cookies">Cookie Policy</a></li>
          <li><a href="/help.html">Help Centre</a></li>
          <li><a href="/help.html#refund">Refund Policy</a></li>
          <li><a href="/help.html#contact">Contact Us</a></li>
        </ul>
      </div>
      <div class="footer-col">
        <h5>Contact</h5>
        <div class="footer-contact-item">📧 <a href="mailto:support@starbook.com">support@starbook.com</a></div>
        <div class="footer-contact-item">📞 <a href="tel:+12125550100">+1 (212) 555-0100</a></div>
        <div class="footer-contact-item">🕐 24/7 Live Support</div>
        <div style="margin-top:16px">
          <h5 style="margin-bottom:10px">Payment Accepted</h5>
          <div class="footer-payment-icons">
            <button type="button" class="payment-icon" data-copy-payment="₿ BTC" aria-label="Copy BTC payment label" title="Copy BTC">₿ BTC</button>
            <button type="button" class="payment-icon" data-copy-payment="Ξ ETH" aria-label="Copy ETH payment label" title="Copy ETH">Ξ ETH</button>
            <button type="button" class="payment-icon" data-copy-payment="₮ USDT" aria-label="Copy USDT payment label" title="Copy USDT">₮ USDT</button>
          </div>
          <div class="footer-payment-icons" style="margin-top:6px">
            <button type="button" class="payment-icon" data-copy-payment="🎮 Razer" aria-label="Copy Razer payment label" title="Copy Razer">🎮 Razer</button>
            <button type="button" class="payment-icon" data-copy-payment="🍎 iTunes" aria-label="Copy iTunes payment label" title="Copy iTunes">🍎 iTunes</button>
          </div>
          <span id="paymentCopyStatus" class="payment-copy-status" role="status" aria-live="polite"></span>
        </div>
      </div>
    </div>
    <div class="footer-bottom">
      <p class="footer-copy">© ${year} StarBook Platform. All rights reserved.</p>
      <div class="footer-legal">
        <a href="/policies.html#terms">Terms</a>
        <a href="/policies.html#privacy">Privacy</a>
        <a href="/policies.html#cookies">Cookies</a>
      </div>
    </div>
  </div>
</footer>`;
}

function renderCelebCard(c) {
  const img = resolveImageSource(c.image, c.name, 300);
  const fallback = avatarFallback(c.name, 300);
  const name = escapeHTML(c.name || 'Celebrity');
  const category = escapeHTML(c.category || 'Celebrity');
  const available = c.available !== false;
  const stars = '★'.repeat(Math.round(c.rating||4)) + '☆'.repeat(5-Math.round(c.rating||4));
  return `
<div class="celeb-card" data-id="${escapeHTML(c.id)}">
  <div class="celeb-card-img-wrap">
    <img src="${escapeHTML(img)}" alt="${name}" class="celeb-card-img" loading="lazy" onerror="this.src='${fallback}'">
    ${c.verified?'<span class="celeb-verified">✓</span>':''}
    ${c.featured?'<span class="celeb-featured-tag">⭐ Featured</span>':''}
    ${available?'':'<span class="badge badge-danger" style="position:absolute;top:12px;left:12px;z-index:2">Currently unavailable</span>'}
    <div class="celeb-card-overlay">
      <a href="/celebrity.html?id=${encodeURIComponent(c.id)}" class="btn btn-gold" style="width:100%;font-size:.82rem">👁 View Profile</a>
    </div>
  </div>
  <div class="celeb-card-body">
    <span class="badge badge-gold" style="font-size:.68rem;margin-bottom:8px">${category}</span>
    <h3 class="celeb-card-name">${name}</h3>
    <p class="celeb-card-meta">📍 ${escapeHTML(c.location||'Global')} · 👥 ${escapeHTML(c.followers||'1M+')}${c.languages?.length?' · '+escapeHTML(c.languages[0]):''}</p>
    <div class="celeb-card-rating">
      <span class="star-rating" style="font-size:.85rem">${stars}</span>
      <span style="color:var(--text3);font-size:.78rem">(${c.rating||4.5})</span>
    </div>
    <div class="celeb-card-footer">
      <div>
        <div style="font-size:.72rem;color:var(--text3)">Starting from</div>
        <div class="celeb-card-price" data-price-usd="${Number(c.price)||0}">${formatCurrency(c.price)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${available
          ? `<a href="/booking.html?id=${encodeURIComponent(c.id)}" class="btn btn-gold" style="padding:7px 14px;font-size:.78rem">Book Now</a>`
          : '<button type="button" class="btn btn-outline" disabled aria-disabled="true" style="padding:7px 14px;font-size:.78rem;cursor:not-allowed;opacity:.65">Unavailable</button>'}
        <a href="/fancard.html?celebrity=${encodeURIComponent(c.id)}" class="btn btn-outline" style="padding:5px 12px;font-size:.75rem">🪪 Fan Card</a>
      </div>
    </div>
  </div>
</div>`;
}

function renderLiveNotification() {
  const el = document.createElement('div');
  el.id = 'liveNotif';
  el.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:400;background:var(--bg2);border:1px solid var(--border2);border-radius:14px;padding:14px 18px;display:flex;gap:12px;align-items:center;box-shadow:0 12px 48px rgba(0,0,0,0.6);max-width:300px;font-size:.8rem;transform:translateY(200px);opacity:0;transition:all .5s cubic-bezier(0.34,1.56,.64,1);pointer-events:none';
  el.innerHTML = '<span style="font-size:1.3rem;flex-shrink:0">🌍</span><div id="liveNotifContent"></div>';
  document.body.appendChild(el);
  let hideTimer;

  function hideNotification() {
    el.style.transform = 'translateY(200px)';
    el.style.opacity = '0';
  }

  async function showNotif() {
    try {
      const r = await fetch('/api/live-notifications');
      if (r.status === 204) {
        clearTimeout(hideTimer);
        hideNotification();
        return;
      }
      if (!r.ok) throw new Error(`Live notification request failed (${r.status}).`);
      const d = await r.json();
      const c = document.getElementById('liveNotifContent');
      if (!c || !d.name || !d.action || !d.celebrity) {
        throw new Error('Live notification response is missing activity details.');
      }
      const label = document.createElement('small');
      label.style.cssText = 'display:block;color:var(--gold);font-size:.68rem;font-weight:700;margin-bottom:4px';
      label.textContent = d.isDemo ? 'LIVE · BOOKING  ' : (d.isany ? 'Recent StarBook activity' : '');
      const message = document.createElement('p');
      message.style.lineHeight = '1.4';
      const name = document.createElement('strong');
      name.textContent = d.name;
      message.append(name);
      if (d.city) {
        const city = document.createElement('span');
        city.textContent = ` from ${d.city}`;
        message.append(city);
      }
      message.append(` ${d.action} `);
      const celebrity = document.createElement('strong');
      celebrity.textContent = d.celebrity;
      message.append(celebrity);
      const time = document.createElement('p');
      time.style.cssText = 'font-size:.7rem;color:var(--text3);margin-top:3px';
      time.textContent = d.time;
      c.replaceChildren(label, message, time);
      el.style.transform = 'translateY(0)';
      el.style.opacity = '1';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideNotification, 5000);
    } catch (error) {
      console.error('Could not load the live activity notification:', error);
      clearTimeout(hideTimer);
      hideNotification();
    }
  }
  setTimeout(showNotif, 4000);
  setInterval(showNotif, 14000 + Math.random()*4000);
}

function renderChatbot() {
  const intents = [
    {
      terms: ['how to book', 'book a celebrity', 'make a booking', 'booking process', 'reserve a star'],
      answer: 'To book: browse the <a href="/celebrities.html">celebrity directory</a>, open a profile, choose Book Now, enter the event details, submit payment proof, then confirm. You can track the request from your dashboard. The team reviews submitted bookings within 24–48 hours.'
    },
    {
      terms: ['crypto payment', 'cryptocurrency', 'bitcoin', 'crypto', 'btc', 'ethereum', 'usdt', 'bnb', 'xrp', 'wallet address', 'copy wallet'],
      answer: 'Crypto payments support BTC, ETH, USDT (TRC20), BNB, and XRP. The order total is a fiat reference; use your wallet’s current quote to calculate the crypto amount, then upload payment proof. StarBook does not calculate or automatically process crypto payments. Check the selected network and address before sending; transfers cannot be reversed.'
    },
    {
      terms: ['gift card', 'razer gold', 'itunes', 'google play', 'steam card', 'amazon card'],
      answer: 'Gift cards accepted are Razer Gold, iTunes, Google Play, Steam, and Amazon. Choose Gift Card in the payment step, select the brand, enter the code and value, and upload the requested proof. Do not redeem the code first.'
    },
    {
      terms: ['payment status', 'payment proof', 'verify payment', 'payment verification', 'transaction status', 'payment pending'],
      answer: 'Payment proof is reviewed by the team after you submit a booking or fan-card order. Check its status in your dashboard. If it remains pending or the proof was rejected, contact support from the <a href="/help.html#contact">Help Center</a> with your booking or order ID.'
    },
    {
      terms: ['payment methods', 'payment options', 'how can i pay', 'ways to pay', 'payment'],
      answer: 'StarBook accepts cryptocurrency (BTC, ETH, USDT TRC20, BNB, XRP) and gift cards (Razer Gold, iTunes, Google Play, Steam, Amazon). The payment methods are shown during checkout. See the <a href="/help.html#payment-guides">payment guides</a> for the steps.'
    },
    {
      terms: ['refund', 'money back', 'get my money back'],
      answer: 'Approved bookings may qualify for a refund if the celebrity fails to deliver within 14 days. Send a refund request through the <a href="/help.html#contact">Contact Support</a> form with your booking ID. Refund eligibility depends on the booking status and policy.'
    },
    {
      terms: ['cancel booking', 'cancellation', 'cancel my order'],
      answer: 'Open Dashboard → My Bookings and check the booking details for available actions. Cancellation and refund eligibility depend on the booking status and timing. If no cancellation action is available, contact support with your booking ID.'
    },
    {
      terms: ['booking status', 'track booking', 'when is my booking', 'booking confirmation', 'delivery time', 'when will it arrive'],
      answer: 'You can check booking status in Dashboard → My Bookings. After submission, the team generally reviews bookings within 24–48 hours. Once approved, delivery timing depends on the celebrity and service; check the booking details and contact support if the expected delivery window has passed.'
    },
    {
      terms: ['fan card', 'membership card', 'fan card order'],
      answer: 'You can request a celebrity fan card from the <a href="/fancard.html">Fan Cards page</a> or a celebrity profile. Choose the celebrity and membership tier, submit payment details, and check your dashboard for the order status after review.'
    },
    {
      terms: ['forgot my password', 'reset my password', 'change my password', 'forgot password', 'reset password', 'change password'],
      answer: 'For help changing or recovering access to your password, use the Contact Support form in the <a href="/help.html#contact">Help Center</a> and include the email on your account. Never send your current password in a support message.'
    },
    {
      terms: ['create account', 'register', 'sign up', 'username', 'log in', 'login', 'password'],
      answer: 'Create an account from <a href="/register.html">Join Free</a> using your name, username, email, and password. If you already have an account, sign in with your username or email. For access trouble, use the <a href="/help.html#contact">support form</a>.'
    },
    {
      terms: ['celebrity price', 'price', 'cost', 'how much'],
      answer: 'Prices vary by celebrity and service. Browse the <a href="/celebrities.html">celebrity directory</a> and open a profile to see current options and pricing before booking.'
    },
    {
      terms: ['contact support', 'customer service', 'support', 'help'],
      answer: 'Visit the <a href="/help.html">Help Center</a> to search answers and read the payment guides. For a personal request, use the Contact Support form and include your booking or order ID.'
    },
    {
      terms: ['categories', 'celebrity types', 'what celebrities'],
      answer: 'The directory includes musicians, actors, footballers, athletes, comedians, TV hosts, influencers, DJs, models, YouTubers, podcasters, and streamers. Browse and filter them on the <a href="/celebrities.html">celebrity directory</a>.'
    },
    {
      terms: ['hello', 'hi', 'hey'],
      answer: 'Hi! 👋 I can help with bookings, payments, refunds, fan cards, account access, and delivery status. What would you like to know?'
    }
  ];
  function escapeChatText(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }
  function getReply(q) {
    const query = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\bhow are you\b|\bhow are you doing\b/.test(query))
      return 'I’m doing well and ready to help! I can guide you through StarBook bookings, payments, fan cards, account access, and support.';
    if (/\bwho are you\b|\bwhat can you do\b|\bwhat are you\b/.test(query))
      return 'I’m StarBot, StarBook’s on-site helper. I can explain how the site works and point you to the right page. I don’t have access to private account or payment records.';
    if (/\bprove yourself\b|\bpoof yourself\b/.test(query))
      return 'I can prove useful by giving clear StarBook guidance, helping you find the right page, and telling you when I’m unsure. Ask me about a booking, payment, fan card, or account issue.';
    if (/^(thanks|thank you|thx)\b/.test(query))
      return 'You’re welcome! If you need anything else, tell me what you’re trying to do and I’ll help you find the next step.';
    if (/\btell me a joke\b|\bmake me laugh\b/.test(query))
      return 'Why did the fan bring a calendar to the concert? They wanted to make sure they booked the right date! 🎤';
    const match = intents
      .flatMap(intent => intent.terms.map(term => ({ intent, term })))
      .filter(({ term }) => ` ${query} `.includes(` ${term} `))
      .sort((a, b) => b.term.length - a.term.length)[0];
    if (match) return match.intent.answer;
    return null;
  }

  function getFallbackReply(q) {
    const question = escapeChatText(q.trim().slice(0, 160));
    return question
      ? `I hear you asking “${question}.” I don’t have enough reliable information to answer that confidently yet, but I can still help you work through it. If it’s about StarBook, tell me whether you mean a booking, payment, fan card, or account. For a person to review it, use <a href="/help.html#contact">Contact Support</a>.`
      : 'Tell me a little more and I’ll do my best to help. You can also visit the <a href="/help.html">Help Center</a>.';
  }

  const wrap = document.createElement('div');
  wrap.className = 'chatbot-wrap';
  wrap.innerHTML = `
<button id="chatBtn" style="position:fixed;bottom:20px;right:20px;width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;cursor:pointer;font-size:22px;z-index:300;box-shadow:0 4px 24px rgba(124,92,252,.45);transition:transform .3s,opacity .3s;display:flex;align-items:center;justify-content:center" title="Chat with StarBot">🤖</button>
<div id="chatWin" style="display:none;position:fixed;bottom:84px;right:20px;width:320px;background:var(--bg2);border:1px solid var(--border);border-radius:20px;z-index:300;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);display:none;flex-direction:column;max-height:70vh">
  <div style="background:linear-gradient(135deg,var(--accent),var(--accent2));padding:14px 18px;display:flex;align-items:center;gap:12px">
    <div style="width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:1.3rem">🤖</div>
    <div style="flex:1"><div style="font-weight:700;color:#fff;font-size:.9rem">StarBot AI</div><div id="chatStatus" role="status" aria-live="polite" style="font-size:.7rem;color:rgba(255,255,255,.7)">● Checking connection…</div></div>
    <button id="chatClose" style="background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;font-size:18px">✕</button>
  </div>
  <div id="chatMsgs" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;min-height:150px"></div>
  <div id="chatQuickReplies" style="padding:0 14px 10px;display:flex;flex-wrap:wrap;gap:6px"></div>
  <div style="padding:10px 12px;border-top:1px solid var(--border);display:flex;gap:8px">
    <input id="chatInput" placeholder="Type your question..." style="flex:1;border-radius:20px;padding:9px 14px;font-size:.85rem;width:auto">
    <button id="chatSend" style="width:38px;height:38px;border-radius:50%;background:var(--accent);border:none;cursor:pointer;color:#fff;font-size:15px;flex-shrink:0">➤</button>
  </div>
</div>`;
  document.body.appendChild(wrap);

  const btn = document.getElementById('chatBtn');
  const win = document.getElementById('chatWin');
  const msgs = document.getElementById('chatMsgs');
  const input = document.getElementById('chatInput');
  const quick = document.getElementById('chatQuickReplies');
  const status = document.getElementById('chatStatus');
  const sendButton = document.getElementById('chatSend');
  const conversationHistory = [];
  let open = false;

  async function updateAvailability() {
    if (!navigator.onLine) {
      status.textContent = '● Offline';
      status.style.color = '#fca5a5';
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    try {
      const response = await fetch('/api/starbot/status', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`StarBook service returned ${response.status}`);
      const availability = await response.json();
      status.textContent = availability.available ? '● AI ready' : '● Help mode';
      status.style.color = availability.available ? '#86efac' : '#fcd68a';
      status.title = availability.available
        ? 'StarBot’s local AI model is available.'
        : 'The AI model is unavailable; StarBot’s built-in StarBook help still works.';
    } catch (error) {
      status.textContent = '● Unavailable';
      status.style.color = '#fca5a5';
      console.error('Could not check StarBot availability:', error);
    } finally {
      clearTimeout(timeout);
    }
  }
  updateAvailability();
  setInterval(updateAvailability, 30000);
  window.addEventListener('online', updateAvailability);
  window.addEventListener('offline', updateAvailability);

  function addMsg(html, from) {
    const d = document.createElement('div');
    d.style.cssText = `max-width:84%;padding:10px 14px;border-radius:14px;font-size:.85rem;line-height:1.5;align-self:${from==='user'?'flex-end':'flex-start'};background:${from==='user'?'var(--accent)':'var(--surface2)'};color:${from==='user'?'#fff':'var(--text)'};border-bottom-${from==='user'?'right':'left'}-radius:4px`;
    if (from === 'user') d.textContent = html;
    else d.innerHTML = html;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  function rememberMessage(role, content) {
    const plainContent = role === 'assistant'
      ? String(content).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      : String(content);
    conversationHistory.push({ role, content: plainContent.slice(0, 1000) });
    if (conversationHistory.length > 10)
      conversationHistory.splice(0, conversationHistory.length - 10);
  }

  async function typeReply(element, text) {
    const value = String(text || '').slice(0, 4000);
    element.textContent = '';
    element.style.whiteSpace = 'pre-wrap';
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      element.textContent = value;
      msgs.scrollTop = msgs.scrollHeight;
      return;
    }
    const chunkSize = value.length > 1200 ? 12 : 3;
    const delay = value.length > 1200 ? 8 : 16;
    for (let index = 0; index < value.length; index += chunkSize) {
      element.textContent += value.slice(index, index + chunkSize);
      msgs.scrollTop = msgs.scrollHeight;
      await new Promise(resolve => window.setTimeout(resolve, delay));
    }
  }

  async function sendMsg(text) {
    text = text.trim();
    if (!text) return;
    if (input.disabled || sendButton.disabled) return;
    input.disabled = true;
    sendButton.disabled = true;
    input.value = '';
    quick.innerHTML = '';
    addMsg(text, 'user');
    const history = conversationHistory.slice(-10);
    rememberMessage('user', text);
    const knownReply = getReply(text);
    if (knownReply) {
      const pendingKnown = addMsg('', 'bot');
      const plainKnown = knownReply.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
      window.setTimeout(async () => {
        try {
          await typeReply(pendingKnown, plainKnown);
          rememberMessage('assistant', plainKnown);
        } finally {
          input.disabled = false;
          sendButton.disabled = false;
          input.focus();
        }
      }, 350 + Math.random() * 350);
      return;
    }

    const pending = addMsg('StarBot is thinking…', 'bot');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch('/api/starbot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text.slice(0, 1000), history }),
        signal: controller.signal
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'StarBot AI could not answer right now.');
      if (typeof result.reply !== 'string' || !result.reply.trim())
        throw new Error('StarBot AI returned an empty reply.');
      const reply = result.reply.trim().slice(0, 4000);
      await typeReply(pending, reply);
      rememberMessage('assistant', reply);
    } catch (error) {
      const fallback = getFallbackReply(text).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      await typeReply(pending, fallback);
      rememberMessage('assistant', fallback);
      if (error.name !== 'AbortError')
        console.warn('StarBot AI reply failed; using built-in help response:', error.message);
      else
        console.warn('StarBot AI reply timed out; using built-in help response.');
    } finally {
      window.clearTimeout(timeout);
      input.disabled = false;
      sendButton.disabled = false;
      input.focus();
      msgs.scrollTop = msgs.scrollHeight;
    }
  }

  const quickList = ['How to book?','Gift card payment','Fan Card info','Delivery time','Refund policy'];
  quickList.forEach(q => {
    const b = document.createElement('button');
    b.style.cssText = 'padding:5px 12px;border-radius:20px;border:1px solid var(--border2);background:var(--gold-glow);color:var(--gold);font-size:.75rem;cursor:pointer;font-family:var(--font-body)';
    b.textContent = q;
    b.addEventListener('click', () => sendMsg(q));
    quick.appendChild(b);
  });

  addMsg('Hi! 👋 I\'m <strong>StarBot</strong>. Ask me about booking, payments, fan cards, or anything else!', 'bot');

  function openChat() { open = true; win.style.display = 'flex'; btn.style.display = 'flex'; btn.textContent = '✕'; }
  function closeChat() { open = false; win.style.display = 'none'; btn.textContent = '🤖'; }

  btn.addEventListener('click', () => open ? closeChat() : openChat());
  document.getElementById('chatClose')?.addEventListener('click', closeChat);
  sendButton?.addEventListener('click', () => sendMsg(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') sendMsg(input.value); });

  document.addEventListener('click', e => {
    if (open && !win.contains(e.target) && !btn.contains(e.target)) closeChat();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && open) closeChat(); });

  let lastScroll = window.scrollY;
  window.addEventListener('scroll', () => {
    const current = window.scrollY;
    if (current > lastScroll + 10) {
      btn.style.transform = 'translateY(120px)';
      btn.style.opacity = '0';
      if (open) closeChat();
    } else if (current < lastScroll - 10) {
      btn.style.transform = 'translateY(0)';
      btn.style.opacity = '1';
    }
    lastScroll = current;
  }, { passive: true });
}
