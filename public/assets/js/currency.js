(function () {
  const storageKey = 'starbook-display-currency';
  const timezoneCurrencies = {
    'Africa/Lagos': 'NGN', 'Africa/Nairobi': 'KES', 'Africa/Accra': 'GHS',
    'Africa/Johannesburg': 'ZAR', 'Europe/London': 'GBP', 'Europe/Zurich': 'CHF',
    'Asia/Kolkata': 'INR', 'Asia/Tokyo': 'JPY', 'Asia/Shanghai': 'CNY',
    'Asia/Dubai': 'AED', 'Asia/Singapore': 'SGD', 'Australia/Sydney': 'AUD',
    'Pacific/Auckland': 'NZD', 'America/Toronto': 'CAD', 'America/New_York': 'USD',
    'America/Chicago': 'USD', 'America/Los_Angeles': 'USD',
    'America/Mexico_City': 'MXN', 'America/Sao_Paulo': 'BRL'
  };
  const regionCurrencies = {
    AU: 'AUD', BR: 'BRL', CA: 'CAD', CH: 'CHF', CN: 'CNY', GB: 'GBP',
    GH: 'GHS', IN: 'INR', JP: 'JPY', KE: 'KES', NG: 'NGN', NZ: 'NZD',
    SG: 'SGD', US: 'USD', ZA: 'ZAR'
  };
  let rates = null;
  let rateData = null;
  let preferenceWarning = '';
  let selectedCurrency = 'USD';
  let ratesPromise = null;
  const amountGetters = new Map();
  const statusIds = new Set();
  const currencyCodes = () => Object.keys(rates || {})
    .filter(code => /^[A-Z]{3}$/.test(code))
    .sort((left, right) => left === 'USD' ? -1 : right === 'USD' ? 1 : left.localeCompare(right));

  function detectCurrency() {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezoneCurrencies[timezone]) return timezoneCurrencies[timezone];
    const region = (navigator.language || 'en-US').split('-').pop().toUpperCase();
    return regionCurrencies[region] || 'USD';
  }

  function format(amount, currency = selectedCurrency) {
    return new Intl.NumberFormat(navigator.language || 'en-US', {
      style: 'currency',
      currency
    }).format(amount);
  }

  function convert(amount, currency = selectedCurrency) {
    const value = Number(amount);
    const rate = rates?.[currency];
    if (!Number.isFinite(value) || !Number.isFinite(rate)) return null;
    const digits = new Intl.NumberFormat(undefined, { style: 'currency', currency })
      .resolvedOptions().maximumFractionDigits;
    const factor = 10 ** digits;
    return Math.round((value * rate + Number.EPSILON) * factor) / factor;
  }

  function update() {
    if (!rates) return;
    for (const [id, getAmount] of amountGetters) {
      const element = document.getElementById(id);
      if (!element) continue;
      const converted = convert(getAmount());
      element.textContent = converted === null ? '-' : format(converted);
    }
    document.querySelectorAll('[data-price-usd]').forEach(element => {
      const converted = convert(element.dataset.priceUsd);
      element.textContent = converted === null ? '-' : format(converted);
    });
    document.querySelectorAll('[data-price-limit-usd]').forEach(element => {
      const usdAmount = Number(element.dataset.priceLimitUsd);
      const converted = convert(usdAmount);
      element.textContent = usdAmount >= 10000
        ? 'Any price'
        : converted === null ? `Up to ${format(usdAmount, 'USD')}` : `Up to ${format(converted)}`;
    });
  }

  function dispatchCurrencyChange() {
    window.dispatchEvent(new CustomEvent('starbook-currency-change', {
      detail: { currency: selectedCurrency, rate: rates[selectedCurrency] }
    }));
  }

  function syncCurrencySelects() {
    document.querySelectorAll('[data-currency-select]').forEach(select => {
      select.value = selectedCurrency;
    });
  }

  function selectCurrency(nextCurrency) {
    if (!rates || !Object.hasOwn(rates, nextCurrency)) return false;
    selectedCurrency = nextCurrency;
    syncCurrencySelects();
    try {
      localStorage.setItem(storageKey, selectedCurrency);
    } catch (error) {
      statusIds.forEach(id => {
        const status = document.getElementById(id);
        if (status) status.textContent = `Currency preference could not be saved: ${error.message}`;
      });
    }
    update();
    dispatchCurrencyChange();
    return true;
  }

  function updateStatuses(data, preferenceWarning = '') {
    const updatedAt = Date.parse(data.asOf);
    const dateText = Number.isFinite(updatedAt)
      ? new Date(updatedAt).toLocaleString()
      : 'an unknown time';
    const message = `${preferenceWarning}Exchange rates last updated ${dateText}.${data.stale ? ' Using cached rates.' : ''}`;
    statusIds.forEach(id => {
      const element = document.getElementById(id);
      if (element) element.textContent = message;
    });
  }

  function bindSelect(select, codes) {
    select.replaceChildren(...codes.map(code => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `${code} (${format(1, code).replace(/[\d.,\s]/g, '') || code})`;
      return option;
    }));
    select.disabled = false;
    select.value = selectedCurrency;
    if (select.dataset.currencyBound) return;
    select.dataset.currencyBound = 'true';
    select.addEventListener('change', () => {
      if (!selectCurrency(select.value)) select.value = selectedCurrency;
    });
  }

  async function initialize({ selectId, amountId, statusId, getAmount } = {}) {
    if (amountId && typeof getAmount === 'function') amountGetters.set(amountId, getAmount);
    if (statusId) statusIds.add(statusId);
    const select = selectId ? document.getElementById(selectId) : null;
    if (select && !select.matches('[data-currency-select]')) select.dataset.currencySelect = '';

    if (!ratesPromise) {
      ratesPromise = (async () => {
        const response = await fetch('/api/currency-rates', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Exchange rates are unavailable.');
        if (data.base !== 'USD' || !data.rates || typeof data.rates !== 'object' ||
            Array.isArray(data.rates) || data.rates.USD !== 1 ||
            Object.entries(data.rates).some(([code, rate]) =>
              !/^[A-Z]{3}$/.test(code) || !Number.isFinite(rate) || rate <= 0
            ))
          throw new Error('The exchange-rate response was invalid.');
        rates = data.rates;
        rateData = data;
        const codes = currencyCodes();

        preferenceWarning = '';
        try {
          const savedCurrency = localStorage.getItem(storageKey);
          if (savedCurrency && Object.hasOwn(rates, savedCurrency)) selectedCurrency = savedCurrency;
          else {
            const detected = detectCurrency();
            if (Object.hasOwn(rates, detected)) selectedCurrency = detected;
          }
        } catch (error) {
          preferenceWarning = `Currency preference could not be loaded: ${error.message} `;
        }
        document.querySelectorAll('[data-currency-select]').forEach(item => bindSelect(item, codes));
        updateStatuses(data, preferenceWarning);
        update();
        dispatchCurrencyChange();
        return data;
      })().catch(error => {
        ratesPromise = null;
        document.querySelectorAll('[data-currency-select]').forEach(item => {
          item.replaceChildren(new Option('USD', 'USD'));
          item.value = 'USD';
          item.disabled = true;
        });
        statusIds.forEach(id => {
          const status = document.getElementById(id);
          if (status) status.textContent = `${error.message} Displaying prices in USD.`;
        });
        throw error;
      });
    } else {
      await ratesPromise;
      if (rates) {
        const codes = currencyCodes();
        document.querySelectorAll('[data-currency-select]').forEach(item => bindSelect(item, codes));
      }
      if (rateData) updateStatuses(rateData, preferenceWarning);
      update();
    }
    return ratesPromise;
  }

  window.addEventListener('storage', event => {
    if (event.key !== storageKey || !rates || !Object.hasOwn(rates, event.newValue)) return;
    selectedCurrency = event.newValue;
    syncCurrencySelects();
    update();
    dispatchCurrencyChange();
  });

  if (typeof MutationObserver === 'function') {
    new MutationObserver(records => {
      if (!rates) return;
      const codes = currencyCodes();
      const addedSelects = [];
      if (records.some(record => [...record.addedNodes].some(node =>
        node.nodeType === Node.ELEMENT_NODE &&
        (node.matches?.('[data-price-usd]') || node.querySelector?.('[data-price-usd]'))
      ))) update();
      records.forEach(record => [...record.addedNodes].forEach(node => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.matches?.('[data-currency-select]')) addedSelects.push(node);
        node.querySelectorAll?.('[data-currency-select]').forEach(select => addedSelects.push(select));
      }));
      addedSelects.forEach(select => bindSelect(select, codes));
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  window.StarBookCurrency = {
    initialize,
    update,
    convert,
    format,
    currency: () => selectedCurrency,
    rate: () => rates?.[selectedCurrency] || null,
    isReady: () => Boolean(rates)
  };
})();
