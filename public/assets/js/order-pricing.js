(function () {
  let settings = null;

  async function initialize() {
    const response = await fetch('/api/order-fees');
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Order fee settings could not be loaded.');
    if (!Number.isFinite(data.serviceFeePercent) || data.serviceFeePercent < 0 ||
        !Number.isFinite(data.taxPercent) || data.taxPercent < 0 ||
        typeof data.taxConfigured !== 'boolean' ||
        typeof data.taxIsEstimate !== 'boolean')
      throw new Error('The order fee settings response was invalid.');
    settings = data;
    return settings;
  }

  function calculate(baseAmount) {
    if (!settings) throw new Error('Order fee settings have not loaded.');
    const baseCents = Math.round(Number(baseAmount) * 100);
    if (!Number.isSafeInteger(baseCents) || baseCents < 0)
      throw new Error('The order price is invalid.');
    const serviceFeeCents = Math.round(baseCents * settings.serviceFeePercent / 100);
    const taxCents = Math.round(baseCents * settings.taxPercent / 100);
    return {
      baseAmount: baseCents / 100,
      serviceFeePercent: settings.serviceFeePercent,
      serviceFeeAmount: serviceFeeCents / 100,
      taxPercent: settings.taxPercent,
      taxAmount: taxCents / 100,
      taxConfigured: settings.taxConfigured,
      taxIsEstimate: settings.taxIsEstimate,
      totalAmount: (baseCents + serviceFeeCents + taxCents) / 100
    };
  }

  function formatUSD(amount) {
    return formatCurrency(amount, 'USD');
  }

  function formatCurrency(amount, currency) {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency
    }).format(amount);
  }

  function renderBreakdown(
    container,
    baseAmount,
    currency = window.StarBookCurrency?.currency() || 'USD',
    exchangeRate = window.StarBookCurrency?.rate() || 1
  ) {
    const amount = calculate(baseAmount);
    const digits = new Intl.NumberFormat(undefined, { style: 'currency', currency })
      .resolvedOptions().maximumFractionDigits;
    const factor = 10 ** digits;
    const displayAmount = value => Math.round((value * exchangeRate + Number.EPSILON) * factor) / factor;
    const rows = [
      ['Base price', displayAmount(amount.baseAmount)],
      [`StarBook service fee (${amount.serviceFeePercent}%)`, displayAmount(amount.serviceFeeAmount)],
      [amount.taxIsEstimate ? `Estimated tax (${amount.taxPercent}%)` : 'Tax', displayAmount(amount.taxAmount)],
      [`Total to pay (${currency})`, displayAmount(amount.totalAmount)]
    ];
    container.replaceChildren();
    rows.forEach(([label, value], index) => {
      const row = document.createElement('div');
      row.style.cssText = `display:flex;justify-content:space-between;gap:12px;padding:${index === rows.length - 1 ? '10px 0 0' : '5px 0'};${index === rows.length - 1 ? 'margin-top:5px;border-top:1px solid var(--border);font-weight:700;color:var(--gold)' : 'color:var(--text2)'}`;
      const name = document.createElement('span');
      name.textContent = label;
      const price = document.createElement('span');
      price.textContent = formatCurrency(value, currency);
      price.style.whiteSpace = 'nowrap';
      row.append(name, price);
      container.appendChild(row);
    });
    if (amount.taxIsEstimate) {
      const note = document.createElement('p');
      note.textContent = 'This flat tax is an estimate based on the base price; actual tax may vary by location.';
      note.style.cssText = 'margin:8px 0 0;font-size:.74rem;color:var(--text3)';
      container.appendChild(note);
    }
    return amount;
  }

  window.StarBookOrderPricing = { initialize, calculate, formatUSD, formatCurrency, renderBreakdown };
})();
