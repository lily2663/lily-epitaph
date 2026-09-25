(() => {
  const box = document.querySelector('[data-protected-id]');
  if (!box) return;
  const status = box.querySelector('.lock-status');
  const body = document.querySelector('[data-protected-body]');
  const layout = document.querySelector('[data-protected-layout]');
  const toc = document.querySelector('[data-protected-toc] .toc');
  const password = box.querySelector('#protected-password');
  const unlockButton = box.querySelector('[data-unlock]');
  const MAX_PAYLOAD_TEXT = 8 * 1024 * 1024;
  const MAX_CIPHERTEXT_BYTES = 5 * 1024 * 1024;
  const EXPECTED_ITERATIONS = 600000;
  const lifecycle = new AbortController();
  document.addEventListener('lily:before-page-swap', () => lifecycle.abort(), { once: true });
  let busy = false;

  function requestSignal(timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return typeof AbortSignal.any === 'function'
      ? AbortSignal.any([lifecycle.signal, timeout])
      : timeout;
  }

  function decodeBase64(value, label, expectedLength = null, maxLength = Infinity) {
    if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`${label} invalid`);
    const raw = atob(value);
    if (expectedLength != null && raw.length !== expectedLength) throw new Error(`${label} length invalid`);
    if (raw.length > maxLength) throw new Error(`${label} too large`);
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }

  function validatePayload(payload) {
    if (!payload || typeof payload !== 'object' || payload.version !== 2 || payload.pageId !== box.dataset.protectedId) throw new Error('unsupported payload');
    if (payload.kdf?.name !== 'PBKDF2' || payload.kdf?.hash !== 'SHA-256' || payload.kdf?.iterations !== EXPECTED_ITERATIONS) throw new Error('unsupported kdf');
    if (payload.cipher?.name !== 'AES-256-GCM') throw new Error('unsupported cipher');
    return {
      salt: decodeBase64(payload.kdf.salt, 'salt', 16),
      iv: decodeBase64(payload.cipher.iv, 'iv', 12),
      tag: decodeBase64(payload.cipher.tag, 'tag', 16),
      data: decodeBase64(payload.cipher.data, 'ciphertext', null, MAX_CIPHERTEXT_BYTES),
    };
  }

  function runtimeReady(src) {
    if (src.includes('marked')) return Boolean(window.marked?.parse);
    if (src.includes('highlight')) return Boolean(window.hljs?.highlightElement);
    if (src.includes('purify')) return Boolean(window.DOMPurify?.sanitize);
    return false;
  }

  const loadScript = (src) => new Promise((resolve, reject) => {
    if (runtimeReady(src)) { resolve(); return; }
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });

  async function readTextLimited(response, maxBytes) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('payload too large');
    if (!response.body?.getReader) {
      const text = await response.text();
      if (new TextEncoder().encode(text).length > maxBytes) throw new Error('payload too large');
      return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error('payload too large');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } finally {
      reader.releaseLock?.();
    }
  }

  async function loadPayload() {
    const response = await fetch(box.dataset.payload, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: requestSignal(10000),
    });
    if (!response.ok) throw new Error(`payload HTTP ${response.status}`);
    return JSON.parse(await readTextLimited(response, MAX_PAYLOAD_TEXT));
  }

  async function unlock() {
    if (busy) return;
    const value = password.value;
    if (!value) { status.textContent = '请输入密码。'; return; }
    busy = true;
    unlockButton.disabled = true;
    status.textContent = '正在解锁…';
    try {
      if (!crypto?.subtle) throw new Error('Web Crypto unavailable');
      const payload = await loadPayload();
      const encoded = validatePayload(payload);
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: encoded.salt, iterations: EXPECTED_ITERATIONS, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      );
      const joined = new Uint8Array(encoded.data.length + encoded.tag.length);
      joined.set(encoded.data);
      joined.set(encoded.tag, encoded.data.length);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encoded.iv }, key, joined);
      const markdown = new TextDecoder().decode(plain);
      status.textContent = '正在渲染文章…';
      await Promise.all([
        loadScript('/assets/vendor/marked.min.js'),
        loadScript('/assets/vendor/highlight.min.js'),
        loadScript('/assets/vendor/purify.min.js'),
      ]);
      if (lifecycle.signal.aborted) return;
      if (!window.marked?.parse || !window.DOMPurify?.sanitize) throw new Error('markdown runtime unavailable');
      const rendered = window.marked.parse(markdown, { gfm: true, breaks: false });
      body.innerHTML = window.DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
      body.querySelectorAll('pre code').forEach((code) => window.hljs?.highlightElement(code));
      if (!window.LilyArticle) throw new Error('article helpers unavailable');
      window.LilyArticle.enhance(body);
      window.LilyArticle.buildToc(body, toc);
      window.LilyArticle.setupTocSpy(body, toc);
      layout.hidden = false;
      box.hidden = true;
      password.value = '';
    } catch {
      if (lifecycle.signal.aborted) return;
      status.textContent = '密码错误或文章数据无法解锁。';
      busy = false;
      unlockButton.disabled = false;
    }
  }

  unlockButton.addEventListener('click', unlock);
  password.addEventListener('keydown', (event) => { if (event.key === 'Enter') unlock(); });
})();
