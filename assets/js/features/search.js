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
      title.textContent = item?.title || '未命名文章';
      const excerpt = document.createElement('p');
      excerpt.className = 'item-excerpt';
      excerpt.textContent = item?.protected
        ? (item.protectionEnabled === false ? '该受保护文章暂时不可阅读，功能维护中。' : '该文章已加密，需输入密码查看。')
        : String(item?.summary || '').slice(0, 140);
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
    // Other pages use a normal GET navigation; search works throughout the site
    // without replacing an article's content with an ad-hoc results container.
    if (!grid) return;
    event.preventDefault();
    clearTimeout(searchTimer);
    void filterPosts();
  });

  search?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void filterPosts(), 80);
  });
  search?.addEventListener('keydown', (event) => {
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
    if (!search || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
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
