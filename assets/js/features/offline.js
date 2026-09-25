export function installOfflineCache() {
  const isLocalPreview = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:' || isLocalPreview) return;

  addEventListener('load', () => {
    const syncOfflineCache = async () => {
      if (document.body.dataset.offlineCache !== 'false') {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration('/');
      await registration?.unregister();
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith('lily-runtime-')).map((key) => caches.delete(key)));
      }
    };
    const run = () => syncOfflineCache().catch(() => {});
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2500 });
    else setTimeout(run, 800);
  }, { once: true });
}
