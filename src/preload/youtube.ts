// ── YouTube ad blocking ───────────────────────────────────────────────────────
// YouTube streams its *video* ads from the same host/CDN (googlevideo.com) as
// the real video, so the network/list-based engine can't distinguish them —
// hence "ads keep playing" even with adblock on. The reliable fix is to strip
// the ad metadata out of the InnerTube API responses before the player reads
// them, so no ad is ever queued. A DOM watcher auto-skips anything that slips
// through. Runs in the page world (tabs use contextIsolation:false), so the
// fetch/XHR overrides land before YouTube's own scripts.
;(function youtubeAdblock() {
  const host = location.hostname
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return

  // Keys that carry video-ad instructions in the player / next responses.
  const AD_KEYS = [
    'adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams',
    'importantForPlaybackAdsRenderer', 'adParams',
  ]

  function prune(node: unknown, depth = 0): void {
    if (!node || typeof node !== 'object' || depth > 6) return
    const obj = node as Record<string, unknown>
    for (const k of AD_KEYS) if (k in obj) delete obj[k]
    // The player response is sometimes nested inside `next`/watch responses.
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') prune(v, depth + 1)
    }
  }

  // Only the *player* response carries video-ad instructions. Deliberately NOT
  // `next`/`reel_watch_sequence` — those drive sidebar/related navigation, and
  // handing the router a reconstructed Response breaks in-page navigation.
  const isPlayerApi = (url: string) =>
    /\/youtubei\/v1\/(player|reel_item_watch)(\?|$)/.test(url)

  // ── fetch: the primary transport for InnerTube today ──────────────────────
  const origFetch = window.fetch
  window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this as never, args)
    try {
      const input = args[0]
      const url = typeof input === 'string' ? input
        : input instanceof Request ? input.url
        : String((input as URL)?.href ?? '')
      if (isPlayerApi(url)) {
        const json = await res.clone().json()
        prune(json)
        return new Response(JSON.stringify(json), {
          status: res.status,
          statusText: res.statusText,
          headers: { 'content-type': 'application/json' },
        })
      }
    } catch { /* fall through to the untouched response */ }
    return res
  }

  // ── XHR: some polymer paths still use it ──────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]) {
    if (typeof url === 'string' && isPlayerApi(url)) {
      this.addEventListener('readystatechange', function () {
        if (this.readyState !== 4) return
        try {
          const json = JSON.parse(this.responseText)
          prune(json)
          const patched = JSON.stringify(json)
          // responseText is read-only; redefine it on this instance.
          Object.defineProperty(this, 'responseText', { value: patched, configurable: true })
          Object.defineProperty(this, 'response', { value: patched, configurable: true })
        } catch { /* leave as-is */ }
      })
    }
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
  }

  // ── DOM fallback: auto-skip / seek past any ad that still renders ──────────
  function killVisibleAd() {
    const skip = document.querySelector(
      '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button',
    ) as HTMLElement | null
    if (skip) skip.click()

    const player = document.querySelector('.html5-video-player')
    if (player?.classList.contains('ad-showing')) {
      const video = document.querySelector('video.html5-main-video') as HTMLVideoElement | null
      if (video && isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration   // jump the ad to its end
        video.muted = true
      }
      const close = document.querySelector('.ytp-ad-overlay-close-button') as HTMLElement | null
      if (close) close.click()
    }
  }

  // Hide the surrounding ad chrome (banners, promoted feed items, masthead).
  function injectHidingCss() {
    const css = [
      '#player-ads', '.ytp-ad-module', '.video-ads.ytp-ad-module',
      'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer',
      'ytd-banner-promo-renderer', 'ytd-statement-banner-renderer',
      '#masthead-ad', 'ytd-companion-slot-renderer', '.ytd-companion-slot-renderer',
      'ytd-promoted-sparkles-web-renderer', 'ytd-display-ad-renderer',
    ].join(',') + '{display:none !important;}'
    const el = document.createElement('style')
    el.setAttribute('data-radical-yt-adblock', '')
    el.textContent = css
    ;(document.head || document.documentElement).appendChild(el)
  }

  function start() {
    injectHidingCss()
    killVisibleAd()
    // Ads render mid-playback, so a light poll plus a mutation observer keeps
    // the skip responsive without hammering the main thread.
    setInterval(killVisibleAd, 400)
    new MutationObserver(killVisibleAd).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
