export function setupDrawerPagination() {
  document.querySelectorAll('[data-drawer-pagination]').forEach((pagination) => {
    const drawer = pagination.closest('.drawer');
    if (!drawer) return;
    const cards = [...drawer.querySelectorAll('[data-drawer-grid] > .post-item')];
    const totalPages = Math.max(1, Math.ceil(cards.length / 10));
    let page = 1;

    const renderPage = () => {
      cards.forEach((card, index) => {
        card.hidden = index < (page - 1) * 10 || index >= page * 10;
      });
      pagination.querySelector('[data-drawer-page]').textContent = `${page} / ${totalPages}`;
      pagination.querySelector('[data-drawer-prev]').disabled = page === 1;
      pagination.querySelector('[data-drawer-next]').disabled = page === totalPages;
    };

    pagination.querySelector('[data-drawer-prev]').onclick = () => {
      if (page <= 1) return;
      page -= 1;
      renderPage();
      drawer.querySelector('summary')?.scrollIntoView({ block: 'start' });
    };
    pagination.querySelector('[data-drawer-next]').onclick = () => {
      if (page >= totalPages) return;
      page += 1;
      renderPage();
      drawer.querySelector('summary')?.scrollIntoView({ block: 'start' });
    };
    renderPage();
  });
}
