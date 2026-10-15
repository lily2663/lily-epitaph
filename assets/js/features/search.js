export function createPostSearch({ attachPixelSprite }) {
  const search = document.querySelector('#search');
  const searchStatus = document.querySelector('#search-status');
  const searchForm = document.querySelector('[data-site-search]');
  const modeField = document.querySelector('[data-search-mode-field]');
  let grid = null;
  let searchTitle = null;
  let searchCount = null;
  let searchEmpty = null;
  let searchHint = null;
  let dedicatedPage = false;
  let searchIndex;
  let searchTimer;
  let searchVersion = 0;
  let searchGrid = null;
  let originalPostCards = [];
  let mode = 'article';
  let composing = false;

  function syncSearchUrl() {
    if (!dedicatedPage || !search) return;
    const url = new URL(location.href);
    const query = search.value.trim();
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    url.searchParams.set('mode', mode);
    // Editing a query updates this history entry, without adding one per key.
    // Keep PJAX's scroll state so returning from an article restores the page.
    if (url.href !== location.href) {
      try {
        history.replaceState(history.state, '', url.href);
        document.dispatchEvent(new CustomEvent('lily:search-url-change'));
      } catch { /* Search still works if history is unavailable. */ }
    }
  }

  function appendHighlighted(node, text, query) {
    const value = String(text || '');
    const needle = query.toLowerCase();
    const lower = value.toLowerCase();
    let start = 0;
    let found = needle ? lower.indexOf(needle) : -1;
    while (found !== -1) {
      node.append(document.createTextNode(value.slice(start, found)));
      const mark = document.createElement('mark');
      mark.textContent = value.slice(found, found + query.length);
      node.append(mark);
      start = found + query.length;
      found = lower.indexOf(needle, start);
    }
    node.append(document.createTextNode(value.slice(start)));
  }

  function resultExcerpt(item, query, activeMode) {
    const summary = String(item?.summary || '').replace(/\s+/g, ' ').trim();
    const body = activeMode === 'text' ? String(item?.text || '').replace(/\s+/g, ' ').trim() : '';
    const text = summary.toLowerCase().includes(query) ? summary
      : (body.toLowerCase().includes(query) ? body : summary);
    const hit = text.toLowerCase().indexOf(query);
    const start = Math.max(0, hit - 45);
    const end = Math.min(text.length, Math.max(start + 140, hit + query.length));
    return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  }

  function updateSearchState(query, visible, total) {
    if (!query) {
      if (searchTitle) searchTitle.textContent = dedicatedPage ? '搜索文章' : '全部文章';
      if (searchCount) searchCount.textContent = dedicatedPage ? `${total} 篇可搜索` : `${total} 篇`;
      if (searchEmpty) searchEmpty.hidden = true;
      if (searchHint) searchHint.hidden = false;
      if (searchStatus) searchStatus.textContent = '';
      return;
    }
    if (searchTitle) searchTitle.textContent = `“${query}”`;
    if (searchHint) searchHint.hidden = true;
    if (searchCount) searchCount.textContent = `${visible} 个结果`;
    if (searchEmpty) {
      searchEmpty.hidden = visible !== 0;
      searchEmpty.textContent = `没有找到与 “${query}” 匹配的文章。`;
    }
    if (searchStatus) searchStatus.textContent = `找到 ${visible} 篇文章。`;
  }

  async function filterPosts() {
    const version = ++searchVersion;
    if (!search) return;
    if (composing) return;
    syncSearchUrl();
    if (!grid) {
      if (searchStatus) searchStatus.textContent = search.value.trim() ? '按 Enter 搜索全站。' : '';
      return;
    }
    const activeGrid = grid;
    const query = search.value.trim().toLowerCase();
    if (searchGrid !== grid) {
      searchGrid = grid;
      originalPostCards = [...grid.children];
    }
    const pagination = document.querySelector('[data-post-pagination]');
    if (!query) {
      grid.replaceChildren(...originalPostCards);
      if (pagination) pagination.hidden = false;
      updateSearchState('', originalPostCards.length, Number(grid.dataset.postTotal) || originalPostCards.length);
      return;
    }

    if (pagination) pagination.hidden = true;
    const activeMode = mode;
    if (searchStatus) searchStatus.textContent = '正在搜索…';
    if (searchEmpty) searchEmpty.hidden = true;
    if (searchHint) searchHint.hidden = true;
    searchIndex ||= fetch('/index.json', { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((entries) => {
        if (!Array.isArray(entries)) throw new Error('Invalid search index');
        return entries;
      })
      .catch((error) => {
        searchIndex = undefined;
        throw error;
      });
    const isCurrent = () => version === searchVersion && grid === activeGrid
      && query === search.value.trim().toLowerCase() && mode === activeMode;
    let entries;
    try {
      entries = await searchIndex;
    } catch {
      if (!isCurrent()) return;
      grid.replaceChildren();
      if (searchTitle) searchTitle.textContent = `“${search.value.trim()}”`;
      if (searchCount) searchCount.textContent = '暂不可用';
      const message = '搜索暂时不可用，请按 Enter 重试或修改关键词。';
      if (searchEmpty) {
        searchEmpty.hidden = false;
        searchEmpty.textContent = message;
      }
      if (searchStatus) searchStatus.textContent = message;
      return;
    }
    if (!isCurrent()) return;

    const matches = entries.filter((item) => {
      const tags = Array.isArray(item?.tags) ? item.tags : [];
      const base = `${item?.title || ''} ${tags.join(' ')} ${item?.summary || ''}`;
      return `${base} ${activeMode === 'text' ? item?.text || '' : ''}`.toLowerCase().includes(query);
    });

    const cards = matches.map((item) => {
      const card = document.createElement('article');
      card.className = 'post-item';
      card.dataset.search = '';
      const link = document.createElement('a');
      link.className = 'post-link';
      const url = new URL(item?.url || '/', location.origin);
      link.href = url.origin === location.origin ? url.pathname + url.search + url.hash : '/';
      const kicker = document.createElement('div');
      kicker.className = 'kicker';
      kicker.textContent = (Array.isArray(item?.tags) ? item.tags[0] : '') || '随笔';
      const title = document.createElement('h3');
      title.className = 'item-title';
      appendHighlighted(title, item?.title || '未命名文章', query);
      const excerpt = document.createElement('p');
      excerpt.className = 'item-excerpt';
      if (item?.protected) {
        excerpt.textContent = item.protectionEnabled === false
          ? '该受保护文章暂时不可阅读，功能维护中。' : '该文章已加密，需输入密码查看。';
      } else {
        appendHighlighted(excerpt, resultExcerpt(item, query, activeMode), query);
      }
      link.append(kicker, title, excerpt);
      card.append(link);
      attachPixelSprite(card);
      return card;
    });
    grid.replaceChildren(...cards);
    updateSearchState(search.value.trim(), matches.length, Number(grid.dataset.postTotal) || originalPostCards.length);
  }

  function setMode(value) {
    mode = value === 'text' ? 'text' : 'article';
    if (modeField) modeField.value = mode;
    document.querySelectorAll('[data-search-mode]').forEach((item) => {
      const active = item.dataset.searchMode === mode;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    if (search) search.placeholder = mode === 'text' ? '搜索公开文章全文…' : '搜索文章标题/标签…';
  }
  document.querySelectorAll('[data-search-mode]').forEach((button) => button.addEventListener('click', () => {
    setMode(button.dataset.searchMode);
    void filterPosts();
  }));

  searchForm?.addEventListener('submit', (event) => {
    if (composing) {
      event.preventDefault();
      return;
    }
    // Other pages use a normal GET navigation; search works throughout the site
    // without replacing an article's content with an ad-hoc results container.
    if (!grid) return;
    event.preventDefault();
    clearTimeout(searchTimer);
    void filterPosts();
  });

  function scheduleSearch() {
    clearTimeout(searchTimer);
    if (!composing) searchTimer = setTimeout(() => void filterPosts(), 80);
  }
  search?.addEventListener('compositionstart', () => {
    composing = true;
    ++searchVersion;
    clearTimeout(searchTimer);
  });
  search?.addEventListener('compositionend', () => {
    composing = false;
    scheduleSearch();
  });
  search?.addEventListener('input', (event) => {
    if (event.isComposing) return;
    scheduleSearch();
  });
  search?.addEventListener('keydown', (event) => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      if (!grid) return;
      event.preventDefault();
      clearTimeout(searchTimer);
      void filterPosts();
      return;
    }
    if (event.key !== 'ArrowDown') return;
    const firstResult = grid?.querySelector('[data-search]:not([hidden]) a');
    if (firstResult) {
      event.preventDefault();
      firstResult.focus();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (!search || composing || event.isComposing || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const editable = event.target instanceof HTMLElement
      && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
    if (event.key === '/' && !editable) {
      event.preventDefault();
      search.focus();
    }
    if (event.key === 'Escape' && document.activeElement === search) {
      search.value = '';
      void filterPosts();
      search.blur();
    }
  });

  function refreshPageBindings() {
    ++searchVersion;
    composing = false;
    clearTimeout(searchTimer);
    grid = document.querySelector('[data-post-grid]');
    if (search) {
      if (grid) search.setAttribute('aria-controls', grid.id || 'post-grid');
      else search.removeAttribute('aria-controls');
    }
    searchTitle = document.querySelector('[data-search-title]');
    searchCount = document.querySelector('[data-search-count]');
    searchEmpty = document.querySelector('.search-empty');
    searchHint = document.querySelector('[data-search-hint]');
    dedicatedPage = Boolean(document.querySelector('[data-search-page]'));
    if (dedicatedPage && search) {
      const params = new URLSearchParams(location.search || '');
      search.value = params.get('q') || '';
      setMode(params.get('mode'));
    }
    if (!grid && searchStatus) searchStatus.textContent = '';
    if (grid) void filterPosts();
  }

  return { refreshPageBindings, filterPosts };
}
