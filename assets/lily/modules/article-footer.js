(() => {
  const binding = Symbol.for('lily.article-footer.events');
  if (document[binding]) return;
  document[binding] = true;

  // Delegation covers the initial article and every PJAX replacement.
  document.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-copy-permalink]');
    if (!button || button.disabled) return;
    const share = button.closest('[data-article-share]');
    const input = share?.querySelector('[data-permalink-input]');
    const status = share?.querySelector('[data-permalink-status]');
    const fallback = share?.querySelector('[data-permalink-fallback]');
    if (!input || !status || !fallback) return;
    button.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(input.value);
      if (!share.isConnected) return;
      fallback.hidden = true;
      status.textContent = '链接已复制。';
    } catch {
      if (!share.isConnected) return;
      fallback.hidden = false;
      status.textContent = '复制未完成，请选中下方永久链接后手动复制。';
      input.focus();
      input.select();
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
})();
