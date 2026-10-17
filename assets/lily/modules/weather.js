(() => {
  const weatherCode = { 0: "晴朗", 1: "大致晴朗", 2: "局部多云", 3: "阴", 45: "雾", 48: "雾凇", 51: "毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨", 71: "小雪", 80: "阵雨", 95: "雷暴" };
  const cache = new Map();
  const pending = new Set();
  let observer = null;
  let fallbackAttached = false;
  let visibilityAttached = false;

  function loadWeather(url) {
    const key = url.href;
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.promise;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timeout;
    const entry = { expiresAt: Infinity };
    entry.promise = Promise.race([
      fetch(url, { headers: { Accept: "application/json" }, ...(controller ? { signal: controller.signal } : {}) })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error("天气服务不可用"))),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller?.abort();
          reject(new Error("天气服务请求超时"));
        }, 8000);
      }),
    ])
      .finally(() => clearTimeout(timeout))
      .then((data) => {
        entry.expiresAt = Date.now() + 15 * 60000;
        return data;
      })
      .catch((error) => {
        // A failed service must not be retried by every widget or PJAX visit.
        entry.expiresAt = Date.now() + 60000;
        throw error;
      });
    cache.set(key, entry);
    return entry.promise;
  }

  function stopWatching() {
    observer?.disconnect();
    observer = null;
    if (fallbackAttached) {
      window.removeEventListener("scroll", checkVisibleWeather);
      window.removeEventListener("resize", checkVisibleWeather);
      fallbackAttached = false;
    }
    if (visibilityAttached) {
      document.removeEventListener("click", checkVisibleWeather);
      document.removeEventListener("transitionend", checkVisibleWeather);
      visibilityAttached = false;
    }
  }

  function startWeather(node) {
    if (!pending.has(node) || !node.isConnected) return;
    pending.delete(node);
    observer?.unobserve(node);
    if (!pending.size) stopWatching();
    node.dataset.lilyWeatherReady = "true";
    const latitude = Number(node.dataset.latitude), longitude = Number(node.dataset.longitude);
    const unit = node.dataset.unit === "fahrenheit" ? "fahrenheit" : "celsius";
    const state = node.querySelector(".lily-weather__state");
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !state) return;
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({ latitude, longitude, current: "temperature_2m,weather_code", temperature_unit: unit }).toString();
    loadWeather(url)
      .then((data) => {
        if (!node.isConnected) return;
        const current = data.current || {};
        state.textContent = `${weatherCode[current.weather_code] || "天气"} · ${current.temperature_2m ?? "--"}°${unit === "fahrenheit" ? "F" : "C"}`;
      })
      .catch(() => { if (node.isConnected) state.textContent = "暂时无法获取天气"; });
  }

  function isVisible(node) {
    if (!node.isConnected || node.closest("[hidden]")) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    const visibility = window.getComputedStyle(node).visibility;
    return visibility !== "hidden" && visibility !== "collapse";
  }

  function checkVisibleWeather() {
    for (const node of pending) {
      if (!node.isConnected) { pending.delete(node); continue; }
      if (isVisible(node)) startWeather(node);
    }
    if (!pending.size) stopWatching();
  }

  function initWeather() {
    const added = [];
    for (const node of document.querySelectorAll("[data-lily-weather]:not([data-lily-weather-ready])")) {
      if (!pending.has(node)) { pending.add(node); added.push(node); }
    }
    if (!pending.size) return;
    // A remembered mobile tab may already intersect while its parent is
    // visibility:hidden. Opening it need not cross an observer threshold.
    if (!visibilityAttached) {
      document.addEventListener("click", checkVisibleWeather);
      document.addEventListener("transitionend", checkVisibleWeather);
      visibilityAttached = true;
    }
    if (typeof window.IntersectionObserver === "function") {
      if (!observer) {
        const currentObserver = new window.IntersectionObserver((entries) => {
          if (observer !== currentObserver) return;
          for (const entry of entries) {
            if (entry.isIntersecting && isVisible(entry.target)) startWeather(entry.target);
          }
        });
        observer = currentObserver;
      }
      for (const node of added) observer.observe(node);
    } else {
      if (!fallbackAttached) {
        window.addEventListener("scroll", checkVisibleWeather, { passive: true });
        window.addEventListener("resize", checkVisibleWeather);
        fallbackAttached = true;
      }
      checkVisibleWeather();
    }
  }

  initWeather();
  document.addEventListener('lily:page-ready', initWeather);
  document.addEventListener('lily:before-page-swap', () => {
    stopWatching();
    pending.clear();
  });
})();
