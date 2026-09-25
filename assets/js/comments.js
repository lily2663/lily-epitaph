(() => {
  const host = document.querySelector('#comment-container');
  if (!host) return;
  const api = host.dataset.commentApi?.replace(/\/$/, '');
  if (!api) return;
  const page = host.dataset.commentId;
  const lifecycle = new AbortController();
  document.addEventListener('lily:before-page-swap', () => lifecycle.abort(), { once: true });

  function requestSignal(timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return typeof AbortSignal.any === 'function'
      ? AbortSignal.any([lifecycle.signal, timeout])
      : timeout;
  }

  async function readJsonLimited(response, maxBytes = 1024 * 1024) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response too large');
    if (!response.body?.getReader) {
      const text = await response.text();
      if (new TextEncoder().encode(text).length > maxBytes) throw new Error('response too large');
      return JSON.parse(text);
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
          throw new Error('response too large');
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text);
    } finally {
      reader.releaseLock?.();
    }
  }

  host.innerHTML = '<section class="comment-section"><h2>评论 <span class="comment-count">(0)</span></h2><div class="comment-form"><label>昵称 <input class="comment-nick" required maxlength="80"></label><label>邮箱（选填）<input class="comment-mail" type="email" maxlength="254"></label><label>评论 <textarea class="comment-content" rows="4" required maxlength="4000"></textarea></label><button class="comment-submit" type="button">提交评论</button><p class="comment-status" aria-live="polite"></p></div><div class="comment-list"></div></section>';
  const $ = (selector) => host.querySelector(selector);

  function commentNode(input) {
    const item = input && typeof input === 'object' ? input : {};
    const nick = String(item.nick || '匿名').slice(0, 80);
    const content = String(item.content || '').slice(0, 4000);
    const created = new Date(item.created_at);
    const article = document.createElement('article');
    article.className = 'comment-item';
    const avatar = document.createElement('span');
    avatar.className = 'comment-avatar';
    avatar.textContent = nick[0]?.toUpperCase() || '?';
    const wrapper = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = nick;
    const time = document.createElement('time');
    time.textContent = Number.isNaN(created.getTime()) ? '' : created.toLocaleString('zh-CN');
    const text = document.createElement('p');
    text.textContent = content;
    wrapper.append(strong, time, text);
    article.append(avatar, wrapper);
    return article;
  }

  function render(input) {
    const items = Array.isArray(input) ? input.slice(0, 200) : [];
    $('.comment-count').textContent = `(${items.length})`;
    const list = $('.comment-list');
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'comment-empty';
      empty.textContent = '还没有评论，来抢沙发吧～';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...items.map(commentNode));
  }

  async function load() {
    try {
      const response = await fetch(`${api}/comments/${encodeURIComponent(page)}`, {
        signal: requestSignal(10000),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await readJsonLimited(response);
      if (!lifecycle.signal.aborted) render(payload);
    } catch {
      if (lifecycle.signal.aborted) return;
      const error = document.createElement('p');
      error.className = 'comment-error';
      error.textContent = '评论暂时不可用，不影响文章阅读。';
      $('.comment-list').replaceChildren(error);
    }
  }

  $('.comment-submit').addEventListener('click', async () => {
    const nick = $('.comment-nick').value.trim();
    const mail = $('.comment-mail').value.trim();
    const content = $('.comment-content').value.trim();
    if (!nick || !content) { $('.comment-status').textContent = '请填写昵称和评论。'; return; }
    if (nick.length > 80 || mail.length > 254 || content.length > 4000) { $('.comment-status').textContent = '评论内容过长。'; return; }
    const button = $('.comment-submit');
    button.disabled = true;
    button.textContent = '提交中…';
    try {
      const result = await fetch(`${api}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, nick, mail, content }),
        signal: requestSignal(10000),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (!result.ok) throw new Error();
      if (lifecycle.signal.aborted) return;
      localStorage.setItem('comment_nick', nick);
      $('.comment-content').value = '';
      $('.comment-status').textContent = '评论已提交。';
      await load();
    } catch {
      if (!lifecycle.signal.aborted) $('.comment-status').textContent = '提交失败，请稍后再试。';
    } finally {
      if (!lifecycle.signal.aborted) {
        button.disabled = false;
        button.textContent = '提交评论';
      }
    }
  });

  $('.comment-nick').value = (localStorage.getItem('comment_nick') || '').slice(0, 80);
  void load();
})();
