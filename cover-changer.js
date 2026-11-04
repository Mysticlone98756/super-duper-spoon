// cover-changer.js – cover art pipeline for covers that don't come from the OS.
//  * Spotify covers: media-bridge.js calls window.wallpaperApplyCoverUrl(url).
//  * iTunes Search API fallback (free, keyless) when nothing else supplied art.
//
// CHANGES
//  * Images are downscaled to MAX_COVER_PX before PNG encoding, so a 3000px
//    Spotify original doesn't produce a huge cover.png / wallpaperWriteFile
//    call (Wallpaper Engine's embedded browser is fragile).
//  * saveCoverFromUrl() now reports success. If the Spotify cover can't be
//    loaded (e.g. missing CORS headers), the OS thumbnail is restored instead
//    of leaving the previous track's art on screen.
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

    // Same settle buffer as wallapaper_engine.js: gives wallpaperWriteFile()
    // a moment to flush before telling disk-reading listeners to read it.
    const DISK_WRITE_SETTLE_MS = 80;

    // Longest side of the saved cover. 1600px is plenty for a 580px cover.
    const MAX_COVER_PX = 1600;

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

    // Returns true if the cover was applied, false on any failure.
    async function saveCoverFromUrl(url) {
        try {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = url;
            });

            const scale = Math.min(1, MAX_COVER_PX / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.naturalWidth * scale);
            canvas.height = Math.round(img.naturalHeight * scale);
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            // Throws if the image was served without CORS headers.
            const dataUrl = canvas.toDataURL('image/png');
            const rawBase64 = dataUrl.split(',')[1];

            console.log('[CoverChanger] cover ' + img.naturalWidth + 'x' + img.naturalHeight +
                ' -> ' + canvas.width + 'x' + canvas.height);

            // Fast path: push the bitmap we already decoded straight to
            // Kawarp. Happens unconditionally so it works even if the disk
            // write below fails or wallpaperWriteFile isn't available.
            if (window.__kawarp && typeof window.__kawarp.loadImageElement === 'function') {
                window.__kawarp.loadImageElement(canvas);
            }

            if (typeof window.wallpaperWriteFile === 'function') {
                window.wallpaperWriteFile('cover.png', rawBase64);
                console.log('[CoverChanger] cover.png saved.');
                setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('cover-updated', { detail: { canvas } }));
                }, DISK_WRITE_SETTLE_MS);
            } else {
                // wallpaperWriteFile is unavailable: cover.png was NOT written.
                // Include dataUrl so listeners apply the art directly.
                window.dispatchEvent(new CustomEvent('cover-updated', {
                    detail: { canvas, dataUrl: dataUrl }
                }));
            }
            return true;
        } catch (e) {
            console.warn('[CoverChanger] Failed to save cover:', e);
            return false;
        }
    }

    // Public entry point for covers that arrive from elsewhere (media-bridge.js
    // calls this with the Spotify cover URL relayed from the Spicetify
    // extension). Marks the track as "art supplied" so the iTunes fallback
    // below doesn't also fire and overwrite it.
    window.wallpaperApplyCoverUrl = async function(url) {
        if (!url) return;
        wpeSuppliedArtFor = lastQuery;
        externalCoverAt = performance.now();
        if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingTimeout = null;
        }

        const ok = await saveCoverFromUrl(url);
        if (!ok) {
            // Spotify art unusable: let the OS thumbnail through instead of
            // leaving the previous track's cover up.
            console.warn('[CoverChanger] Spotify cover unusable, restoring OS art.');
            window.__mediaState.cover = '';
            if (typeof window.wallpaperRestoreOsArt === 'function') {
                window.wallpaperRestoreOsArt();
            }
        }
        return ok;
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
    // real embedded artwork: use it to suppress the redundant iTunes call.
    window.addEventListener('cover-updated', () => {
        wpeSuppliedArtFor = lastQuery;
    });
})();
