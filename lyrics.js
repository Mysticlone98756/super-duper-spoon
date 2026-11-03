// lyrics.js – Internal clock (pause-aware, no small backward steps)
//             + version-aware lrc.red ISRC lookup
//
// CLOCK
//  * The clock freezes while paused (is_playing === false).
//  * Small backward corrections are absorbed by holding still until real time
//    catches up. Only backward jumps >= SEEK_BACK_MS count as real seeks.
//
// LRC.RED LOOKUP (am-lyrics 1.8.x only; older versions never call lrc.red)
//  * am-lyrics 1.8.x asks lrc.red for lyrics by ISRC first. If it has to find
//    the ISRC itself it takes the top search hit, which is often a remix/live
//    version. Here we score every hit instead:
//      - the artist must match (decisive: a different artist is never trusted)
//      - version tags (remix, live, acoustic, ...) must match the playing title
//      - the title must match; the exact full title earns a bonus
//      - length closeness is only a tie-breaker (releases of one recording
//        often differ by a few seconds)
//  * If nothing scores as a confident match, lrc.red is skipped for that
//    track (so wrong-version lyrics are not shown out of sync) and the other
//    providers take over. Set SKIP_LRC_WHEN_UNSURE = false to disable that.
(function() {
    'use strict';

    const PLAYER_ID = 'player';
    let lastTitle = '', lastArtist = '';
    let animationFrameId = null;

    let basePositionMs = 0;
    let baseClientTimeMs = 0;
    let isTimerInitialized = false;
    let isPlaying = true;

    // Last time value actually handed to the lyrics component.
    let lastAppliedMs = 0;

    // Corrections smaller than this are ignored.
    const DRIFT_THRESHOLD_MS = 50;

    // Backward jumps smaller than this are never applied (clock holds still
    // instead). Matches am-lyrics 1.5.x's own "real seek" threshold.
    const SEEK_BACK_MS = 1000;

    // A single out-of-threshold reading can be a transient/glitchy OS sample.
    // Require two consecutive updates to agree before recalibrating.
    let pendingDrift = null;
    const DRIFT_CONFIRM_TOLERANCE_MS = 200;

    function getPlayer() {
        return document.getElementById(PLAYER_ID);
    }

    function getCurrentPositionMs() {
        if (!isTimerInitialized) return 0;
        if (!isPlaying) return basePositionMs; // frozen while paused
        return basePositionMs + (performance.now() - baseClientTimeMs);
    }

    // The only place that writes currentTime to the component.
    function applyToPlayer(ms) {
        const player = getPlayer();
        if (!player) return;

        // Small backward step: hold still instead of rewinding the lyrics.
        if (ms < lastAppliedMs && lastAppliedMs - ms < SEEK_BACK_MS) {
            ms = lastAppliedMs;
        }
        if (ms === lastAppliedMs) return; // nothing changed (e.g. paused)

        lastAppliedMs = ms;
        player.currentTime = ms;
    }

    function calibrate(positionMs) {
        if (positionMs < 0) return;
        basePositionMs = positionMs;
        baseClientTimeMs = performance.now();
        isTimerInitialized = true;
        applyToPlayer(positionMs);
    }

    function animate() {
        // The next frame must ALWAYS be scheduled. Setting player.currentTime
        // runs am-lyrics' own code (rewind/seek animation in 1.8.9); if that
        // ever throws, an unguarded loop would die here and the lyrics would
        // freeze for good, which looks exactly like a "hang".
        try {
            if (isTimerInitialized) {
                applyToPlayer(getCurrentPositionMs());
            }
        } catch (e) {
            console.error('[Lyrics] am-lyrics threw while setting currentTime (clock kept alive):', e);
        }
        animationFrameId = requestAnimationFrame(animate);
    }

    // ── lrc.red version-aware ISRC lookup ────────────────────────────────
    const LOOKUP_SETTLE_MS = 500;      // let the real track length arrive from the feed
    const LOOKUP_TIMEOUT_MS = 2500;
    const CONFIDENT_SCORE = 9;         // best candidate must reach this to be trusted
    const SKIP_LRC_WHEN_UNSURE = true; // skip lrc.red when no candidate is trusted

    // Words that mark a different recording/version of a song.
    const VERSION_WORDS = /\b(remix|remixed|mix|mixed|live|acoustic|instrumental|karaoke|edit|sped up|slowed|reverb|cover|demo|rework|reworked|bootleg|vip|dub|extended|mashup|session|stripped|unplugged|acapella|a cappella)\b/;
    // Tags that do NOT indicate a different recording.
    const BENIGN_TAG = /^(original|original mix|original version|album version|single version|explicit|clean)$/;

    let trackToken = 0; // guards against rapid track skipping

    // Keeps letters/numbers from every script (so Japanese, Korean, Cyrillic...
    // titles don't all collapse to ""), strips Latin accents, drops punctuation.
    function normalize(s) {
        return String(s || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .normalize('NFC')
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
    }

    function hasLatin(s) {
        return /[a-z]/.test(s);
    }

    // "Blame (feat. John Newman)" -> "Blame"
    function stripFeatTag(title) {
        return title
            .replace(/\s*[\(\[]\s*(?:feat|ft|featuring|with)\b[^\)\]]*[\)\]]/gi, '')
            .trim() || title;
    }

    // Splits "Song (feat. X) [Y Remix]" into base title and normalized tags.
    function splitTitle(title) {
        const tags = [];
        // Players write "Song - Single Version", catalogues write
        // "Song (Single Version)": treat the suffix as a bracketed tag.
        const unified = String(title || '').replace(/\s+[-\u2013\u2014]\s+([^()\[\]]+)$/, ' ($1)');
        const base = unified.replace(/\s*[\(\[]([^\)\]]*)[\)\]]/g, function (m, inner) {
            tags.push(normalize(inner));
            return ' ';
        });
        return { base: normalize(base), tags: tags };
    }

    function versionTags(parts) {
        return parts.tags.filter(function (t) {
            return !/^(feat|ft|featuring|with)\b/.test(t)
                && VERSION_WORDS.test(t)
                && !BENIGN_TAG.test(t);
        }).sort();
    }

    // "Calvin Harris, Ellie Goulding" -> ["calvin harris", "ellie goulding"]
    function artistList(s) {
        return String(s || '')
            .split(/\s*(?:,|;|\/|&|\band\b|\bfeat(?:uring)?\b\.?|\bft\b\.?|\bwith\b|\bx\b)\s*/i)
            .map(normalize)
            .filter(Boolean);
    }

    // true = same artist, false = different artist, null = can't tell
    function artistsMatch(playingArtist, hitArtist) {
        const p = artistList(playingArtist);
        const h = artistList(hitArtist);
        if (!p.length || !h.length) return null;

        // "Ellie Goulding" vs "エリー・ゴールディング": same person, different
        // script. Names in different scripts can't be compared, so don't call
        // it a mismatch.
        if (hasLatin(normalize(playingArtist)) !== hasLatin(normalize(hitArtist))) return null;

        for (let i = 0; i < p.length; i += 1) {
            for (let j = 0; j < h.length; j += 1) {
                if (p[i] === h[j]) return true;
            }
        }
        // "The Chainsmokers" vs "Chainsmokers": whole-string containment
        const fp = normalize(playingArtist);
        const fh = normalize(hitArtist);
        if (fp.length >= 5 && fh.length >= 5 && (fp.indexOf(fh) !== -1 || fh.indexOf(fp) !== -1)) {
            return true;
        }
        return false;
    }

    // The artist is decisive: two different songs can share a title AND have
    // almost the same length, while the SAME recording often differs by a few
    // seconds between releases. So length is a tie-breaker, not the deciding
    // factor.
    function scoreHit(hit, playing, rank) {
        const h = splitTitle(hit.title);
        const p = splitTitle(playing.title);
        let score = 0;

        // Artist
        const sameArtist = artistsMatch(playing.artist, hit.artist);
        if (sameArtist === true) score += 6;
        else if (sameArtist === false) score -= 10;

        // Title: base title, plus a bonus for the exact full title ("(feat. X)" included)
        if (h.base === p.base) score += 3;
        else if (h.base.indexOf(p.base) === -1 && p.base.indexOf(h.base) === -1) score -= 5;
        if (normalize(hit.title) === normalize(playing.title)) score += 2;

        // Version tags (remix / live / ...) must agree
        score += (versionTags(h).join('|') === versionTags(p).join('|')) ? 2 : -6;

        // Length: up to ~6s apart is normal between releases of one recording
        if (playing.durationSec > 0 && typeof hit.duration === 'number') {
            const d = Math.abs(hit.duration - playing.durationSec);
            score += d <= 1.5 ? 3 : d <= 3 ? 2 : d <= 6 ? 1 : d <= 10 ? -1 : -3;
        }

        // Tiny tie-break in favour of lrc.red's own ranking
        return score - rank * 0.1;
    }

    // Returns hits sorted best-first with scores, or null on failure.
    async function lookupCandidates(title, artist, durationSec) {
        const params = new URLSearchParams({ track: stripFeatTag(title), artist: artist });
        if (durationSec > 0) params.set('duration', String(Math.round(durationSec)));

        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, LOOKUP_TIMEOUT_MS);
        try {
            const res = await fetch('https://lrc.red/match.json?' + params.toString(), {
                signal: controller.signal
            });
            if (!res.ok) return null;
            const data = await res.json();
            const hits = (Array.isArray(data.hits) ? data.hits : [])
                .filter(function (h) { return h && h.isrc; });
            if (!hits.length) return [];

            const playing = { title: title, artist: artist, durationSec: durationSec };
            return hits
                .map(function (hit, i) { return { hit: hit, score: scoreHit(hit, playing, i) }; })
                .sort(function (a, b) { return b.score - a.score; });
        } catch (e) {
            console.warn('[Lyrics] lrc.red lookup failed:', e && e.message);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    // ── Spotify ISRC (from time-transferrer.js via clock.py + media-bridge.js) ──
    // window.__mediaState.spotify = { title, artist, durationMs, isrc|null, ... }
    // The ISRC is only trusted when Spotify's track is the one that is
    // actually playing (title + artist agree), because Windows' media session
    // can show a different player than the one the extension reports.
    const SPOTIFY_ISRC_WAIT_MS = 2000; // how long to wait for a pending ISRC
    // Kill switch for bisecting: false = behave exactly like before the Spotify
    // ISRC work (scored lrc.red lookup only, no spotify-id / song-album).
    const USE_SPOTIFY = false;

    function spotifyMatches(title, artist) {
        const sp = window.__mediaState && window.__mediaState.spotify;
        if (!sp || !sp.title) return false;
        const a = splitTitle(stripFeatTag(title));
        const b = splitTitle(stripFeatTag(sp.title));
        if (a.base !== b.base) return false;
        if (versionTags(a).join('|') !== versionTags(b).join('|')) return false;
        return artistsMatch(artist, sp.artist) !== false; // unknown script = give benefit of the doubt
    }

    // Only hand am-lyrics a Spotify ISRC that lrc.red really has. Spotify's ISRC
    // can belong to a different release than the one lrc.red catalogued; on a
    // miss, am-lyrics falls through to its slower provider chain (each with
    // multi-second timeouts), which looks like a hang. On a miss we use the
    // scored lrc.red lookup below instead, exactly as before the Spotify change.
    // (Same URL am-lyrics requests, so a hit is also warm in the HTTP cache.)
    const ISRC_VERIFY_TIMEOUT_MS = 2500;
    async function lrcRedHasIsrc(isrc) {
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, ISRC_VERIFY_TIMEOUT_MS);
        try {
            const res = await fetch('https://lrc.red/s/' + encodeURIComponent(isrc) + '.song.json',
                { signal: controller.signal });
            return res.ok;
        } catch (e) {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    // Spotify track ID (22 chars) and album for the playing track, or '' when
    // Spotify's track isn't the one playing. Passed to am-lyrics as spotify-id /
    // song-album: with a spotify-id, 1.8.x skips its own ISRC->Spotify lookup
    // (link.binimum.org) and its anonymous-token Spotify search before asking
    // Spicy Lyrics. Always set (to '' when unknown) so a previous track's ID
    // can never linger.
    function spotifyExtras(title, artist) {
        const sp = window.__mediaState && window.__mediaState.spotify;
        if (!USE_SPOTIFY || !sp || !spotifyMatches(title, artist)) return { spotifyId: '', album: '' };
        const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(sp.uri || '');
        return { spotifyId: m ? m[1] : '', album: sp.album || '' };
    }

    // Resolves with the ISRC for this track, or '' if Spotify has none for it.
    function waitForSpotifyIsrc(title, artist, token) {
        return new Promise(function (resolve) {
            function check() {
                if (token !== trackToken) return finish('');
                const sp = window.__mediaState.spotify;
                if (sp && sp.isrc && spotifyMatches(title, artist)) return finish(sp.isrc);
                return null;
            }
            function finish(v) {
                clearTimeout(timer);
                window.removeEventListener('track-meta', onMeta);
                resolve(v);
                return true;
            }
            function onMeta() { check(); }
            const timer = setTimeout(function () { finish(''); }, SPOTIFY_ISRC_WAIT_MS);
            window.addEventListener('track-meta', onMeta);
            check();
        });
    }

    // Diagnostic: logs how long am-lyrics stays in its loading state after we
    // hand it a track, so a "hang" shows up in the console with a timestamp.
    let watchId = 0;
    function watchLoading(player, title, isrc) {
        const id = ++watchId;
        const t0 = performance.now();
        const timer = setInterval(function () {
            const secs = ((performance.now() - t0) / 1000).toFixed(1);
            if (id !== watchId || !player.isLoading) {
                clearInterval(timer);
                if (id === watchId) {
                    console.log('[Lyrics] am-lyrics finished after ' + secs + 's: source=' +
                        (player.lyricsSource || 'none') + ' for "' + title + '" (isrc ' + isrc + ')');
                }
            } else if (Number(secs) >= 5) {
                console.warn('[Lyrics] am-lyrics still loading after ' + secs + 's for "' + title + '"');
            }
        }, 1000);
    }

    async function applyTrackToPlayer(title, artist) {
        const player = getPlayer();
        if (!player) return;
        const token = ++trackToken;

        let durationSec = 0;
        let choice = null;
        let confident = false;

        if (title && artist) {
            await new Promise(function (resolve) { setTimeout(resolve, LOOKUP_SETTLE_MS); });
            if (token !== trackToken) return; // a newer track took over

            const state = window.__mediaState || {};
            durationSec = state.duration > 0 ? state.duration : 0;

            // Preferred path: Spotify told us the exact ISRC, no match.json needed.
            if (USE_SPOTIFY && spotifyMatches(title, artist)) {
                const isrc = await waitForSpotifyIsrc(title, artist, token);
                if (token !== trackToken) return;
                if (isrc) {
                    const known = await lrcRedHasIsrc(isrc);
                    if (token !== trackToken) return;
                    if (known) {
                        console.log('[Lyrics] using Spotify ISRC ' + isrc + ' for "' + title + '" (lrc.red has it)');
                        window.__skipLrcRed = false;
                        window.__isrcOnly = true;
                        watchLoading(player, title, isrc);
                        player.songTitle = title;
                        player.songArtist = artist;
                        player.query = title + ' ' + artist;
                        player.songDurationMs = durationSec > 0 ? Math.round(durationSec * 1000) : 0;
                        const extras = spotifyExtras(title, artist);
                        player.songAlbum = extras.album;
                        player.spotifyId = extras.spotifyId;
                        player.isrc = isrc;
                        return;
                    }
                    console.log('[Lyrics] lrc.red has no entry for Spotify ISRC ' + isrc + ', using the scored lookup instead');
                } else {
                    console.log('[Lyrics] Spotify has no ISRC for this track, falling back to lrc.red lookup');
                }
            }

            window.__isrcOnly = false;
            const ranked = await lookupCandidates(title, artist, durationSec);
            if (token !== trackToken) return;

            if (ranked && ranked.length) {
                choice = ranked[0];
                confident = choice.score >= CONFIDENT_SCORE;
                console.log('[Lyrics] lrc.red candidates for "' + title + '" (playing length ' +
                    durationSec.toFixed(1) + 's):');
                console.table(ranked.slice(0, 5).map(function (r) {
                    return {
                        title: r.hit.title,
                        artist: r.hit.artist,
                        seconds: r.hit.duration,
                        isrc: r.hit.isrc,
                        score: Number(r.score.toFixed(1))
                    };
                }));
            }
        }

        const useIsrc = Boolean(choice) && confident;
        // When lrc.red HAS results but none is trustworthy, skip it so the
        // component does not take its own top hit (often a remix).
        window.__skipLrcRed = Boolean(choice) && !confident && SKIP_LRC_WHEN_UNSURE;

        if (choice) {
            console.log(useIsrc
                ? '[Lyrics] using ISRC ' + choice.hit.isrc + ' -> "' + choice.hit.title +
                  '" (' + choice.hit.duration + 's, score ' + choice.score.toFixed(1) + ')'
                : '[Lyrics] no confident lrc.red match (best score ' + choice.score.toFixed(1) +
                  '); ' + (window.__skipLrcRed ? 'skipping lrc.red' : 'letting the component search'));
        } else if (title && artist) {
            console.log('[Lyrics] lrc.red: no results, letting the component search by name');
        }

        // One batch so the component only fetches once. isrc is always set
        // (to '' when unknown) so the previous track's ISRC can never linger.
        player.songTitle = title;
        player.songArtist = artist;
        player.query = title + ' ' + artist;
        player.songDurationMs = durationSec > 0 ? Math.round(durationSec * 1000) : 0;
        const fallbackExtras = spotifyExtras(title, artist);
        player.songAlbum = fallbackExtras.album;
        player.spotifyId = fallbackExtras.spotifyId;
        player.isrc = useIsrc ? choice.hit.isrc : '';
        console.log('[Lyrics] track applied to am-lyrics (fallback path): "' + title + '"');
    }

    function onMediaUpdate(event) {
        const detail = event.detail;
        if (!detail) return;

        const { title, artist, position, is_playing } = detail;
        const player = getPlayer();
        if (!player) return;

        const newTitle = title || '';
        const newArtist = artist || '';

        if (newTitle !== lastTitle || newArtist !== lastArtist) {
            console.log(`🎵 ${newTitle} - ${newArtist}`);
            lastTitle = newTitle;
            lastArtist = newArtist;
            applyTrackToPlayer(newTitle, newArtist);
            // New track: the old position no longer applies.
            lastAppliedMs = 0;
            pendingDrift = null;
            const fallback = document.getElementById('fallback-msg');
            if (fallback) fallback.style.display = newTitle ? 'none' : 'block';
        }

        const serverPosMs = position * 1000;
        const playing = is_playing !== false; // undefined counts as playing

        if (!isTimerInitialized) {
            isPlaying = playing;
            calibrate(serverPosMs);
            return;
        }

        // Pause / resume: re-anchor the clock to the server position.
        if (playing !== isPlaying) {
            isPlaying = playing;
            pendingDrift = null;
            calibrate(serverPosMs);
            return;
        }

        const currentMs = getCurrentPositionMs();
        const drift = serverPosMs - currentMs;

        if (Math.abs(drift) > DRIFT_THRESHOLD_MS) {
            const confirmed = pendingDrift !== null
                && Math.sign(pendingDrift) === Math.sign(drift)
                && Math.abs(pendingDrift - drift) < DRIFT_CONFIRM_TOLERANCE_MS;

            if (confirmed) {
                console.log(`[Lyrics] Confirmed drift ${drift.toFixed(0)}ms – correcting`);
                calibrate(serverPosMs);
                pendingDrift = null;
            } else {
                // Wait for the next update to confirm this isn't a one-off glitch
                pendingDrift = drift;
            }
        } else {
            pendingDrift = null;
        }
    }

    // Lets the lookup above veto lrc.red for a track (am-lyrics 1.8.x only).
    function installLrcRedGate() {
        customElements.whenDefined('am-lyrics').then(function () {
            const AmLyricsClass = customElements.get('am-lyrics');
            if (!AmLyricsClass || typeof AmLyricsClass.fetchLyricsFromLrcRed !== 'function') return;
            if (AmLyricsClass.__lrcGateInstalled) return;

            const original = AmLyricsClass.fetchLyricsFromLrcRed;
            AmLyricsClass.fetchLyricsFromLrcRed = function (title, artist, isrc, metadata) {
                if (window.__skipLrcRed) {
                    console.log('[Lyrics] lrc.red skipped for this track');
                    return Promise.resolve(null);
                }
                // Spotify gave us the exact ISRC: try ONLY that. Blanking
                // title/artist/query stops the component from falling back to
                // match.json (and its top hit, often a remix) when lrc.red
                // simply doesn't have this ISRC, and moves straight on to the
                // other providers, which also get the ISRC.
                if (window.__isrcOnly && isrc) {
                    return original.call(this, '', '', isrc, metadata, '', arguments[5]);
                }
                return original.apply(this, arguments);
            };
            AmLyricsClass.__lrcGateInstalled = true;
        });
    }

    // Run __lyricsDebug() in the console while it is stuck and paste the output.
    window.__lyricsDebug = function () {
        const p = getPlayer();
        const sp = window.__mediaState && window.__mediaState.spotify;
        return {
            clockAlive: animationFrameId !== null,
            clockInitialized: isTimerInitialized,
            isPlaying: isPlaying,
            lastAppliedMs: Math.round(lastAppliedMs),
            playerCurrentTime: p ? Math.round(p.currentTime) : null,
            playerIsLoading: p ? p.isLoading : null,
            playerLyricsLines: p && p.lyrics ? p.lyrics.length : (p ? 'none' : null),
            playerSource: p ? p.lyricsSource : null,
            playerIsrc: p ? p.isrc : null,
            playerSpotifyId: p ? p.spotifyId : null,
            playerTitle: p ? p.songTitle : null,
            skipLrcRed: window.__skipLrcRed,
            spotify: sp || null
        };
    };

    function init() {
        console.log('[Lyrics] Pause-aware clock + version-aware lrc.red lookup started.');
        installLrcRedGate();
        window.addEventListener('media-update', onMediaUpdate);
        animationFrameId = requestAnimationFrame(animate);

        if (window.__mediaState && window.__mediaState.title) {
            onMediaUpdate({ detail: window.__mediaState });
        }
    }

    window.addEventListener('beforeunload', () => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
