import { attachPixelSprite } from './features/pixel-sprite.js';
import { initSiteShell } from './features/site-shell.js';
import { buildArticleToc, enhanceArticleBody, ensureHeadingIds, installArticleLightbox } from './features/article.js';
import { installPjaxNavigation } from './features/pjax.js';
import { createPostSearch } from './features/search.js';
import { installOfflineCache } from './features/offline.js';
import { setupDrawerPagination } from './features/drawers.js';

(() => {
  'use strict';
  const root = document.documentElement;
  const siteHeader = document.querySelector('.site-header');
  initSiteShell({ root, siteHeader });
  const topButton = document.querySelector('#to-top');
  const progress = document.querySelector('#reading-progress');
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

  const postSearch = createPostSearch({ attachPixelSprite });

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

  // 页面级初始化：首次加载与每次 pjax 替换 #app 后都要执行
  function initPage() {
    tocLastUpdate = 0;
    postSearch.refreshPageBindings();
    document.querySelectorAll('.article-body').forEach(enhanceArticleBody);
    // 非受保护文章：用 JS 统一重建目录（与受保护文章一致），
    // 替换 Hugo 原生目录的嵌套 nav/空 li/类名不匹配，并接入滚动定位
    articleBody = document.querySelector('.article-body:not([data-protected-body])');
    articleHeadings = articleBody ? tocHeadings(articleBody) : [];
    articleToc = document.querySelector('.toc-wrap:not([data-protected-toc]) .toc');
    if (articleBody && articleToc) window.LilyArticle.buildToc(articleBody, articleToc);
    document.querySelectorAll('.front-grid .post-item').forEach(attachPixelSprite);
    setupDrawerPagination();
    updateScroll();
    document.dispatchEvent(new CustomEvent('lily:page-ready'));
  }

  const { flashFade } = installPjaxNavigation({ initPage, updateScroll });

  installOfflineCache();

  initPage();
  flashFade();
})();
