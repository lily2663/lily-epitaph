/* =========================================================
 * /subscribe/ 复制地址（渐进增强）
 *
 * 约束（文档 5.6）：
 *   1. 地址始终可见、可选中、可作为普通链接打开；禁用 JS 时仍可完成订阅。
 *   2. 模块导出一次性 installer，在 site.js 首次初始化时安装
 *      document 级委托监听，只响应 .subscription-page [data-subscription-copy]。
 *      这样 PJAX 反复进入/离开都不会叠加监听。
 *   3. 复制内容取真实 feed 锚点解析后的 href，不写死文案。
 *   4. 成功/失败反馈走局部 aria-live="polite"。
 *   5. Clipboard 不可用或被拒绝时给出手动复制提示，不抛未捕获异常。
 * ========================================================= */

const STATUS_TIMEOUT = 4000;

function statusFor(button) {
  const id = button.getAttribute('aria-describedby');
  if (id) {
    const el = document.getElementById(id);
    if (el) return el;
  }
  return button.parentElement?.querySelector('[role="status"]') || null;
}

function setStatus(node, message) {
  if (!node) return;
  node.textContent = message;
  if (node._lilyStatusTimer) clearTimeout(node._lilyStatusTimer);
  node._lilyStatusTimer = setTimeout(() => {
    node.textContent = '';
    node._lilyStatusTimer = null;
  }, STATUS_TIMEOUT);
}

function selectNodeText(node) {
  if (!node || typeof window.getSelection !== 'function') return false;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function resolveFeedUrl(button) {
  const targetId = button.getAttribute('data-subscription-copy');
  const node = targetId ? document.getElementById(targetId) : null;
  if (node) {
    // 地址可能是 <code> 文本，也可能是链接；优先取 href
    const href = node.getAttribute?.('href');
    const text = (href || node.textContent || '').trim();
    if (text) return { url: text, node };
  }
  // 回退：同区块内的 XML 链接
  const link = button.parentElement?.querySelector('a[type="application/rss+xml"]');
  if (link?.href) return { url: link.href, node: null };
  return { url: '', node: null };
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // 老浏览器回退：临时 textarea + execCommand
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

let installed = false;

export function installSubscriptionCopy() {
  if (installed) return;
  installed = true;

  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('.subscription-page [data-subscription-copy]');
    if (!button) return;
    // 不拦截其他默认行为，仅处理本按钮
    const status = statusFor(button);
    const { url, node } = resolveFeedUrl(button);

    if (!url) {
      setStatus(status, '未找到订阅地址，请手动选择页面上方的地址复制。');
      return;
    }

    copyText(url)
      .then((ok) => {
        if (ok) {
          setStatus(status, '订阅地址已复制，可粘贴到阅读器中添加。');
          return;
        }
        selectNodeText(node);
        setStatus(status, '浏览器拒绝了自动复制，地址已选中，请按 Ctrl+C 复制。');
      })
      .catch(() => {
        selectNodeText(node);
        setStatus(status, '浏览器拒绝了自动复制，地址已选中，请按 Ctrl+C 复制。');
      });
  });
}
