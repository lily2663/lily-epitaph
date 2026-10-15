import { loadLegacyHighlighter } from './legacy-highlighter.js';

const legacyArticleQueues = new WeakMap();
const activeLegacyQueues = new Set();
let legacyPageSwapBound = false;

function createLegacyQueue(articleBody) {
  const pending = new Map();
  const targets = new Map();
  const ready = new Set();
  let cancelled = false;
  let loading = false;
  let highlighter = null;
  let scheduled = null;
  let idleCallback = false;
  let observer = null;

  function release(code) {
    const pre = pending.get(code);
    if (pre) {
      observer?.unobserve(pre);
      targets.delete(pre);
    }
    pending.delete(code);
    ready.delete(code);
  }

  function cancel() {
    cancelled = true;
    observer?.disconnect();
    if (scheduled !== null) {
      if (idleCallback && typeof cancelIdleCallback === 'function') cancelIdleCallback(scheduled);
      else if (!idleCallback) clearTimeout(scheduled);
    }
    scheduled = null;
    pending.clear();
    targets.clear();
    ready.clear();
    activeLegacyQueues.delete(queue);
    legacyArticleQueues.delete(articleBody);
  }

  function drain(deadline) {
    scheduled = null;
    if (cancelled) return;
    const started = performance.now();
    let processed = 0;
    // A single autodetection cannot be interrupted. Bound every slice by both
    // count and elapsed time, even when the browser reports a large idle budget.
    while (ready.size && processed < 2) {
      if (processed && (performance.now() - started >= 4
        || (deadline && !deadline.didTimeout && deadline.timeRemaining() < 1))) break;
      const code = ready.values().next().value;
      const pre = pending.get(code);
      ready.delete(code);
      if (pre && code.isConnected && pre.isConnected && pre.contains(code) && !code.dataset.highlighted) {
        try {
          highlighter.highlightElement(code);
          if (code.result?.language) pre.dataset.language = code.result.language;
        } catch {
          // Keep readable/copyable code; a later enhancement can retry this block.
        }
        processed++;
      }
      release(code);
    }
    if (!pending.size) cancel();
    else schedule();
  }

  function schedule() {
    if (cancelled || scheduled !== null || loading || !ready.size) return;
    if (!highlighter) {
      loading = true;
      void loadLegacyHighlighter().then((runtime) => {
        loading = false;
        if (cancelled) return;
        highlighter = runtime;
        schedule();
      }).catch(() => {
        // Retry on another intersection or enhance call, never in a tight loop.
        loading = false;
      });
      return;
    }
    idleCallback = typeof requestIdleCallback === 'function';
    scheduled = idleCallback
      ? requestIdleCallback(drain, { timeout: 150 })
      : setTimeout(() => drain(), 16);
  }

  if (typeof window.IntersectionObserver === 'function') {
    observer = new window.IntersectionObserver((entries) => {
      for (const entry of entries) {
        const code = targets.get(entry.target);
        if (!code) continue;
        if (entry.isIntersecting) ready.add(code);
        else ready.delete(code);
      }
      schedule();
    }, { rootMargin: '600px 0px' });
  }

  const queue = {
    cancel,
    add(code, pre) {
      if (cancelled || code.dataset.highlighted || !code.isConnected || !pre.isConnected) return;
      if (!pending.has(code)) {
        pending.set(code, pre);
        targets.set(pre, code);
        if (observer) observer.observe(pre);
        else ready.add(code);
      }
      schedule();
    },
  };
  activeLegacyQueues.add(queue);
  return queue;
}

function highlightLegacyCode(articleBody, code, pre) {
  if (code.dataset.highlighted) return;
  if (!legacyPageSwapBound) {
    document.addEventListener('lily:before-page-swap', () => {
      for (const queue of activeLegacyQueues) queue.cancel();
    });
    legacyPageSwapBound = true;
  }
  let queue = legacyArticleQueues.get(articleBody);
  if (!queue) {
    queue = createLegacyQueue(articleBody);
    legacyArticleQueues.set(articleBody, queue);
  }
  queue.add(code, pre);
}

export function ensureHeadingIds(articleBody) {
  const used = new Set([...document.querySelectorAll('[id]')].map((element) => element.id));
  return [...articleBody.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((heading, index) => {
    if (!heading.id) {
      const base = heading.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || `section-${index + 1}`;
      let id = base;
      let suffix = 2;
      while (used.has(id)) id = `${base}-${suffix++}`;
      heading.id = id;
      used.add(id);
    }
    return heading;
  });
}

export function enhanceArticleBody(articleBody) {
  if (!articleBody) return;
  ensureHeadingIds(articleBody);
  articleBody.querySelectorAll('img').forEach((image) => {
    if (!image.hasAttribute('loading')) image.loading = 'lazy';
    if (!image.hasAttribute('decoding')) image.decoding = 'async';
    if (!image.closest('a[href]')) {
      image.tabIndex = 0;
      image.setAttribute('role', 'button');
      image.setAttribute('aria-haspopup', 'dialog');
      image.setAttribute('aria-label', image.alt ? `查看大图：${image.alt}` : '查看大图');
    }
  });

  articleBody.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    const language = code ? [...code.classList].find((name) => name.startsWith('language-'))?.slice(9) : '';
    if (language) pre.dataset.language = language;
    else if (code) highlightLegacyCode(articleBody, code, pre);

    if (document.body.dataset.codeCopy === 'false') return;
    if (pre.dataset.codeEnhanced === 'true') return;
    pre.dataset.codeEnhanced = 'true';

    const button = document.createElement('button');
    button.className = 'code-copy';
    button.type = 'button';
    button.textContent = '复制';

    button.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        const copy = pre.cloneNode(true);
        copy.querySelectorAll('.code-copy').forEach((control) => control.remove());
        await navigator.clipboard.writeText(code?.textContent ?? copy.textContent);
        button.textContent = '已复制';
      } catch {
        button.textContent = '请手动复制';
      }
      setTimeout(() => { button.textContent = '复制'; }, 1200);
    });
    pre.append(button);
  });
}

export function buildArticleToc(articleBody, toc) {
  if (!articleBody || !toc) return false;
  const headings = ensureHeadingIds(articleBody);
  const wrapper = toc.closest('.toc-wrap');
  toc.replaceChildren();
  if (!headings.length) {
    if (wrapper) wrapper.hidden = true;
    return false;
  }

  const root = document.createElement('ol');
  root.className = 'toc-list';
  headings.forEach((heading) => {
    const item = document.createElement('li');
    item.className = 'toc-item';
    item.dataset.level = heading.tagName.slice(1);
    const link = document.createElement('a');
    link.className = 'toc-link';
    link.href = `#${heading.id}`;
    link.textContent = heading.textContent;
    item.append(link);
    root.append(item);
  });
  toc.append(root);

  if (wrapper) {
    wrapper.hidden = false;
    if (!wrapper.querySelector('.toc-toggle')) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'toc-toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = '展开文章目录';
      toggle.addEventListener('click', () => {
        const open = wrapper.classList.toggle('open');
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? '收起文章目录' : '展开文章目录';
      });
      wrapper.insertBefore(toggle, toc);
      wrapper.classList.add('has-toc-toggle');
    }
  }
  return true;
}

export function installArticleLightbox() {
  const box = document.createElement('dialog');
  box.className = 'lightbox';
  box.setAttribute('aria-label', '图片预览');
  box.innerHTML = '<button type="button" aria-label="关闭图片">×</button><img alt="">';
  let trigger = null;

  const restoreTrigger = () => {
    if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    trigger = null;
  };

  box.addEventListener('close', () => {
    box.classList.remove('active');
    box.querySelector('img').removeAttribute('src');
    restoreTrigger();
  });
  box.querySelector('button').addEventListener('click', () => box.close());
  box.addEventListener('click', (event) => { if (event.target === box) box.close(); });
  document.body.append(box);

  const open = (image) => {
    trigger = image;
    const preview = box.querySelector('img');
    preview.src = image.dataset.originalSrc || image.currentSrc || image.src;
    preview.alt = image.alt || '图片预览';
    box.showModal();
    box.classList.add('active');
    box.querySelector('button')?.focus({ preventScroll: true });
  };

  document.addEventListener('click', (event) => {
    const image = event.target.closest('.article-body img');
    if (!image || image.closest('a[href]')) return;
    open(image);
  });
  document.addEventListener('keydown', (event) => {
    if (!['Enter', ' '].includes(event.key) || !(event.target instanceof HTMLImageElement)) return;
    const image = event.target.closest('.article-body img');
    if (!image || image.closest('a[href]')) return;
    event.preventDefault();
    open(image);
  });
}
