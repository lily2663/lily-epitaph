export function installPjaxNavigation({ initPage, updateScroll }) {
  const root = document.documentElement;
  const app = document.getElementById('app');
  const navigationProgress = document.querySelector('#navigation-progress');
  let navToken = 0;
  let navAbort = null;
  let navProgressTimer = 0;
  const pageCache = new Map();
  let fadeTimer = 0;
  let pathKey = location.pathname + location.search;

  history.scrollRestoration = 'manual';

  function syncPageScripts(newDoc) {
    const rerun = /\/js\/(comments|protected)\./;
    Array.from(newDoc.scripts).forEach((script) => {
      if (!script.src || !rerun.test(script.src)) return;
      document.querySelector(`script[src="${script.src}"]`)?.remove();
      const clone = document.createElement('script');
      clone.src = script.src;
      document.body.append(clone);
    });
  }

  function syncNav(pathname) {
    document.querySelectorAll('.nav a').forEach((link) => {
      if (new URL(link.href, location.href).pathname === pathname) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function pageKey(input) {
    const url = new URL(input, location.href);
    return `${url.pathname}${url.search}`;
  }

  function fetchPage(input, signal) {
    const key = pageKey(input);
    const cached = pageCache.get(key);
    if (cached) return cached;
    let request = fetch(input, { signal, credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .catch((error) => {
        if (pageCache.get(key) === request) pageCache.delete(key);
        throw error;
      });
    pageCache.set(key, request);
    while (pageCache.size > 8) pageCache.delete(pageCache.keys().next().value);
    return request;
  }

  function beginNavigation() {
    clearTimeout(navProgressTimer);
    app.classList.remove('leaving', 'fade');
    root.classList.add('is-navigating');
    app.setAttribute('aria-busy', 'true');
    if (!navigationProgress) return;
    navigationProgress.classList.remove('active', 'complete');
    void navigationProgress.offsetWidth;
    navigationProgress.classList.add('active');
  }

  function completeNavigation(token) {
    if (token !== navToken) return;
    app.removeAttribute('aria-busy');
    navigationProgress?.classList.add('complete');
    navProgressTimer = setTimeout(() => {
      if (token !== navToken) return;
      navigationProgress?.classList.remove('active', 'complete');
      root.classList.remove('is-navigating');
    }, 220);
  }

  function flashFade() {
    app.classList.remove('fade');
    void app.offsetWidth;
    app.classList.add('fade');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (!app.classList.contains('leaving')) app.classList.remove('fade');
    }, 260);
  }

  async function pjaxNavigate(url, { push = true, restore = 0 } = {}) {
    const token = ++navToken;
    navAbort?.abort();
    navAbort = new AbortController();
    beginNavigation();

    let doc;
    try {
      const html = await fetchPage(url, navAbort.signal);
      doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc.getElementById('app')) throw new Error('no app container');
    } catch (error) {
      if (token !== navToken || error.name === 'AbortError') return;
      completeNavigation(token);
      location.href = url;
      return;
    }
    if (token !== navToken) return;

    app.classList.add('leaving');
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    if (token !== navToken) return;

    if (push) history.replaceState({ scroll: scrollY }, '', location.href);
    app.classList.remove('leaving');
    document.dispatchEvent(new CustomEvent('lily:before-page-swap'));
    app.replaceChildren(...doc.getElementById('app').childNodes);
    document.title = doc.title;

    if (push) history.pushState({ scroll: 0 }, '', url);
    const navigated = new URL(url, location.href);
    pathKey = navigated.pathname + navigated.search;
    scrollTo(0, push ? 0 : restore);
    flashFade();
    syncNav(navigated.pathname);
    updateScroll();
    app.focus({ preventScroll: true });
    completeNavigation(token);

    const settle = () => {
      if (token !== navToken) return;
      initPage();
      if (push && navigated.hash) {
        const anchor = document.getElementById(decodeURIComponent(navigated.hash.slice(1)));
        anchor?.scrollIntoView({ block: 'start' });
      }
      syncPageScripts(doc);
    };
    if ('requestIdleCallback' in window) requestIdleCallback(settle, { timeout: 300 });
    else setTimeout(settle, 120);
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    const href = link.getAttribute('href') || '';
    if (/^(mailto:|tel:|javascript:)/.test(href)) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;

    if (url.pathname === location.pathname && url.search === location.search) {
      if (url.hash) {
        const anchorTarget = document.getElementById(decodeURIComponent(url.hash.slice(1)));
        if (anchorTarget) {
          event.preventDefault();
          history.replaceState({ scroll: scrollY }, '', location.href);
          history.pushState({ anchor: url.hash }, '', url.href);
          anchorTarget.scrollIntoView();
        }
      }
      return;
    }

    event.preventDefault();
    void pjaxNavigate(url.href);
  });

  addEventListener('popstate', (event) => {
    if (location.pathname + location.search === pathKey) {
      if (event.state?.anchor) {
        document.getElementById(decodeURIComponent(event.state.anchor.slice(1)))?.scrollIntoView();
      } else if (typeof event.state?.scroll === 'number') {
        scrollTo(0, event.state.scroll);
      }
      updateScroll();
      return;
    }
    void pjaxNavigate(location.href, { push: false, restore: event.state?.scroll || 0 });
  });

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const canPrefetch = document.body.dataset.prefetch !== 'false'
    && !coarsePointer
    && !connection?.saveData
    && !/2g/.test(connection?.effectiveType || '');
  const prefetched = new Set();
  const pendingPrefetch = new WeakMap();

  function prefetch(link) {
    if (!canPrefetch || !link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname === location.pathname || url.hash) return;
    const key = `${url.pathname}${url.search}`;
    if (prefetched.has(key)) return;
    prefetched.add(key);
    void fetchPage(url.href).catch(() => prefetched.delete(key));
  }

  function schedulePrefetch(link, delay = 120) {
    if (!canPrefetch || !link || pendingPrefetch.has(link)) return;
    const timer = setTimeout(() => {
      pendingPrefetch.delete(link);
      prefetch(link);
    }, delay);
    pendingPrefetch.set(link, timer);
  }

  document.addEventListener('pointerover', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) return;
    schedulePrefetch(link);
  }, { capture: true, passive: true });

  document.addEventListener('pointerout', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) return;
    const timer = pendingPrefetch.get(link);
    if (timer) {
      clearTimeout(timer);
      pendingPrefetch.delete(link);
    }
  }, { capture: true, passive: true });

  document.addEventListener('focusin', (event) => schedulePrefetch(event.target.closest('a[href]'), 0));

  return { flashFade };
}
