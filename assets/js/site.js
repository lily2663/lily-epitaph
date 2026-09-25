import { attachPixelSprite } from './features/pixel-sprite.js';
import { initSiteShell } from './features/site-shell.js';
import { buildArticleToc, enhanceArticleBody, ensureHeadingIds, installArticleLightbox } from './features/article.js';
import { installPjaxNavigation } from './features/pjax.js';

(() => {
  'use strict';
  const root = document.documentElement;
  const siteHeader = document.querySelector('.site-header');
  initSiteShell({ root, siteHeader });
  const topButton = document.querySelector('#to-top');
  const progress = document.querySelector('#reading-progress');
  const search = document.querySelector('#search');
  // 页面级引用：pjax 替换 #app 后由 initPage() 重新获取
  let grid = document.querySelector('[data-post-grid]');
  const searchStatus = document.querySelector('#search-status');
  let searchTitle = document.querySelector('[data-search-title]');
  let searchCount = document.querySelector('[data-search-count]');
  let searchEmpty = document.querySelector('.search-empty');
  let mode = 'article';
  // 当前文章正文与目录引用：initPage 设置，受保护文章解锁后由 setupTocSpy 接管
  let articleBody = null;
  let articleToc = null;
  let articleHeadings = [];

  let scrollFrame = 0;
  let tocLastUpdate = 0;
  function updateScroll() {
    scrollFrame = 0;
    const max = document.documentElement.scrollHeight - innerHeight;
    const pct = max > 0 ? scrollY / max : 0;
    if (progress) {
      progress.style.width = `${pct * 100}%`;
      progress.classList.toggle('show', !!document.querySelector('article.article') && pct > 0.02);
    }
    if (topButton) topButton.classList.toggle('show', scrollY > 500);
    // TOC highlighting reads every heading's layout box. Keep the progress
    // indicator frame-accurate, but cap this layout-heavy work while scrolling.
    const now = performance.now();
    if (!tocLastUpdate || now - tocLastUpdate >= 80) {
      tocLastUpdate = now;
      updateTocActive();
    }
  }
  function onScroll() { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll); }
  addEventListener('scroll', onScroll, { passive: true });
  updateScroll();
  topButton?.addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));

  document.querySelectorAll('[data-search-mode]').forEach((button) => button.addEventListener('click', () => {
    mode = button.dataset.searchMode;
    document.querySelectorAll('[data-search-mode]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    if (search) {
      search.placeholder = mode === 'text' ? '搜索公开文章全文…' : '搜索文章标题/标签…';
      filterPosts();
    }
  }));
  let searchIndex;
  let searchTimer;
  let searchGrid = null;
  let originalPostCards = [];
  function updateSearchState(query, visible, total) {
    if (!query) {
      if (searchTitle) searchTitle.textContent = '全部文章';
      if (searchCount) searchCount.textContent = `${total} 篇`;
      if (searchEmpty) searchEmpty.hidden = true;
      if (searchStatus) searchStatus.textContent = '';
      return;
    }
    if (searchTitle) searchTitle.textContent = `“${query}”`;
    if (searchCount) searchCount.textContent = `${visible} 个结果`;
    if (searchEmpty) {
      searchEmpty.hidden = visible !== 0;
      searchEmpty.textContent = `没有找到与 “${query}” 匹配的文章。`;
    }
    if (searchStatus) searchStatus.textContent = `找到 ${visible} 篇文章。`;
  }
  async function filterPosts() {
    if (!grid || !search) return;
    const q = search.value.trim().toLowerCase();
    if (searchGrid !== grid) { searchGrid = grid; originalPostCards = [...grid.children]; }
    const pagination = document.querySelector('[data-post-pagination]');
    if (!q) {
      grid.replaceChildren(...originalPostCards);
      if (pagination) pagination.hidden = false;
      updateSearchState('', originalPostCards.length, Number(grid.dataset.postTotal) || originalPostCards.length);
      return;
    }
    if (pagination) pagination.hidden = true;
    const activeMode = mode;
    searchIndex ||= fetch('/index.json').then((response) => response.ok ? response.json() : []).catch(() => []);
    const entries = await searchIndex;
    if (grid !== searchGrid || q !== search.value.trim().toLowerCase() || mode !== activeMode) return;
    const matches = entries.filter((item) => {
      const base = `${item.title || ''} ${(item.tags || []).join(' ')} ${item.summary || ''}`;
      return `${base} ${activeMode === 'text' ? item.text || '' : ''}`.toLowerCase().includes(q);
    });
    const cards = matches.map((item) => {
      const card = document.createElement('article');
      card.className = 'post-item';
      card.dataset.search = '';
      const link = document.createElement('a');
      link.className = 'post-link';
      const url = new URL(item.url || '/', location.origin);
      link.href = url.origin === location.origin ? url.pathname + url.search + url.hash : '/';
      const kicker = document.createElement('div');
      kicker.className = 'kicker';
      kicker.textContent = item.tags?.[0] || '随笔';
      const title = document.createElement('h3');
      title.className = 'item-title';
      title.textContent = item.title || '未命名文章';
      const excerpt = document.createElement('p');
      excerpt.className = 'item-excerpt';
      excerpt.textContent = item.protected ? '该文章已加密，需输入密码查看。' : (item.summary || '').slice(0, 140);
      link.append(kicker, title, excerpt);
      card.append(link);
      attachPixelSprite(card);
      return card;
    });
    grid.replaceChildren(...cards);
    updateSearchState(search.value.trim(), matches.length, Number(grid.dataset.postTotal) || originalPostCards.length);
  }
  search?.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => void filterPosts(), 80); });
  search?.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    const firstResult = grid?.querySelector('[data-search]:not([hidden]) a');
    if (firstResult) { event.preventDefault(); firstResult.focus(); }
  });
  document.addEventListener('keydown', (event) => {
    if (!search || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const editable = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
    if (event.key === '/' && !editable) { event.preventDefault(); search.focus(); }
    if (event.key === 'Escape' && document.activeElement === search) { search.value = ''; void filterPosts(); search.blur(); }
  });

  installArticleLightbox();

  const tocHeadings = ensureHeadingIds;

  // 滚动定位：当前阅读到的标题在目录中高亮
  function updateTocActive() {
    const body = articleBody;
    const toc = articleToc;
    if (!body || !toc) return;
    const headings = articleHeadings;
    const links = toc.querySelectorAll('.toc-link');
    if (!headings.length || !links.length) return;
    let current = '';
    const threshold = (siteHeader?.getBoundingClientRect().height || 64) + 20;
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= threshold) current = heading.id;
      else break;
    }
    links.forEach((link) => {
      const active = link.getAttribute('href') === `#${current}`;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }

  // 受保护文章解锁后由 protected.js 调用，接入同一套滚动定位
  function setupTocSpy(body, toc) {
    articleBody = body;
    articleToc = toc;
    articleHeadings = tocHeadings(body);
    updateTocActive();
  }

  window.LilyArticle = Object.freeze({ enhance: enhanceArticleBody, buildToc: buildArticleToc, setupTocSpy });

  function setupDrawerPagination() {
    document.querySelectorAll('[data-drawer-pagination]').forEach((pagination) => {
      const drawer = pagination.closest('.drawer');
      const cards = [...drawer.querySelectorAll('[data-drawer-grid] > .post-item')];
      const totalPages = Math.ceil(cards.length / 10);
      let page = 1;
      const renderPage = () => {
        cards.forEach((card, index) => { card.hidden = index < (page - 1) * 10 || index >= page * 10; });
        pagination.querySelector('[data-drawer-page]').textContent = `${page} / ${totalPages}`;
        pagination.querySelector('[data-drawer-prev]').disabled = page === 1;
        pagination.querySelector('[data-drawer-next]').disabled = page === totalPages;
      };
      pagination.querySelector('[data-drawer-prev]').onclick = () => { if (page > 1) { page--; renderPage(); drawer.querySelector('summary')?.scrollIntoView({ block: 'start' }); } };
      pagination.querySelector('[data-drawer-next]').onclick = () => { if (page < totalPages) { page++; renderPage(); drawer.querySelector('summary')?.scrollIntoView({ block: 'start' }); } };
      renderPage();
    });
  }

  // 页面级初始化：首次加载与每次 pjax 替换 #app 后都要执行
  function initPage() {
    tocLastUpdate = 0;
    grid = document.querySelector('[data-post-grid]');
    searchTitle = document.querySelector('[data-search-title]');
    searchCount = document.querySelector('[data-search-count]');
    searchEmpty = document.querySelector('.search-empty');
    document.querySelectorAll('.article-body').forEach(enhanceArticleBody);
    // 非受保护文章：用 JS 统一重建目录（与受保护文章一致），
    // 替换 Hugo 原生目录的嵌套 nav/空 li/类名不匹配，并接入滚动定位
    articleBody = document.querySelector('.article-body:not([data-protected-body])');
    articleHeadings = articleBody ? tocHeadings(articleBody) : [];
    articleToc = document.querySelector('.toc-wrap:not([data-protected-toc]) .toc');
    if (articleBody && articleToc) window.LilyArticle.buildToc(articleBody, articleToc);
    document.querySelectorAll('.front-grid .post-item').forEach(attachPixelSprite);
    setupDrawerPagination();
    if (grid && search?.value.trim()) void filterPosts();
    updateScroll();
    document.dispatchEvent(new CustomEvent('lily:page-ready'));
  }

  const { flashFade } = installPjaxNavigation({ initPage, updateScroll });

  // GitHub Pages 的静态资源缓存时间较短。生产环境用轻量 Service Worker
  // 把访问过的页面与资源留在本机，后续访问先显示缓存、后台再更新。
  const isLocalPreview = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !isLocalPreview) {
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

  initPage();
  flashFade();
})();
