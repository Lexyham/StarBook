const API = '';
const $ = (s, c=document) => c.querySelector(s);
const $$ = (s, c=document) => [...c.querySelectorAll(s)];

function playSuccessRocket(container) {
  const rocket = container?.querySelector('.success-rocket');
  if (!rocket) {
    console.error('Success rocket element is missing from the success panel.');
    return;
  }
  rocket.classList.remove('is-flying');
  void rocket.offsetWidth;
  rocket.classList.add('is-flying');
}

const Auth = {
  TOKEN_KEY: 'sb-token',
  USER_KEY: 'sb-user',
  token: () => localStorage.getItem(Auth.TOKEN_KEY),
  user: () => { try { return JSON.parse(localStorage.getItem(Auth.USER_KEY)||'null') } catch { return null } },
  isLoggedIn: () => !!Auth.token(),
  isAdmin: () => Auth.user()?.userType === 'admin',
  save: (token, user) => { localStorage.setItem(Auth.TOKEN_KEY, token); localStorage.setItem(Auth.USER_KEY, JSON.stringify(user)) },
  clear: () => { localStorage.removeItem(Auth.TOKEN_KEY); localStorage.removeItem(Auth.USER_KEY) },
  logout: (redirect = '/index.html') => {
    Auth.clear();
    window.location.assign(redirect);
  },
  headers: () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${Auth.token()}` }),
  async fetch(url, opts={}) {
    const r = await fetch(API + url, { ...opts, headers: { ...Auth.headers(), ...(opts.headers||{}) } });
    if (r.status === 401) { Auth.clear(); window.location.href = '/login.html'; return null; }
    if (r.status === 403) {
      const error = await r.clone().json().catch(() => ({}));
      if (/banned/i.test(error.message || '')) { Auth.clear(); window.location.href = '/login.html'; return null; }
    }
    return r;
  }
};

function initializeSiteCurrency() {
  const start = () => window.StarBookCurrency?.initialize()
    .catch(error => console.error('Could not initialize the site currency selector:', error));
  if (window.StarBookCurrency) {
    start();
    return;
  }
  let script = document.querySelector('script[data-starbook-currency]');
  if (!script) {
    script = document.createElement('script');
    script.src = '/assets/js/currency.js';
    script.dataset.starbookCurrency = 'true';
    document.head.appendChild(script);
  }
  script.addEventListener('load', start, { once: true });
  script.addEventListener('error', () => console.error('The site currency selector could not be loaded.'), { once: true });
}

function initializeNotificationRealtime() {
  if (!Auth.isLoggedIn() || Auth.isAdmin()) return;
  const connect = () => {
    const socket = window.starbookNotificationSocket || window.io?.({ auth: { token: Auth.token() } });
    if (!socket) {
      console.error('Realtime notifications are unavailable because the Socket.IO client did not load.');
      return;
    }
    window.starbookNotificationSocket = socket;
    if (socket.starbookNotificationEventsBound) return;
    socket.starbookNotificationEventsBound = true;
    ['notification', 'notification-update', 'notification-delete'].forEach(eventName => {
      socket.on(eventName, () => window.dispatchEvent(new Event('starbook-notification-change')));
    });
    socket.on('connect_error', error => console.error('Realtime notification connection failed:', error.message));
  };
  if (typeof window.io === 'function') {
    connect();
    return;
  }
  let script = document.querySelector('script[data-starbook-socket]');
  if (!script) {
    script = document.createElement('script');
    script.src = '/socket.io/socket.io.js';
    script.dataset.starbookSocket = 'true';
    document.head.appendChild(script);
  }
  script.addEventListener('load', connect, { once: true });
  script.addEventListener('error', () => console.error('The Socket.IO client could not be loaded.'), { once: true });
}

const Toast = {
  container: null,
  init() {
    if (!this.container) { this.container = document.createElement('div'); this.container.className = 'toast-container'; document.body.appendChild(this.container); }
  },
  show(msg, type='success', dur=3500) {
    this.init();
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<span>${type==='success'?'✓':type==='error'?'✕':'ℹ'}</span> ${msg}`;
    this.container.appendChild(t);
    requestAnimationFrame(() => { requestAnimationFrame(() => t.classList.add('show')); });
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, dur);
  },
  success: (m) => Toast.show(m,'success'),
  error: (m) => Toast.show(m,'error'),
  info: (m) => Toast.show(m,'info')
};

function initNavbar() {
  const hamburger = $('.hamburger');
  const mobileMenu = $('.mobile-menu');
  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('open');
      mobileMenu.classList.toggle('open');
    });
    document.addEventListener('click', e => {
      if (!hamburger.contains(e.target) && !mobileMenu.contains(e.target)) {
        hamburger.classList.remove('open');
        mobileMenu.classList.remove('open');
      }
    });
  }

  $$('.nav-dd-trigger').forEach(trigger => {
    const dd = trigger.querySelector('.nav-dropdown');
    if (!dd) return;
    trigger.querySelector('[data-dd-toggle]')?.addEventListener('click', e => {
      e.stopPropagation();
      $$('.nav-dropdown.open').forEach(o => { if (o !== dd) o.classList.remove('open'); });
      dd.classList.toggle('open');
    });
  });
  document.addEventListener('click', () => $$('.nav-dropdown.open').forEach(d => d.classList.remove('open')));

  const user = Auth.user();
  const authBtns = $('.nav-auth-btns');
  const userMenu = $('.nav-user-menu');
  if (Auth.isLoggedIn() && user) {
    if (authBtns) authBtns.style.display = 'none';
    if (userMenu) {
      userMenu.style.display = '';
      const av = userMenu.querySelector('.nav-avatar');
      if (av) av.textContent = (user.fullName||user.full_name||user.email||'U').charAt(0).toUpperCase();
      const nameEl = userMenu.querySelector('.nav-user-name');
      if (nameEl) nameEl.textContent = (user.fullName||user.full_name||'Account').split(' ')[0];
    }
  } else {
    if (userMenu) userMenu.style.display = 'none';
  }

  const notifButton = $('#navNotifBtn');
  const notifDropdown = $('#navNotifDropdown');
  const notifList = $('#navNotifList');
  const notifDot = $('#navNotifDot');
  const markAllButton = $('#navNotifMarkAll');
  if (notifDropdown && notifButton) {
    notifDropdown.classList.add('nav-notif-dropdown-portal');
    document.body.appendChild(notifDropdown);
  }

  function positionNotifications() {
    if (!notifButton || !notifDropdown) return;
    const buttonRect = notifButton.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const panelWidth = Math.min(360, viewportWidth - 24);
    const panelHeight = Math.min(window.innerHeight * 0.7, 520);
    const left = Math.max(12, Math.min(viewportWidth - panelWidth - 12, buttonRect.right - panelWidth));
    const top = Math.max(12, Math.min(buttonRect.bottom + 10, window.innerHeight - panelHeight - 12));
    notifDropdown.style.left = `${left}px`;
    notifDropdown.style.top = `${top}px`;
    notifDropdown.style.width = `${panelWidth}px`;
    notifDropdown.style.maxHeight = `${panelHeight}px`;
    notifDropdown.style.setProperty('--nav-notif-list-max-height', `${Math.max(90, panelHeight - 54)}px`);
  }

  function closeNotifications() {
    if (!notifButton || !notifDropdown) return;
    notifDropdown.hidden = true;
    notifButton.setAttribute('aria-expanded', 'false');
  }

  function renderNotifications(notifications) {
    if (!notifList) return;
    const newestFirst = notifications
      .map((notification, index) => ({
        notification,
        index,
        timestamp: Date.parse(notification.createdAt || '')
      }))
      .sort((a, b) => {
        const aTimestamp = Number.isFinite(a.timestamp) ? a.timestamp : Number.NEGATIVE_INFINITY;
        const bTimestamp = Number.isFinite(b.timestamp) ? b.timestamp : Number.NEGATIVE_INFINITY;
        return bTimestamp - aTimestamp || a.index - b.index;
      })
      .map(entry => entry.notification);
    const unread = notifications.filter(notification => !notification.read).length;
    if (notifDot) notifDot.style.display = unread ? '' : 'none';
    if (notifButton) {
      notifButton.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
      notifButton.title = unread ? `Notifications (${unread} unread)` : 'Notifications';
    }
    if (markAllButton) markAllButton.hidden = unread === 0;
    notifList.replaceChildren();
    if (!notifications.length) {
      const empty = document.createElement('p');
      empty.className = 'nav-notif-empty';
      empty.textContent = 'No notifications yet.';
      notifList.appendChild(empty);
      return;
    }

    newestFirst.slice(0, 20).forEach(notification => {
      const item = document.createElement(notification.read ? 'div' : 'button');
      item.className = `nav-notif-item${notification.read ? '' : ' unread'}`;
      if (!notification.read) {
        item.type = 'button';
        item.title = 'Mark notification as read';
      }
      const icon = document.createElement('span');
      icon.className = 'nav-notif-icon';
      icon.textContent = notification.type === 'booking' ? '📋'
        : notification.type === 'payment' ? '💳'
          : notification.type === 'fancard' ? '🪪' : '🔔';
      const details = document.createElement('span');
      details.className = 'nav-notif-details';
      const message = document.createElement('span');
      message.className = 'nav-notif-message';
      message.textContent = notification.message || notification.title || 'Notification';
      const date = document.createElement('span');
      date.className = 'nav-notif-date';
      date.textContent = notification.createdAt ? new Date(notification.createdAt).toLocaleString() : '';
      details.append(message, date);
      item.append(icon, details);
      if (!notification.read) {
        item.addEventListener('click', async () => {
          const id = notification.id || notification._id;
          if (!id) return;
          try {
            const response = await Auth.fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PATCH' });
            if (!response?.ok) throw new Error(`Mark notification read failed (${response?.status || 'no response'}).`);
            await loadNotifications();
          } catch (error) {
            console.error('Could not mark notification as read:', error);
          }
        });
      }
      notifList.appendChild(item);
    });
  }

  async function loadNotifications() {
    if (!notifList || !Auth.isLoggedIn()) return;
    notifList.innerHTML = '<p class="nav-notif-empty">Loading notifications…</p>';
    try {
      const response = await Auth.fetch('/api/notifications/mine');
      if (!response?.ok) throw new Error(`Notification request failed (${response?.status || 'no response'}).`);
      const result = await response.json();
      const notifications = Array.isArray(result) ? result : result.notifications;
      if (!Array.isArray(notifications)) throw new Error('Notification response has an invalid format.');
      renderNotifications(notifications);
    } catch (error) {
      console.error('Could not load dashboard notifications:', error);
      notifList.innerHTML = '<p class="nav-notif-empty">Unable to load notifications. Please try again.</p>';
    }
  }

  notifButton?.addEventListener('click', event => {
    event.stopPropagation();
    const opening = notifDropdown.hidden;
    if (opening) positionNotifications();
    notifDropdown.hidden = !opening;
    notifButton.setAttribute('aria-expanded', String(opening));
    if (opening) loadNotifications();
  });
  window.addEventListener('resize', () => {
    if (notifDropdown && !notifDropdown.hidden) positionNotifications();
  });
  window.addEventListener('scroll', () => {
    if (notifDropdown && !notifDropdown.hidden) closeNotifications();
  }, { passive: true });
  notifDropdown?.addEventListener('click', event => event.stopPropagation());
  document.addEventListener('click', event => {
    if (notifDropdown && !notifDropdown.hidden && !notifDropdown.contains(event.target) && !notifButton?.contains(event.target)) {
      closeNotifications();
    }
  });
  markAllButton?.addEventListener('click', async () => {
    try {
      const response = await Auth.fetch('/api/notifications/read-all', { method: 'PATCH' });
      if (!response?.ok) throw new Error(`Mark all notifications read failed (${response?.status || 'no response'}).`);
      await loadNotifications();
    } catch (error) {
      console.error('Could not mark all notifications as read:', error);
    }
  });
  if (notifButton) loadNotifications();
  window.reloadStarBookNotifications = loadNotifications;
  window.addEventListener('starbook-notification-change', loadNotifications);
  if (document.querySelector('[data-currency-select]')) initializeSiteCurrency();
  initializeNotificationRealtime();

  const logoutBtns = $$('[data-logout]');
  logoutBtns.forEach(button => button.addEventListener('click', () => Auth.logout()));

  const curr = window.location.pathname.split('/').pop() || 'index.html';
  $$('.nav-links a, .mobile-menu a').forEach(a => {
    const href = a.getAttribute('href')?.split('/').pop() || '';
    if (href === curr || (curr === '' && href === 'index.html')) a.classList.add('active');
  });
}

function initScrollTop() {
  const btn = document.createElement('button');
  btn.className = 'scroll-to-top';
  btn.innerHTML = '↑';
  btn.title = 'Back to top';
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  document.body.appendChild(btn);
  window.addEventListener('scroll', () => btn.classList.toggle('show', window.scrollY > 400), { passive: true });
}

function initTabs() {
  $$('.tab-bar').forEach(bar => {
    const btns = $$('.tab-btn', bar);
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        const container = btn.closest('.tab-section') || btn.closest('section') || btn.closest('[data-tabs]') || document;
        $$('.tab-btn', bar).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.tab-content', container).forEach(c => c.classList.toggle('active', c.dataset.tab === target));
      });
    });
    if (btns.length && !bar.querySelector('.tab-btn.active')) btns[0]?.click();
  });
}

function initModals() {
  $$('[data-modal-open]').forEach(btn => {
    const id = btn.dataset.modalOpen;
    btn.addEventListener('click', () => document.getElementById(id)?.classList.add('open'));
  });
  $$('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  });
  $$('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.modal-overlay')?.classList.remove('open'));
  });
}

function requireAuth(redirect='/login.html') {
  if (!Auth.isLoggedIn()) { window.location.href = redirect; return false; }
  return true;
}

function requireAdmin() {
  if (!Auth.isLoggedIn() || !Auth.isAdmin()) { window.location.href = '/index.html'; return false; }
  return true;
}

function avatarFallback(name, size=80) {
  const initials = name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  const hue = [...name].reduce((a,c)=>a+c.charCodeAt(0),0) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="hsl(${hue},50%,35%)"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-weight="800" font-size="${size*.36}px" fill="#fff">${initials}</text></svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

function resolveImageSource(source, name='Star', size=80) {
  if (typeof source !== 'string' || !source.trim()) return avatarFallback(name, size);
  const value = source.trim();
  if (/^https?:\/\//i.test(value) || /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value)) return value;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const publicCelebrityImage = normalized.match(/(?:^|\/)(?:public\/)?images\/celebrities\/([^/]+)$/i);
  if (publicCelebrityImage) return `/images/celebrities/${encodeURIComponent(publicCelebrityImage[1])}`;
  const celebrityImage = normalized.match(/(?:^|\/)celebrities\/([^/]+)$/i);
  if (celebrityImage) return `/celebrities/${encodeURIComponent(celebrityImage[1])}`;
  const pathValue = normalized.replace(/^\/+/, '');
  const rooted = normalized.startsWith('/') || /^(?:images|celebrities|assets)\//i.test(pathValue)
    ? pathValue
    : `celebrities/${pathValue}`;
  return `/${rooted.split('/').map(encodeURIComponent).join('/')}`;
}

function escapeHTML(value='') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function imgWithFallback(img, name) {
  img.addEventListener('error', () => { img.src = avatarFallback(name || 'Star', parseInt(img.width)||80); }, { once: true });
}

function formatDate(d) { return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function formatCurrency(n) { return '$' + Number(n||0).toLocaleString(); }
function formatPaymentMethod(method) {
  const value = String(method || '').trim();
  const labels = {
    crypto: 'Cryptocurrency',
    giftcard: 'Gift Card',
    gift_card: 'Gift Card'
  };
  return labels[value] || value.replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase()) || '-';
}

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const el = document.createElement('textarea');
  el.value = text; el.style.position = 'fixed'; el.style.opacity = '0';
  document.body.appendChild(el); el.focus(); el.select();
  document.execCommand('copy'); document.body.removeChild(el);
  return Promise.resolve();
}

function showMsg(el, text, type='error') {
  if (!el) return;
  el.textContent = text;
  el.className = `msg msg-${type} show`;
}
function hideMsg(el) { if (el) { el.className = 'msg'; el.textContent = ''; } }

document.addEventListener('DOMContentLoaded', () => {
  initNavbar();
  initScrollTop();
  initTabs();
  initModals();
});
