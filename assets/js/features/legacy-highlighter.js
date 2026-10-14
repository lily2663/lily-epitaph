const HIGHLIGHT_SOURCE = '/assets/vendor/highlight.min.js';
let pendingHighlighter = null;

// Share a request across article enhancements and reuse protected.js's script.
// A failed attempt must not leave a rejected promise or dead script behind.
export function loadLegacyHighlighter() {
  if (window.hljs?.highlightElement) return Promise.resolve(window.hljs);
  if (pendingHighlighter) return pendingHighlighter;

  pendingHighlighter = new Promise((resolve, reject) => {
    let script = document.querySelector(`script[src="${HIGHLIGHT_SOURCE}"]`);
    const existing = Boolean(script);
    if (!script) {
      script = document.createElement('script');
      script.src = HIGHLIGHT_SOURCE;
      script.async = true;
    }
    let timeout;
    const finish = (error) => {
      clearTimeout(timeout);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      if (error) {
        script.remove();
        reject(error);
      } else resolve(window.hljs);
    };
    const onLoad = () => finish(window.hljs?.highlightElement ? null : new Error('Highlighter unavailable'));
    const onError = () => finish(new Error('Highlighter failed to load'));
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
    timeout = setTimeout(() => {
      finish(new Error('Highlighter timed out'));
      // protected.js can be awaiting the same element with its own listeners.
      script.dispatchEvent(new Event('error'));
    }, 15000);
    if (!existing) document.head.append(script);
  }).finally(() => { pendingHighlighter = null; });

  return pendingHighlighter;
}
