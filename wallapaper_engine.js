// wallpaper_engine.js – Full Event Logging + Fallback
(function() {
    'use strict';

    window.__mediaState = Object.assign({
        title: '',
        artist: '',
        album: '',
        position: 0,
        duration: 0,
        is_playing: false,
        _lastArt: null,
        _osArt: null
    }, window.__mediaState || {});

    // Small buffer between a wallpaperWriteFile() call and telling the rest
    // of the app "the new art is ready to read from disk".
    const DISK_WRITE_SETTLE_MS = 80;

    function notifyUpdate() {
        window.dispatchEvent(new CustomEvent('media-update', {
            detail: { ...window.__mediaState }
        }));
    }

    function saveCoverArtFromDataUrl(dataUrl) {
        if (!dataUrl) return;
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = function() {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const rawBase64 = canvas.toDataURL('image/png').split(',')[1];

            // Fast path: hand the already-decoded bitmap straight to the renderer.
            if (window.__kawarp && typeof window.__kawarp.loadImageElement === 'function') {
                window.__kawarp.loadImageElement(canvas);
            }

            if (typeof window.wallpaperWriteFile === 'function') {
                window.wallpaperWriteFile('cover.png', rawBase64);
                console.log('[WPE] cover.png saved.');
                setTimeout(() => {
                    window.dispatchEvent(new CustomEvent('cover-updated', { detail: { canvas } }));
                }, DISK_WRITE_SETTLE_MS);
            } else {
                // wallpaperWriteFile unavailable: include dataUrl so listeners
                // apply the art directly instead of re-reading a stale file.
                window.dispatchEvent(new CustomEvent('cover-updated', {
                    detail: { canvas, dataUrl: canvas.toDataURL('image/png') }
                }));
            }
        };
        img.src = dataUrl;
    }

    // Used by cover-changer.js if the exact Spotify art fails to load: falls
    // back to the OS thumbnail we held back for this track.
    window.wallpaperRestoreOsArt = function() {
        const art = window.__mediaState._osArt;
        if (art) saveCoverArtFromDataUrl(art);
    };

    // ── Media Properties ──
    if (typeof window.wallpaperRegisterMediaPropertiesListener === 'function') {
        window.wallpaperRegisterMediaPropertiesListener(function(event) {
            console.log('[WPE] Media event received. Full object:', event);
            console.log('[WPE] Keys:', Object.keys(event));

            window.__mediaState.title = event.title || '';
            window.__mediaState.artist = event.artist || '';
            window.__mediaState.album = event.albumTitle || '';

            const possibleArtKeys = ['art', 'thumbnail', 'albumArt', 'artwork', 'coverArt', 'image', 'picture'];
            let activeArt = null;
            for (const key of possibleArtKeys) {
                if (event[key]) {
                    activeArt = event[key];
                    console.log(`[WPE] Found art under key: "${key}"`);
                    break;
                }
            }

            if (activeArt && activeArt !== window.__mediaState._lastArt) {
                window.__mediaState._lastArt = activeArt;
                window.__mediaState._osArt = activeArt;

                // If the exact Spotify art for THIS track is already applied,
                // don't let the lower-quality OS thumbnail overwrite it.
                const s = window.__mediaState;
                const spotifyHasIt = s.externalCoverTitle
                    && window.trackMatch
                    && window.trackMatch.loose(s.externalCoverTitle, s.title);

                if (spotifyHasIt) {
                    console.log('[WPE] Spotify art already applied for this track, keeping it.');
                } else {
                    saveCoverArtFromDataUrl(activeArt);
                }
            } else {
                console.log('[WPE] No new art found.');
            }
            notifyUpdate();
        });
        console.log('[WPE] Media properties listener registered.');
    } else {
        console.warn('[WPE] Listener not available.');
    }

    // ── Media Status ──
    if (typeof window.wallpaperRegisterMediaStatusListener === 'function') {
        window.wallpaperRegisterMediaStatusListener(function(event) {
            console.log('[WPE] Status event:', event);
            if (typeof event.progress === 'number') window.__mediaState.position = event.progress;
            if (typeof event.paused === 'boolean') window.__mediaState.is_playing = !event.paused;
            notifyUpdate();
        });
    }

    // ── Timeline ──
    if (typeof window.wallpaperRegisterMediaTimelineListener === 'function') {
        window.wallpaperRegisterMediaTimelineListener(function(event) {
            console.log('[WPE] Timeline event:', event);
            if (typeof event.duration === 'number') window.__mediaState.duration = event.duration;
            if (typeof event.position === 'number') window.__mediaState.position = event.position;
            notifyUpdate();
        });
    }
})();
