// Loads public checkout options without exposing API secrets.
window.loadPaymentOptions = async function loadPaymentOptions() {
  try {
    const response = await fetch('/api/payment-options', { cache: 'no-store' });
    const options = await response.json();
    if (!response.ok) throw new Error(options.message || 'Payment options unavailable');
    if (typeof COINS !== 'undefined' && options.wallets) {
      COINS.forEach(coin => { if (options.wallets[coin.key]) coin.addr = options.wallets[coin.key]; });
      if (typeof renderCoinGrid === 'function') renderCoinGrid(COINS);
    }
    const format = (label, value) => `<div><strong>${escapeHTML(label)}:</strong> ${escapeHTML(value || 'Not configured')}</div>`;
    document.getElementById('bankTransferDetails').innerHTML = '<div style="padding:12px;border:1px solid rgba(239,68,68,.35);border-radius:10px"><h4>🔧 Bank Transfer Unavailable</h4><p>Bank Transfer is temporarily unavailable while we complete maintenance. Please choose another available payment method and try again later.</p><p>Please choose Gift Card or Cryptocurrency instead.</p></div>';
    document.getElementById('cashAppDetails').innerHTML = '<div style="padding:12px;border:1px solid rgba(239,68,68,.35);border-radius:10px"><h4>🔧 CashApp Temporarily Unavailable</h4><p>CashApp payments are temporarily suspended. Please use Gift Card or Crypto payment instead.</p><strong>🔴 Service suspended — try gift card or crypto</strong></div>';
    document.getElementById('paypalDetails').innerHTML = '<div style="padding:12px;border:1px solid rgba(245,158,11,.35);border-radius:10px"><h4>⚙️ Mobile Wallet Unavailable</h4><p>Mobile Wallet services are under maintenance. Please choose Gift Card or Cryptocurrency instead.</p></div>';
    document.querySelectorAll('#payTabBar .tab-btn').forEach(button => {
      const option = options.methods?.find(item => item.id === button.dataset.tab);
      if (option && !option.enabled && !option.maintenance) {
        button.disabled = true;
        button.title = 'This payment method is not currently available';
      }
    });
  } catch (error) {
    ['bankTransferDetails','cashAppDetails','paypalDetails'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent='Payment instructions could not be loaded. Please refresh or contact support.'; });
  }
}
