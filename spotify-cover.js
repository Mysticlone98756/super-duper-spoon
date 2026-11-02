// spotify-cover.js – use Spotify's own cover art (from the Spicetify extension)
//
// Data path:  Spotify -> time-transferrer.js -> clock.py -> media-bridge.js
//             -> 'spotify-track' event -> this file -> cover.png + Kawarp
//
// WHEN IT APPLIES
//  Several players can be active over time (Spotify, Apple Music, ...), and
//  Windows' media session (via Wallpaper Engine) is what says which one is
//  "current". So Spotify's cover is used only when Spotify's track matches the
//  title/artist Wallpaper Engine reports. Anything else keeps using the older
//  sources (embedded art, iTunes fallback).
//
// TITLE / ARTIST
//  They are NOT overwritten with Spotify's strings. lyrics.js refetches lyrics
//  whenever the title or artist changes, so replacing them would cause a
//  second fetch for every track. Spotify's title/artist are used only as the
//  match key, and as a fallback when the OS reports no track at all.
(function () {
    'use strict';

    const DISK_WRITE_SETTLE_MS = 80; // same settle buffer as wallapaper_engine.js

    let spotify = null;     // latest track_update data (or null)
    let appliedKey = '';    // which Spotify track's cover is currently applied
    let loadToken = 0;      // guards against rapid track skipping
    let lastEvalKey = '';

    function norm(s) {
        return String(s || '')
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }

    // Does Spotify's track correspond to this title/artist (as the OS reports it)?
    function sameTrack(track, title, artist) {
        if (!track) return false;
        const a = norm(track.title);
        const b = norm(title);
        if (!a || !b) return false;
        // Containment tolerates "(feat. X)" and similar suffix differences.
        if (!(a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1)) return false;

        const osArtist = norm(artist);
        if (osArtist) {
            const allArtists = norm(track.artist);
            const firstArtist = norm(String(track.artist || '').split(',')[0]);
            if (firstArtist && !(osArtist.indexOf(firstArtist) !== -1 || allArtists.indexOf(osArtist) !== -1)) {
                return false;
            }
        }
        return true;
    }

    function loadImage(url) {
        return new Promise(function (resolve, reject) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('image failed to load')); };
            img.src = url;
        });
    }

    // Same pipeline wallapaper_engine.js / cover-changer.js use.
    function publishCover(canvas, dataUrl) {
        // Fast path: hand the decoded bitmap straight to the background.
        if (window.__kawarp && typeof window.__kawarp.loadImageElement === 'function') {
            window.__kawarp.loadImageElement(canvas);
        }

        if (typeof window.wallpaperWriteFile === 'function') {
            window.wallpaperWriteFile('cover.png', dataUrl.split(',')[1]);
            setTimeout(function () {
                window.dispatchEvent(new CustomEvent('cover-updated', { detail: { canvas: canvas } }));
            }, DISK_WRITE_SETTLE_MS);
        } else {
            // cover.png was NOT written; listeners must use the data URL.
            window.dispatchEvent(new CustomEvent('cover-updated', {
                detail: { canvas: canvas, dataUrl: dataUrl }
            }));
        }
    }

    async function applyCover(track) {
        const token = ++loadToken;
        const urls = [track.cover, track.cover_fallback].filter(function (u, i, arr) {
            return u && arr.indexOf(u) === i;
        });

        if (!urls.length) {
            console.warn('[SpotifyCover] no cover URL for "' + track.title + '"');
            return;
        }

        for (let i = 0; i < urls.length; i += 1) {
            try {
                const img = await loadImage(urls[i]);
                if (token !== loadToken) return; // a newer track took over

                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                // Throws if the image was not served with CORS headers.
                const dataUrl = canvas.toDataURL('image/png');

                publishCover(canvas, dataUrl);
                console.log('[SpotifyCover] cover applied for "' + track.title + '" (' +
                    img.naturalWidth + 'x' + img.naturalHeight + ')');
                return;
            } catch (e) {
                console.warn('[SpotifyCover] could not use ' + urls[i] + ': ' + (e && e.message));
            }
        }
        console.warn('[SpotifyCover] no usable cover for "' + track.title + '"');
    }

    // The OS reported nothing at all: Spotify is the only source we have.
    function adoptSpotifyText(track) {
        const state = window.__mediaState;
        if (!state) return;
        state.title = track.title || '';
        state.artist = track.artist || '';
        window.dispatchEvent(new CustomEvent('media-update', { detail: { ...state } }));
    }

    function evaluate() {
        if (!spotify) {
            appliedKey = '';
            lastEvalKey = '';
            return;
        }

        const state = window.__mediaState || {};
        // Cheap guard: this runs on every media-update (several per second).
        const evalKey = [state.title, state.artist, spotify.uri, spotify.title].join('|');
        if (evalKey === lastEvalKey) return;
        lastEvalKey = evalKey;

        let owns;
        let needsText = false;
        if (state.title) {
            owns = sameTrack(spotify, state.title, state.artist);
        } else {
            owns = Boolean(spotify.is_playing);
            needsText = owns;
        }

        if (!owns) {
            // Another player is current. Forget what we applied so that coming
            // back to this Spotify track re-applies its cover.
            appliedKey = '';
            return;
        }

        const key = spotify.uri || (spotify.title + '|' + spotify.artist);
        if (key !== appliedKey) {
            appliedKey = key;
            applyCover(spotify);
        }

        // Last, so the media-update it dispatches finds appliedKey already set.
        if (needsText) adoptSpotifyText(spotify);
    }

    // Used by wallapaper_engine.js to skip its lower-resolution embedded art
    // when Spotify supplies the cover for the same track.
    window.__spotifyCover = {
        matches: function (title, artist) {
            return sameTrack(spotify, title, artist);
        }
    };

    window.addEventListener('spotify-track', function (event) {
        spotify = event.detail || null;
        lastEvalKey = '';
        evaluate();
    });

    window.addEventListener('media-update', evaluate);

    if (window.__spotifyTrack) {
        spotify = window.__spotifyTrack;
        evaluate();
    }

    console.log('[SpotifyCover] ready');
})();
