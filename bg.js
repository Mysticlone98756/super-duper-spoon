import { Kawarp } from 'https://cdn.jsdelivr.net/npm/@kawarp/core/+esm';

const canvas = document.getElementById("bg");

// 🎛️ Base Kawarp settings
const kawarp = new Kawarp(canvas, {
    warpIntensity: 0.80,
    blurPasses: 8,
    animationSpeed: 1.7,
    transitionDuration: 3500,
    saturation: 2.75,
    tintIntensity: 0.0,
    dithering: 0.0,
    scale: 1.02
});

// Exposed so wallapaper_engine.js / cover-changer.js can hand already-decoded
// bitmaps straight to the renderer (loadImageElement) instead of always
// round-tripping through a cover.png disk write + re-read. Without this,
// that "fast path" branch in those files silently never ran.
window.__kawarp = kawarp;

kawarp.start();

// ---- state ----
let lastPath = "";
let busy = false;

// When wallpaperWriteFile isn't available, artwork is applied straight from
// a data URL (see 'cover-updated' listener below) instead of being written
// to cover.png. While that's true for the current track, the disk-polling
// loadCover() below must NOT run — the file on disk never actually changed,
// so reloading it would revert the visible background back to stale art.
let currentCoverDataUrl = null;
let lastCoverTitle = "";

window.addEventListener("media-update", (event) => {
    const detail = event.detail;
    if (detail && detail.title && detail.title !== lastCoverTitle) {
        lastCoverTitle = detail.title;
        // New track — drop the stale in-memory art so disk polling can
        // resume as an interim state until fresh art arrives for it.
        currentCoverDataUrl = null;
    }
});

// ---- cover loader (NO blob, NO fetch) ----
// Retries with backoff on failure: wallpaperWriteFile()'s underlying disk
// write isn't guaranteed to have landed by the time we try to read it back,
// so a single failed attempt used to mean the background silently never
// updated until the next track change.
const COVER_LOAD_MAX_ATTEMPTS = 5;
const COVER_LOAD_BASE_DELAY_MS = 150;

async function loadCover(attempt = 0) {
    if (busy) return;
    if (currentCoverDataUrl) return; // accurate art already applied via event; skip disk poll
    busy = true;

    try {
        const img = new Image();

        // THIS is the key: force bypass cache
        img.src = "./cover.png?cache=" + Math.random();

        await new Promise((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = reject;
        });

        await kawarp.loadImage(img.src);
        busy = false;

    } catch (e) {
        busy = false;
        if (attempt < COVER_LOAD_MAX_ATTEMPTS) {
            const delay = COVER_LOAD_BASE_DELAY_MS * (attempt + 1);
            setTimeout(() => loadCover(attempt + 1), delay);
        } else {
            console.error("cover load failed after retries:", e);
        }
    }
}

// ---- initial load ----
loadCover();

// ---- polling (Wallpaper Engine safe method) ----
setInterval(() => loadCover(), 3500);

// ---- immediate update when the in-memory fallback fires ----
// (used when wallpaperWriteFile isn't available, so cover.png on disk
// never actually changes and the poll above would find nothing new)
window.addEventListener('cover-updated', (event) => {
    const dataUrl = event.detail && event.detail.dataUrl;
    if (dataUrl) {
        currentCoverDataUrl = dataUrl;
        kawarp.loadImage(dataUrl).catch((e) => {
            console.error("cover load failed (fallback):", e);
        });
    } else {
        // Real write to cover.png happened — fine to let disk polling resume.
        // The writer waits for the write to settle before dispatching this
        // event, and loadCover() itself retries on failure, so it's safe to
        // kick off a load right away instead of waiting for the next poll tick.
        currentCoverDataUrl = null;
        loadCover();
    }
});

// ---- resize safety ----
window.addEventListener("resize", () => {
    kawarp.resize?.();
});
