// bg-scrim.js – darkens the Kawarp layer in proportion to how bright the cover is
(function () {
    'use strict';

    const MIN_SCRIM = 0.10;   // dark covers
    const MAX_SCRIM = 0.55;   // pure-white covers
    const SAMPLE_SIZE = 32;   // downscale target; plenty for an average

    const probe = document.createElement('canvas');
    probe.width = probe.height = SAMPLE_SIZE;
    const ctx = probe.getContext('2d', { willReadFrequently: true });

    function luminanceOf(source) {
        ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        ctx.drawImage(source, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const px = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) {
            // Rec. 709 relative luminance
            sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        }
        return sum / (px.length / 4) / 255; // 0..1
    }

    function applyScrim(lum) {
        // Only ramp up once the cover is genuinely bright (lum > ~0.35)
        const t = Math.min(1, Math.max(0, (lum - 0.35) / 0.55));
        const scrim = MIN_SCRIM + t * (MAX_SCRIM - MIN_SCRIM);
        document.documentElement.style.setProperty('--scrim', scrim.toFixed(3));
        console.log('[Scrim] luminance ' + lum.toFixed(2) + ' -> scrim ' + scrim.toFixed(2));
    }

    window.addEventListener('cover-updated', function (event) {
        try {
            const d = event.detail || {};
            if (d.canvas) {
                applyScrim(luminanceOf(d.canvas));
            } else if (d.dataUrl) {
                const img = new Image();
                img.onload = function () { applyScrim(luminanceOf(img)); };
                img.src = d.dataUrl;
            }
        } catch (e) {
            console.warn('[Scrim] could not measure cover:', e);
        }
    });
})();