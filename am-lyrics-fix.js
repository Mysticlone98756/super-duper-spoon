// am-lyrics-fix.js
// Two permanent workarounds for @uimaxbai/am-lyrics:
//
// 1) Hides am-lyrics' header (romanize / translate buttons, format <select>,
//    download button). In Wallpaper Engine's embedded browser, rendering that
//    header takes down the renderer ("Aw, Snap!") as soon as lyrics load. A
//    wallpaper has no use for those controls anyway.
//    (Found by bisecting on 1.6.0.)
//
// 2) Fixes a render crash in the source footer that freezes the lyrics:
//        Uncaught (in promise) TypeError: Cannot set properties of null
//        (setting 'data')   at lit-html
//    am-lyrics renders the footer's "Switch" label with a Lit binding
//    (<span class="source-switch-label">${...}</span>) AND ALSO overwrites that
//    span's textContent by hand in its private _updateFooter(). Setting
//    textContent deletes the marker nodes Lit uses to track the binding, so the
//    next render that changes the label (e.g. "Switch" -> "Switching...", which
//    happens while am-lyrics works through its provider chain) throws, and the
//    component can no longer re-render: the old lyrics stay on screen.
//    This replacement keeps the button state and spinner updates and only
//    drops the one write that corrupts Lit's bookkeeping. Lit still renders
//    the label itself on the next render.
//    (Present in 1.8.2 and 1.8.9; harmless if a later version fixes it.)
//
// Add as a classic script in index.html (position doesn't matter):
//   <script src="am-lyrics-fix.js"></script>
(function () {
    'use strict';

    const CSS = '.lyrics-header{display:none!important}';

    // ── 2) footer crash fix ──────────────────────────────────────────────
    customElements.whenDefined('am-lyrics').then(() => {
        const AmLyricsClass = customElements.get('am-lyrics');
        const proto = AmLyricsClass && AmLyricsClass.prototype;
        if (!proto || typeof proto._updateFooter !== 'function') {
            console.warn('[AmLyricsFix] _updateFooter not found on am-lyrics (renamed or fixed upstream?); footer fix NOT applied');
            return;
        }
        if (proto.__footerFixInstalled) return;

        proto._updateFooter = function () {
            const footer = this.shadowRoot && this.shadowRoot.querySelector('.lyrics-footer');
            if (!footer) return;
            const switchBtn = footer.querySelector('.source-switch-btn');
            const svgEl = footer.querySelector('.source-switch-svg');
            if (switchBtn) switchBtn.disabled = this.isFetchingAlternatives;
            if (svgEl) svgEl.classList.toggle('is-loading', this.isFetchingAlternatives);
            // NOT written here: labelEl.textContent. Lit owns that text node.
        };
        proto.__footerFixInstalled = true;
        console.log('[AmLyricsFix] footer label write disabled');
    });

    // ── 1) header hiding ─────────────────────────────────────────────────
    customElements.whenDefined('am-lyrics').then(() => {
        const apply = () => {
            const player = document.getElementById('player');
            if (!player || !player.shadowRoot) {
                requestAnimationFrame(apply); // wait for the element to render
                return;
            }
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(CSS);
            player.shadowRoot.adoptedStyleSheets = [
                ...player.shadowRoot.adoptedStyleSheets,
                sheet
            ];
            console.log('[AmLyricsFix] header hidden');
        };
        apply();
    });
})();
