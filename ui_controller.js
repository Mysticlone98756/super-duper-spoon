// ui_controller.js – cover, title, artist, controls + animated (motion) covers
//
// TITLE
//  * The title sits on one line at full size. If it is wider than its box it
//    scrolls like Spotify: pause, slide to the end, pause, slide back.
//    Short titles stay centered and still. (See .track-title.scrolling in
//    style.css.)
//
// Animated-cover identity handling:
//  * Every loop is stored together with the track/album the relay announced it
//    for (videoMeta). On a song change it is kept only if it provably belongs
//    to the new track/album, and cleared if it provably doesn't.
//  * Apple Music motion covers are per ALBUM; Spotify Canvas is per TRACK, so
//    each is compared at the right level (scope 'album' / 'track').
//  * A loop announced for a different track than the OS currently reports is
//    parked in pendingLoop (the OS may just be slower) instead of being shown.
//  * If the track's identity is unknown (relay sends no album/title), it falls
//    back to the old "arrived within a few seconds" heuristic.
(function() {
    'use strict';

    const coverImage = document.getElementById('cover-image');
    const coverVideo = document.getElementById('cover-video');

    const trackTitle = document.getElementById('track-title');
    const trackArtist = document.getElementById('track-artist');

    // The text lives in its own span so the marquee can move it. Never set
    // textContent on #track-title itself: that would delete this span.
    let trackTitleText = document.getElementById('track-title-text');
    if (!trackTitleText) {
        trackTitleText = document.createElement('span');
        trackTitleText.id = 'track-title-text';
        trackTitle.textContent = '';
        trackTitle.appendChild(trackTitleText);
    }

    const playPauseBtn = document.getElementById('sfPlayFill');
    const seekBackBtn = document.getElementById('sfBackwardFill');
    const seekForwardBtn = document.getElementById('sfForwardFill');

    let isPaused = false;
    let lastTitle = '';
    let ws = null;

    // When wallpaperWriteFile isn't available, artwork gets applied straight
    // from a data URL instead of being written to cover.png. While that's
    // true, disk-polling must NOT reload a stale cover.png over it.
    let currentCoverDataUrl = null;

    // ── Animated cover state ──
    const DEBUG_BRIDGE = true;          // log relay messages that mention track / art
    const VIDEO_RACE_GRACE_MS = 5000;   // used only when track identity is unknown
    const VIDEO_LOAD_TIMEOUT_MS = 15000;
    const PENDING_LOOP_TTL_MS = 15000;  // how long a not-yet-matching loop waits for the OS
    let videoUrl = '';                  // URL currently loaded into the <video> ('' = none)
    let videoMeta = null;               // { track, scope } the loaded loop was announced for
    let videoReceivedAt = 0;            // performance.now() when that URL last arrived
    let videoLoadGeneration = 0;        // bumped on every load/clear so stale callbacks bail out
    let lastTrackKey = null;            // identity of the last track the relay announced
    let pendingLoop = null;             // { url, meta, at } loop that arrived before the OS caught up

    function sendMediaCommand(command, value) {
        if (typeof window.wallpaperSendMediaCommand === 'function') {
            window.wallpaperSendMediaCommand(command, value);
        }
    }

    // ── Identity matching ──
    // true  = same album/track, false = provably different, null = can't tell.
    // scope 'album' (Apple Music): compare album first, then title.
    // scope 'track' (Spotify Canvas): compare title first, then album.
    function belongsToCurrent(track, scope) {
        const m = window.trackMatch;
        if (!m || !track || typeof track !== 'object') return null;
        const cur = window.__mediaState || {};
        const title = track.title || track.name;
        const pairs = scope === 'track'
            ? [[title, cur.title], [track.album, cur.album]]
            : [[track.album, cur.album], [title, cur.title]];
        for (const pair of pairs) {
            if (pair[0] && pair[1]) return m.loose(pair[0], pair[1]);
        }
        return null;
    }

    function offerLoop(url, track, scope) {
        const meta = { track: track, scope: scope };
        if (belongsToCurrent(track, scope) === false) {
            // Maybe the OS hasn't reported the new song yet. Park it and
            // re-check on the next media-update instead of showing it.
            pendingLoop = { url: url, meta: meta, at: performance.now() };
            return;
        }
        pendingLoop = null;
        loadAnimatedCover(url, meta);
    }

    // ── Scrolling title (Spotify-style marquee) ──
    const SCROLL_SPEED_PX_S = 45;    // marquee speed
    const SCROLL_PAUSE_FRAC = 0.30;  // share of each pass spent paused (15% at each end)
    const SCROLL_EDGE_PAD_PX = 24;   // extra distance so the last letters clear the edge fade
    let lastRenderedTitle = null;

    // Measures the title and turns the marquee on only if it doesn't fit.
    function fitTitle() {
        trackTitle.classList.remove('scrolling');
        trackTitle.style.removeProperty('--scroll-dist');
        trackTitle.style.removeProperty('--scroll-dur');

        const overflow = trackTitleText.offsetWidth - trackTitle.clientWidth;
        if (overflow <= 2) return; // fits: stays centered and still

        const dist = overflow + SCROLL_EDGE_PAD_PX;
        const moveSecs = dist / SCROLL_SPEED_PX_S;
        const totalSecs = moveSecs / (1 - SCROLL_PAUSE_FRAC);

        trackTitle.style.setProperty('--scroll-dist', '-' + dist + 'px');
        trackTitle.style.setProperty('--scroll-dur', totalSecs.toFixed(2) + 's');
        trackTitle.classList.add('scrolling');
    }

    function renderTitle(title) {
        // updateUI runs several times a second; only touch the DOM when the
        // text really changed, otherwise the marquee would restart each time.
        if (title === lastRenderedTitle) return;
        lastRenderedTitle = title;
        trackTitleText.textContent = title;
        fitTitle();
    }

    window.addEventListener('resize', fitTitle);
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(fitTitle);
    }

    // Keeps the animated cover in step with the play/pause state.
    function syncVideoPlayback() {
        if (!coverVideo || !videoUrl) return;
        if (coverVideo.style.display === 'none') return; // 'loadeddata' will start it
        if (isPaused) {
            if (!coverVideo.paused) coverVideo.pause();
        } else if (coverVideo.paused) {
            coverVideo.play().catch(function () {});
        }
    }

    function updateUI(state) {
        if (!state) return;
        renderTitle(state.title || 'No track playing');
        trackArtist.textContent = state.artist || 'Unknown Artist';
        isPaused = state.is_playing === false;
        updatePlayPauseButton(isPaused);
        syncVideoPlayback();
    }

    function updatePlayPauseButton(paused) {
        if (paused) {
            playPauseBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
        } else {
            playPauseBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
        }
    }

    // ── Retry-safe disk cover reload ──
    const COVER_RELOAD_MAX_ATTEMPTS = 5;
    const COVER_RELOAD_BASE_DELAY_MS = 150;
    let _coverReloadToken = 0;

    function refreshCoverFromDisk(force, attempt = 0, token = null) {
        if (!coverImage) return;
        if (!force && currentCoverDataUrl) return; // accurate art already applied in memory

        if (token === null) {
            token = ++_coverReloadToken;
        } else if (token !== _coverReloadToken) {
            return; // superseded by a newer refresh request
        }

        const timestamp = Date.now();
        const probe = new Image();
        probe.onload = () => {
            if (token !== _coverReloadToken) return;
            coverImage.src = `cover.png?cache=${timestamp}`;
            console.log('[UI] Cover reloaded from disk');
        };
        probe.onerror = () => {
            if (token !== _coverReloadToken) return;
            if (attempt < COVER_RELOAD_MAX_ATTEMPTS) {
                const delay = COVER_RELOAD_BASE_DELAY_MS * (attempt + 1);
                setTimeout(() => refreshCoverFromDisk(force, attempt + 1, token), delay);
            } else {
                console.warn('[UI] Giving up reloading cover.png after retries');
            }
        };
        probe.src = `cover.png?cache=${timestamp}`;
    }

    // ── Animated (motion) cover ─────────────────────────────────────────

    // Synchronously tears the video down and frees the decoder.
    function clearVideo() {
        videoLoadGeneration++;
        videoUrl = '';
        videoMeta = null;
        if (!coverVideo) return;
        coverVideo.pause();
        coverVideo.removeAttribute('src');
        coverVideo.load();
        coverVideo.style.display = 'none';
    }

    function resetAnimatedCover() {
        clearVideo();
    }

    function loadAnimatedCover(url, meta) {
        if (!coverVideo || !url) return;

        // The relay may re-send the same loop. Restarting it would stutter,
        // so just refresh its bookkeeping.
        if (url === videoUrl) {
            videoReceivedAt = performance.now();
            videoMeta = meta || videoMeta;
            return;
        }

        clearVideo();
        videoUrl = url;
        videoMeta = meta || null; // set AFTER clearVideo(), which nulls it
        videoReceivedAt = performance.now();
        const myGeneration = videoLoadGeneration;

        coverVideo.muted = true;
        coverVideo.loop = true;

        coverVideo.addEventListener('loadeddata', function () {
            if (myGeneration !== videoLoadGeneration) return; // superseded
            coverVideo.style.display = 'block'; // a frame is decodable: no black flash
            if (!isPaused) {
                coverVideo.play().catch(function (err) {
                    if (err && err.name !== 'AbortError') {
                        console.warn('[UI] animated cover play() was rejected:', err);
                    }
                });
            }
            console.log('[UI] Animated cover ready (' + coverVideo.videoWidth + 'x' + coverVideo.videoHeight + ')');
        }, { once: true });

        coverVideo.addEventListener('error', function () {
            if (myGeneration !== videoLoadGeneration) return; // superseded
            const err = coverVideo.error;
            console.warn('[UI] Animated cover failed to load (media error code ' +
                (err ? err.code : '?') + '): ' + url);
            clearVideo();
        }, { once: true });

        setTimeout(function () {
            if (myGeneration === videoLoadGeneration && coverVideo.style.display === 'none') {
                console.warn('[UI] Animated cover still not decodable after ' +
                    (VIDEO_LOAD_TIMEOUT_MS / 1000) + 's: ' + url);
            }
        }, VIDEO_LOAD_TIMEOUT_MS);

        coverVideo.src = url;
    }

    // Stable identity of the track the relay is talking about, or null when
    // the shape is unknown (in which case we never treat it as a track change).
    function trackKeyOf(track) {
        if (track === undefined || track === null) return null;
        if (typeof track === 'string') return track;
        if (typeof track === 'object') {
            const parts = [track.id, track.trackId, track.isrc, track.title, track.name, track.artist, track.album]
                .filter(function (v) { return typeof v === 'string' || typeof v === 'number'; });
            if (parts.length) return parts.join('|');
        }
        return null;
    }

    function logBridgeMessage(data) {
        let summary = '';
        try { summary = JSON.stringify(data); } catch (_) { summary = '(unserializable)'; }
        if (summary.length > 300) summary = summary.slice(0, 300) + '…';
        console.log('[UI] relay message keys=[' + Object.keys(data).join(',') + '] ' + summary);
    }

    // Handy from the console: __coverVideoState()
    window.__coverVideoState = function () {
        return {
            videoUrl: videoUrl,
            videoMeta: videoMeta,
            pendingLoop: pendingLoop ? { url: pendingLoop.url, ageMs: Math.round(performance.now() - pendingLoop.at) } : null,
            displayed: coverVideo ? coverVideo.style.display : null,
            paused: coverVideo ? coverVideo.paused : null,
            readyState: coverVideo ? coverVideo.readyState : null,
            networkState: coverVideo ? coverVideo.networkState : null,
            size: coverVideo ? coverVideo.videoWidth + 'x' + coverVideo.videoHeight : null,
            error: coverVideo && coverVideo.error ? coverVideo.error.code : null,
            ageMs: videoUrl ? Math.round(performance.now() - videoReceivedAt) : null
        };
    };

    // ── Button Events ──
    playPauseBtn.addEventListener('click', function() {
        sendMediaCommand('MediaAction.PlayPause');
        // No optimistic flip: clock.py streams the real is_playing state.
    });

    // ── Connect to the background node lyrics-bridge server ──
    function connectBridgeWebSocket() {
        ws = new WebSocket('ws://localhost:8973');

        ws.onopen = () => {
            console.log('[UI] Connected to lyrics-bridge relay for animated artwork.');
        };

        ws.onmessage = (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch (_) {
                return;
            }
            if (!data || typeof data !== 'object') return;

            if (DEBUG_BRIDGE && ('track' in data || 'animatedArt' in data || 'canvasVideo' in data)) {
                logBridgeMessage(data);
            }

            // 1. The relay names a DIFFERENT track: drop the old loop (and any
            //    parked one). Repeating the same track must not reset a video.
            const key = trackKeyOf(data.track);
            if (key !== null && key !== lastTrackKey) {
                lastTrackKey = key;
                clearVideo();
                pendingLoop = null;
            }

            // 2. Apple Music motion cover (per album)
            if (data.animatedArt && data.animatedArt.url) {
                console.log('[UI] Received AM motion video loop:', data.animatedArt.url);
                offerLoop(data.animatedArt.url, data.track, 'album');
            } else if ('animatedArt' in data && !data.animatedArt) {
                clearVideo(); // relay says: this track has none
                pendingLoop = null;
            }

            // 3. Spotify Canvas (per track)
            if (data.canvasVideo) {
                if (data.canvasVideo.url) {
                    console.log('[UI] Received Spotify canvas loop:', data.canvasVideo.url);
                    offerLoop(data.canvasVideo.url, data.track, 'track');
                } else {
                    clearVideo();
                    pendingLoop = null;
                }
            }
        };

        ws.onclose = () => {
            setTimeout(connectBridgeWebSocket, 5000);
        };

        ws.onerror = () => {
            ws.close();
        };
    }

    // ── Reload cover when song changes ──
    window.addEventListener('media-update', function(event) {
        const detail = event.detail;
        if (!detail) return;
        updateUI(detail);

        if (detail.title && detail.title !== lastTitle) {
            lastTitle = detail.title;
            console.log('[UI] Song changed, reloading cover...');

            currentCoverDataUrl = null;

            // Decide whether the loop that's currently loaded still belongs.
            if (videoUrl) {
                const scope = videoMeta ? videoMeta.scope : 'album';
                const verdict = belongsToCurrent(videoMeta ? videoMeta.track : null, scope);
                if (verdict === false) {
                    console.log('[UI] Animated cover belongs to a different album/track, clearing it');
                    clearVideo();
                } else if (verdict === null
                    && !((performance.now() - videoReceivedAt) < VIDEO_RACE_GRACE_MS)) {
                    // Identity unknown and the loop isn't fresh: assume it's stale.
                    resetAnimatedCover();
                } else {
                    console.log('[UI] Keeping the animated cover for this track/album');
                }
            }

            refreshCoverFromDisk(true);
            window.dispatchEvent(new CustomEvent('cover-reloaded'));
        }

        // A loop parked earlier may match now that the OS has caught up.
        if (pendingLoop) {
            if (performance.now() - pendingLoop.at > PENDING_LOOP_TTL_MS) {
                pendingLoop = null;
            } else if (belongsToCurrent(pendingLoop.meta.track, pendingLoop.meta.scope) === true) {
                const p = pendingLoop;
                pendingLoop = null;
                loadAnimatedCover(p.url, p.meta);
            }
        }
    });

    // ── Also listen for cover-updated ──
    window.addEventListener('cover-updated', function(event) {
        const dataUrl = event.detail && event.detail.dataUrl;
        if (dataUrl) {
            currentCoverDataUrl = dataUrl;
            if (coverImage) coverImage.src = dataUrl;
        } else {
            currentCoverDataUrl = null;
            refreshCoverFromDisk(true);
        }
        window.dispatchEvent(new CustomEvent('cover-reloaded'));
    });

    // ── Periodic safety net (every 10s) ──
    setInterval(() => refreshCoverFromDisk(false), 10000);

    // Previous / next TRACK (names clock.py recognises).
    seekBackBtn.addEventListener('click', function() {
        sendMediaCommand('MediaAction.SkipPrevious');
    });

    seekForwardBtn.addEventListener('click', function() {
        sendMediaCommand('MediaAction.SkipNext');
    });

    // ── Keyboard Shortcuts ──
    document.addEventListener('keydown', function(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.code) {
            case 'Space': e.preventDefault(); playPauseBtn.click(); break;
            case 'ArrowLeft': e.preventDefault(); seekBackBtn.click(); break;
            case 'ArrowRight': e.preventDefault(); seekForwardBtn.click(); break;
        }
    });

    // ── Initialise ──
    if (window.__mediaState) {
        updateUI(window.__mediaState);
        if (window.__mediaState.title) {
            lastTitle = window.__mediaState.title;
            refreshCoverFromDisk(false);
        }
    }

    connectBridgeWebSocket();

    console.log('[UI] Controller initialized (scrolling title, identity-checked animated covers).');
})();