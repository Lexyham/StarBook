(function (global) {
  "use strict";

  const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const TIERS = Object.freeze({
    silver: { label: "Silver Membership", className: "fan-card--silver", mark: "◇" },
    gold: { label: "Gold Membership", className: "fan-card--gold", mark: "✦" },
    vip: { label: "VIP Exclusive", className: "fan-card--vip", mark: "♛" }
  });
  const mounted = new WeakMap();

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function safeImageUrl(value) {
    const raw = String(value || "").trim();
    if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
    try {
      const url = new URL(raw, global.location && global.location.href);
      return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
    } catch {
      return "";
    }
  }

  function initials(name) {
    return String(name || "FC").trim().split(/\s+/).slice(0, 2)
      .map(part => part.charAt(0)).join("").toUpperCase() || "FC";
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
  }

  function statusDetails(status, expiryDate) {
    const value = String(status || "").trim().toLowerCase();
    if (!value) return null;
    if (value === "approved") {
      if (expiryDate) {
        const expiry = new Date(/^\d{4}-\d{2}-\d{2}$/.test(expiryDate) ? `${expiryDate}T23:59:59` : expiryDate);
        if (!Number.isNaN(expiry.getTime()) && expiry.getTime() < Date.now())
          return { label: "Expired", className: "fan-card__status--expired" };
      }
      return { label: "Active", className: "fan-card__status--active" };
    }
    if (value === "pending") return { label: "Pending review", className: "fan-card__status--pending" };
    if (value === "rejected") return { label: "Rejected", className: "fan-card__status--revoked" };
    if (value === "inactive" || value === "revoked" || value === "expired")
      return { label: value, className: `fan-card__status--${value}` };
    return { label: status, className: "fan-card__status--other" };
  }

  function statusMarkup(status, expiryDate) {
    const details = statusDetails(status, expiryDate);
    return details
      ? `<span class="fan-card__status ${details.className}" aria-label="Card status: ${escapeHTML(details.label)}">${escapeHTML(details.label)}</span>`
      : "";
  }

  function verificationQrPath(data) {
    const cardId = String(data.id || data.cardId || "");
    return CARD_ID.test(cardId) && data.status
      ? `/api/fancards/verify/${encodeURIComponent(cardId)}/qr.png`
      : "";
  }

  function render(data, style) {
    const d = data || {};
    const requestedTier = String(style || d.style || d.membershipLevel || d.tier || "silver").toLowerCase();
    const key = Object.hasOwn(TIERS, requestedTier) ? requestedTier : "silver";
    const selected = TIERS[key];
    const celebrityName = String(d.celebrityName || d.celebrity || "Choose a celebrity");
    const tierLabel = d.tierLabel || d.membershipLevel || d.tier || selected.label;
    const celebrity = escapeHTML(celebrityName);
    const member = escapeHTML(d.fanName || d.holderName || "Member");
    const brand = escapeHTML(d.brand || "STARBOOK");
    const category = escapeHTML(d.category || "Celebrity membership");
    const cardNumber = escapeHTML(d.cardNumber || d.fanId || "Assigned after submission");
    const edition = escapeHTML(d.edition || selected.label);
    const tier = escapeHTML(tierLabel);
    const imageUrl = safeImageUrl(d.celebrityImage || d.portraitUrl);
    const logoUrl = safeImageUrl(d.logoUrl);
    const accent = /^#[0-9a-fA-F]{6}$/.test(d.accentColor || "") ? d.accentColor : "";
    const qrPath = verificationQrPath(d);
    const photoMarkup = imageUrl
      ? `<img class="fan-card__portrait" src="${escapeHTML(imageUrl)}" alt="${celebrity} portrait" loading="lazy" decoding="async">`
      : `<div class="fan-card__portrait fan-card__portrait--placeholder" role="img" aria-label="Portrait placeholder for ${celebrity}">${escapeHTML(initials(celebrityName))}</div>`;
    const logoMarkup = logoUrl
      ? `<img class="fan-card__logo" src="${escapeHTML(logoUrl)}" alt="" loading="lazy" decoding="async">`
      : "";
    const qrMarkup = qrPath
      ? `<div class="fan-card__qr" data-qr-image-url="${escapeHTML(qrPath)}" role="img" aria-label="Loading server-generated card verification QR"><span>Loading QR</span></div>`
      : `<div class="fan-card__qr fan-card__qr--empty" role="note" aria-label="A server-issued card QR is available after submission"><span>After order</span></div>`;
    const details = [];
    if (d.serialNumber) details.push(`<span><strong>Serial</strong> ${escapeHTML(d.serialNumber)}</span>`);
    if (d.issueDate) details.push(`<span><strong>Issued</strong> ${escapeHTML(formatDate(d.issueDate))}</span>`);
    if (d.expiryDate) details.push(`<span><strong>Expires</strong> ${escapeHTML(formatDate(d.expiryDate))}</span>`);
    const detailsMarkup = details.length ? `<div class="fan-card__details">${details.join("")}</div>` : "";

    return `<article class="fan-card ${selected.className}" aria-label="${celebrity} fan membership card"${accent ? ` style="--fc-accent:${accent}"` : ""}>
      <span class="fan-card__shine" aria-hidden="true"></span>
      <div class="fan-card__top">
        <div class="fan-card__brand">${logoMarkup}<span class="fan-card__mark" aria-hidden="true">${selected.mark}</span><span>${brand}</span></div>
        <div class="fan-card__edition">${edition}</div>
      </div>
      <div class="fan-card__body">
        ${photoMarkup}
        <div class="fan-card__info">
          <div class="fan-card__eyebrow">Fan membership</div>
          <h3 class="fan-card__name">${celebrity}</h3>
          <div class="fan-card__category">${category}</div>
          <div class="fan-card__member"><span class="fan-card__label">Cardholder</span><span class="fan-card__member-name">${member}</span></div>
          ${detailsMarkup}
          ${statusMarkup(d.status, d.expiryDate)}
        </div>
      </div>
      <div class="fan-card__bottom">
        <div class="fan-card__identifiers"><span class="fan-card__number">${cardNumber}</span><span class="fan-card__tier">${tier}</span></div>
        <div class="fan-card__qr-column">${qrMarkup}<span class="fan-card__qr-label">Verify</span></div>
      </div>
    </article>`;
  }

  function setQRFallback(node, message) {
    node.replaceChildren();
    const label = document.createElement("span");
    label.textContent = message;
    node.appendChild(label);
    node.classList.add("fan-card__qr--empty");
    node.setAttribute("aria-label", message);
    node.dataset.qrReady = "false";
  }

  function hydrate(target) {
    const root = typeof target === "string" ? document.querySelector(target) : target;
    if (!root || !root.querySelectorAll) return root;
    const nodes = [];
    if (root.matches && root.matches(".fan-card__qr[data-qr-image-url]")) nodes.push(root);
    nodes.push(...root.querySelectorAll(".fan-card__qr[data-qr-image-url]"));
    nodes.forEach(node => {
      if (node.dataset.qrReady === "true" || node.dataset.qrReady === "loading") return;
      const path = node.dataset.qrImageUrl || "";
      if (!/^\/api\/fancards\/verify\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/qr\.png$/i.test(path)) {
        setQRFallback(node, "Card verification QR unavailable");
        return;
      }
      const image = document.createElement("img");
      image.className = "fan-card__qr-image";
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("load", () => {
        node.dataset.qrReady = "true";
        node.setAttribute("aria-label", "Server-generated QR code. Scan to check this card's current status.");
      }, { once: true });
      image.addEventListener("error", () => setQRFallback(node, "Verification QR unavailable"), { once: true });
      node.dataset.qrReady = "loading";
      node.replaceChildren(image);
      image.src = path;
    });
    return root;
  }

  function cleanupCard(card) {
    const cleanup = mounted.get(card);
    if (cleanup) cleanup();
    mounted.delete(card);
  }

  function bindInteractions(target) {
    const root = typeof target === "string" ? document.querySelector(target) : target;
    if (!root || !root.querySelectorAll) return root;
    const cards = [];
    if (root.matches && root.matches(".fan-card")) cards.push(root);
    cards.push(...root.querySelectorAll(".fan-card"));
    const reducedMotion = !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    cards.forEach(card => {
      if (mounted.has(card) || reducedMotion) return;
      let rect = null;
      let frame = 0;
      const reset = () => {
        card.style.setProperty("--fc-rotate-x", "0deg");
        card.style.setProperty("--fc-rotate-y", "0deg");
        card.style.setProperty("--fc-pointer-x", "50%");
        card.style.setProperty("--fc-pointer-y", "50%");
      };
      const onEnter = event => { if (event.pointerType !== "touch") rect = card.getBoundingClientRect(); };
      const onMove = event => {
        if (event.pointerType === "touch") return;
        rect = rect || card.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
        if (frame) global.cancelAnimationFrame(frame);
        frame = global.requestAnimationFrame(() => {
          card.style.setProperty("--fc-rotate-y", `${((x - .5) * 9).toFixed(2)}deg`);
          card.style.setProperty("--fc-rotate-x", `${((.5 - y) * 7).toFixed(2)}deg`);
          card.style.setProperty("--fc-pointer-x", `${(x * 100).toFixed(1)}%`);
          card.style.setProperty("--fc-pointer-y", `${(y * 100).toFixed(1)}%`);
        });
      };
      const onLeave = () => { rect = null; reset(); };
      card.addEventListener("pointerenter", onEnter);
      card.addEventListener("pointermove", onMove);
      card.addEventListener("pointerleave", onLeave);
      card.addEventListener("pointercancel", onLeave);
      const imageHandlers = [];
      card.querySelectorAll(".fan-card__portrait, .fan-card__logo").forEach(image => {
        const onError = () => {
          if (image.classList.contains("fan-card__logo")) {
            image.remove();
            return;
          }
          const fallback = document.createElement("div");
          fallback.className = "fan-card__portrait fan-card__portrait--placeholder";
          fallback.setAttribute("role", "img");
          fallback.setAttribute("aria-label", "Portrait unavailable");
          fallback.textContent = initials(image.alt.replace(/ portrait$/i, ""));
          image.replaceWith(fallback);
        };
        image.addEventListener("error", onError, { once: true });
        imageHandlers.push([image, onError]);
      });
      mounted.set(card, () => {
        card.removeEventListener("pointerenter", onEnter);
        card.removeEventListener("pointermove", onMove);
        card.removeEventListener("pointerleave", onLeave);
        card.removeEventListener("pointercancel", onLeave);
        imageHandlers.forEach(([image, handler]) => image.removeEventListener("error", handler));
        if (frame) global.cancelAnimationFrame(frame);
      });
    });
    return root;
  }

  function destroy(target) {
    const element = typeof target === "string" ? document.querySelector(target) : target;
    if (!element) return;
    const cards = element.matches && element.matches(".fan-card")
      ? [element]
      : Array.from(element.querySelectorAll ? element.querySelectorAll(".fan-card") : []);
    cards.forEach(card => {
      cleanupCard(card);
      if (card.parentNode) card.parentNode.removeChild(card);
    });
  }

  function mount(target, data, style) {
    const element = typeof target === "string" ? document.querySelector(target) : target;
    if (!element) throw new Error("Fan card mount target was not found.");
    destroy(element);
    element.insertAdjacentHTML("beforeend", render(data, style));
    hydrate(element);
    bindInteractions(element);
    return element.querySelector(".fan-card");
  }

  global.FanCardTemplates = Object.freeze({
    version: "2.1.0-starbook",
    styles: Object.keys(TIERS),
    render,
    mount,
    update: mount,
    destroy,
    hydrate,
    bindInteractions
  });
})(window);
