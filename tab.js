"use strict";

// src/preload/tab.ts
var import_electron = require("electron");

// src/preload/youtube.ts
(function youtubeAdblock() {
  const host = location.hostname;
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return;
  const AD_KEYS = [
    "adPlacements",
    "adSlots",
    "playerAds",
    "adBreakHeartbeatParams",
    "importantForPlaybackAdsRenderer",
    "adParams"
  ];
  function prune(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 6) return;
    const obj = node;
    for (const k of AD_KEYS) if (k in obj) delete obj[k];
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") prune(v, depth + 1);
    }
  }
  const isPlayerApi = (url) => /\/youtubei\/v1\/(player|next|reel_item_watch|reel_watch_sequence)/.test(url);
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input?.href ?? "");
      if (isPlayerApi(url)) {
        const json = await res.clone().json();
        prune(json);
        return new Response(JSON.stringify(json), {
          status: res.status,
          statusText: res.statusText,
          headers: { "content-type": "application/json" }
        });
      }
    } catch {
    }
    return res;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (typeof url === "string" && isPlayerApi(url)) {
      this.addEventListener("readystatechange", function() {
        if (this.readyState !== 4) return;
        try {
          const json = JSON.parse(this.responseText);
          prune(json);
          const patched = JSON.stringify(json);
          Object.defineProperty(this, "responseText", { value: patched, configurable: true });
          Object.defineProperty(this, "response", { value: patched, configurable: true });
        } catch {
        }
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
  function killVisibleAd() {
    const skip = document.querySelector(
      ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button"
    );
    if (skip) skip.click();
    const player = document.querySelector(".html5-video-player");
    if (player?.classList.contains("ad-showing")) {
      const video = document.querySelector("video.html5-main-video");
      if (video && isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration;
        video.muted = true;
      }
      const close = document.querySelector(".ytp-ad-overlay-close-button");
      if (close) close.click();
    }
  }
  function injectHidingCss() {
    const css = [
      "#player-ads",
      ".ytp-ad-module",
      ".video-ads.ytp-ad-module",
      "ytd-ad-slot-renderer",
      "ytd-in-feed-ad-layout-renderer",
      "ytd-banner-promo-renderer",
      "ytd-statement-banner-renderer",
      "#masthead-ad",
      "ytd-companion-slot-renderer",
      ".ytd-companion-slot-renderer",
      "ytd-promoted-sparkles-web-renderer",
      "ytd-display-ad-renderer"
    ].join(",") + "{display:none !important;}";
    const el = document.createElement("style");
    el.setAttribute("data-radical-yt-adblock", "");
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }
  function start() {
    injectHidingCss();
    killVisibleAd();
    setInterval(killVisibleAd, 400);
    new MutationObserver(killVisibleAd).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();

// src/preload/tab.ts
window.prompt = (message, defaultValue) => {
  try {
    const r = import_electron.ipcRenderer.sendSync("window-prompt", {
      message: String(message ?? ""),
      defaultValue: defaultValue == null ? "" : String(defaultValue)
    });
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
};
(function cosmetics() {
  if (!/^https?:/.test(location.href)) return;
  let styleEl = null;
  const injectedRules = /* @__PURE__ */ new Set();
  function inject(css) {
    if (!css) return;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.setAttribute("data-radical-adblock", "");
      (document.head || document.documentElement).appendChild(styleEl);
    }
    let add = "";
    for (const rule of css.split("\n")) {
      if (rule && !injectedRules.has(rule)) {
        injectedRules.add(rule);
        add += rule + "\n";
      }
    }
    if (add) styleEl.textContent += add;
  }
  const seenC = /* @__PURE__ */ new Set(), seenI = /* @__PURE__ */ new Set();
  function harvest() {
    const classes = [], ids = [];
    try {
      document.querySelectorAll("[class],[id]").forEach((el) => {
        const cn = el.className;
        if (typeof cn === "string") {
          for (const c of cn.split(/\s+/)) if (c && !seenC.has(c)) {
            seenC.add(c);
            classes.push(c);
          }
        }
        const idv = el.id;
        if (idv && !seenI.has(idv)) {
          seenI.add(idv);
          ids.push(idv);
        }
      });
    } catch {
    }
    return { classes, ids };
  }
  function pull(dom) {
    const sig = dom ? harvest() : { classes: [], ids: [] };
    if (dom && !sig.classes.length && !sig.ids.length) return;
    import_electron.ipcRenderer.invoke("adblock:cosmetics", { url: location.href, classes: sig.classes, ids: sig.ids }).then(inject).catch(() => {
    });
  }
  pull(false);
  const start = () => {
    pull(true);
    let t;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => pull(true), 300);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"] });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
