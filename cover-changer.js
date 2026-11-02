// cover-changer.js – free/keyless iTunes Search API fallback for cover art.
// Runs only when the OS media session (wallapaper_engine.js) didn't already
// supply embedded artwork for the current track. No API key, no paid tier —
// itunes.apple.com/search is a public, unauthenticated endpoint.
(function() {
    'use strict';

    let lastQuery = '';
    let wpeSuppliedArtFor = '';
    let pendingTimeout = null;
    // When an external cover (Spotify) last arrived. The Spotify message can land
    // BEFORE wallapaper_engine.js announces the new title, so lastQuery may still
    // be the previous track; a recency check covers that ordering.
    let externalCoverAt = -Infinity;
    const EXTERNAL_COVER_FRESH_MS = 8000;

    // Same settle buffer as wallapaper_engine.js — gives wallpaperWriteFile()
    // a moment to actually flush before telling disk-reading listeners the
    // new cover.png is ready to read.
    const DISK_WRITE_SETTLE_MS = 80;

    function makeQueryKey(title, artist) {
        return `${(title || '').trim().toLowerCase()}::${(artist || '').trim().toLowerCase()}`;
    }

    async function fetchCoverFromItunes(title, artist) {
        const term = encodeURIComponent(`${artist} ${title}`.trim());
        const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=1`;
        try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = await res.json();
            if (data.results && data.results.length > 0 && data.results[0].artworkUrl100) {
                // Upgrade the default 100x100 thumbnail to a much larger image
                return data.results[0].artworkUrl100.replace('100x100bb', '1200x1200bb');
            }
        } catch (e) {
            console.warn('[CoverChanger] iTunes lookup failed:', e);
        }
        return null;
    }

    async function saveCoverFromUrl(url) {
        try {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = url;
            });

            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            const rawBase64 = canvas.toDataURL('image/png').split(',')[1];

            // Fast path: skip the disk round-trip for rendering — push the
            // bitmap we already decoded straight to Kawarp/UI. Happens
            // unconditionally so it works even if the disk write below fails
            // or wallpaperWriteFile isn't available at all.
            if (window.__kawarp && typeof window.__kawarp.loadImageElement === 'function') {
                window.__kawarp.loadImageElement(canvas);
            }

            if (typeof window.wallpaperWriteFile === 'function') {
                window.wallpaperWriteFile('cover.png', rawBase64);
                console.log('[CoverChanger] cover.png saved from iTunes fallback.');
                // Give the write a moment to land before disk-reading
                // listeners (bg.js, ui_controller.js) try to reload it.
                setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('cover-updated', { detail: { canvas } }));
                }, DISK_WRITE_SETTLE_MS);
            } else {
                // wallpaperWriteFile is genuinely unavailable — cover.png was
                // NOT written. Include dataUrl so listeners apply the art
                // directly instead of re-reading a file that never changed.
                window.dispatchEvent(new CustomEvent('cover-updated', {
                    detail: { canvas, dataUrl: canvas.toDataURL('image/png') }
                }));
            }
        } catch (e) {
            console.warn('[CoverChanger] Failed to save fallback cover:', e);
        }
    }

    // Public entry point for covers that arrive from elsewhere (media-bridge.js
    // calls this with the Spotify cover URL relayed from the Spicetify
    // extension). Marks the track as "art supplied" so the iTunes fallback
    // below doesn't also fire and overwrite it.
    window.wallpaperApplyCoverUrl = function(url) {
        if (!url) return;
        wpeSuppliedArtFor = lastQuery;
        externalCoverAt = performance.now();
        if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingTimeout = null;
        }
        return saveCoverFromUrl(url);
    };

    window.addEventListener('media-update', (event) => {
        const detail = event.detail;
        if (!detail || !detail.title) return;

        const queryKey = makeQueryKey(detail.title, detail.artist);
        if (queryKey === lastQuery) return; // same track, nothing to do
        lastQuery = queryKey;

        if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingTimeout = null;
        }

        // Give wallapaper_engine.js's embedded-art listener first crack at
        // this track. Only hit the iTunes fallback if nothing showed up
        // within a short grace window.
        pendingTimeout = setTimeout(async () => {
            if (wpeSuppliedArtFor === queryKey) return;
            if (performance.now() - externalCoverAt < EXTERNAL_COVER_FRESH_MS) return;
            const artUrl = await fetchCoverFromItunes(detail.title, detail.artist);
            if (artUrl) await saveCoverFromUrl(artUrl);
        }, 1500);
    });

    // wallapaper_engine.js dispatches this whenever it successfully saves
    // real embedded artwork — use it to suppress the redundant iTunes call.
    window.addEventListener('cover-updated', () => {
        wpeSuppliedArtFor = lastQuery;
    });
})();
