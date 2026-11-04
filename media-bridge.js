// media-bridge.js
// Talks to the Python backend (ws://127.0.0.1:5002/ws):
//   - receives position_update (position / duration / is_playing)
//   - receives media_properties (title / artist / album from the Windows media
//     session), so the page works without Wallpaper Engine (e.g. GitHub Pages)
//   - receives track_meta (cover URL + ISRC + track identity, relayed from the
//     Spicetify extension time-transferrer.js; null when Spotify goes away)
//   - sends playback commands back
//
// Title/artist priority: the OS (media_properties) wins. If the OS reports
// nothing, Spotify's own title/artist from track_meta are used instead.
//
// Spotify's view of the current track lives in window.__mediaState.spotify:
//   { uri, title, artist, album, durationMs, isrc }   (isrc is null while the
//   lookup is still pending, '' never; null/undefined state = no Spotify data)
// Whenever it changes, a 'track-meta' event is dispatched with the same shape
// in event.detail so lyrics.js can react (e.g. when the ISRC arrives late).
(function() {
    'use strict';

    // Shared with wallpaper_engine.js. Merge instead of overwrite so whichever
    // script loads second doesn't wipe the other's values.
    window.__mediaState = Object.assign({
        title: '',
        artist: '',
        album: '',
        position: 0,
        duration: 0,
        is_playing: false,
        cover: '',
        spotify: null,
        _lastArt: null,
        _osTitle: false   // true while the OS is supplying the title
    }, window.__mediaState || {});

    const WS_URL = 'wss://rubdown-makeshift-fraternal.ngrok-free.dev/ws';
    const RETRY_MS = 2000;

    let socket = null;
    let lastAppliedCoverUrl = '';

    function notifyUpdate() {
        window.dispatchEvent(new CustomEvent('media-update', {
            detail: { ...window.__mediaState }
        }));
    }

    function notifyTrackMeta() {
        window.dispatchEvent(new CustomEvent('track-meta', {
            detail: window.__mediaState.spotify
                ? { ...window.__mediaState.spotify }
                : null
        }));
    }

    function handleCoverUpdate(cover) {
        const url = cover || '';
        window.__mediaState.cover = url;

        if (url) {
            // The extension sends each track twice (once immediately, once
            // when the ISRC is known). Applying the same cover twice would
            // restart the background transition, so skip repeats.
            if (url !== lastAppliedCoverUrl) {
                lastAppliedCoverUrl = url;
                if (typeof window.wallpaperApplyCoverUrl === 'function') {
                    window.wallpaperApplyCoverUrl(url);
                } else {
                    console.warn('[Bridge WS] wallpaperApplyCoverUrl missing (is cover-changer.js loaded?)');
                }
            }
        } else {
            // Spotify went away: let other art sources take over again
            lastAppliedCoverUrl = '';
            window.__mediaState._lastArt = null;
        }
        notifyUpdate();
    }

    // OS title/artist/album from clock.py
    function handleMediaProperties(data) {
        const s = window.__mediaState;
        const osHasTrack = Boolean(data.title);
        s._osTitle = osHasTrack;

        // If the OS reports nothing but Spotify is connected, keep Spotify's text.
        if (osHasTrack || !s.spotify) {
            s.title = data.title || '';
            s.artist = data.artist || '';
            s.album = data.album || '';
        }
        notifyUpdate();
    }

    // data = { cover, isrc, track: { uri, title, artist, album, durationMs } }
    // or null when Spotify/Spicetify disconnected.
    function handleTrackMeta(data) {
        const s = window.__mediaState;

        if (!data) {
            if (!s._osTitle) {
                s.title = '';
                s.artist = '';
                s.album = '';
            }
            s.spotify = null;
            handleCoverUpdate('');
            notifyTrackMeta();
            return;
        }

        const t = data.track || {};
        s.spotify = {
            uri: t.uri || null,
            title: t.title || '',
            artist: t.artist || '',
            album: t.album || '',
            durationMs: Number(t.durationMs) || 0,
            isrc: data.isrc || null
        };
        console.log('[Bridge WS] track_meta:', s.spotify);

        // No OS title: use Spotify's. Set BEFORE the cover is applied, because
        // cover-changer.js ties the cover to the current track key.
        if (!s._osTitle && t.title) {
            s.title = t.title;
            s.artist = t.artist || '';
            s.album = t.album || '';
            notifyUpdate();
        }

        handleCoverUpdate(data.cover);
        notifyTrackMeta();
    }

    function initWebSocket() {
        socket = new WebSocket(WS_URL);

        socket.onopen = function() {
            console.log('[Bridge WS] Connected to Python backend');
        };

        socket.onmessage = function(event) {
            try {
                const msg = JSON.parse(event.data);

                if (msg.type === 'position_update' && msg.data) {
                    window.__mediaState.position = msg.data.position_ms / 1000;
                    window.__mediaState.duration = msg.data.duration_ms / 1000;
                    if (typeof msg.data.is_playing === 'boolean') {
                        window.__mediaState.is_playing = msg.data.is_playing;
                    }
                    notifyUpdate();
                } else if (msg.type === 'media_properties' && msg.data) {
                    handleMediaProperties(msg.data);
                } else if (msg.type === 'track_meta') {
                    handleTrackMeta(msg.data); // data may be null (Spotify gone)
                } else if (msg.type === 'cover_update' && msg.data) {
                    handleCoverUpdate(msg.data.cover); // legacy message type
                }
            } catch (err) {
                console.error('[Bridge WS] Parse error:', err);
            }
        };

        socket.onclose = function() {
            console.warn(`[Bridge WS] Disconnected. Retrying in ${RETRY_MS / 1000} seconds...`);
            setTimeout(initWebSocket, RETRY_MS);
        };

        socket.onerror = function(err) {
            console.error('[Bridge WS] Error:', err);
        };
    }

    // Send a command (play/pause/next/...) to the backend, used by the UI controller
    window.wallpaperSendMediaCommand = function(command, value) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            console.log(`[Bridge WS] Sending command: ${command}`, value);
            socket.send(JSON.stringify({ command: command, value: value }));
        } else {
            console.warn('[Bridge WS] Cannot send command, WebSocket is not open.');
        }
    };

    initWebSocket();
})();
