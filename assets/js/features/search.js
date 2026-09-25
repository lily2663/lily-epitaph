export function createPostSearch({ attachPixelSprite }) {
  const search = document.querySelector('#search');
  const searchStatus = document.querySelector('#search-status');
  let grid = null;
  let searchTitle = null;
  let searchCount = null;
  let searchEmpty = null;
  let searchIndex;
  let searchTimer;
  let searchGrid = null;
  let originalPostCards = [];
  let mode = 'article';

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
    searchIndex ||= fetch('/index.json', { credentials: 'same-origin' })
      .then((response) => response.ok ? response.json() : [])
      .then((entries) => Array.isArray(entries) ? entries : [])
      .catch(() => []);
    const entries = await searchIndex;
    if (grid !== searchGrid || query !== search.value.trim().toLowerCase() || mode !== activeMode) return;

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
      excerpt.textContent = item?.protected ? '该文章已加密，需输入密码查看。' : String(item?.summary || '').slice(0, 140);
      link.append(kicker, title, excerpt);
      card.append(link);
      attachPixelSprite(card);
      return card;
    });
    grid.replaceChildren(...cards);
    updateSearchState(search.value.trim(), matches.length, Number(grid.dataset.postTotal) || originalPostCards.length);
  }

  document.querySelectorAll('[data-search-mode]').forEach((button) => button.addEventListener('click', () => {
    mode = button.dataset.searchMode;
    document.querySelectorAll('[data-search-mode]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    if (search) {
      search.placeholder = mode === 'text' ? '搜索公开文章全文…' : '搜索文章标题/标签…';
      void filterPosts();
    }
  }));

  search?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void filterPosts(), 80);
  });
  search?.addEventListener('keydown', (event) => {
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
    grid = document.querySelector('[data-post-grid]');
    searchTitle = document.querySelector('[data-search-title]');
    searchCount = document.querySelector('[data-search-count]');
    searchEmpty = document.querySelector('.search-empty');
    if (grid && search?.value.trim()) void filterPosts();
  }

  return { refreshPageBindings, filterPosts };
}
