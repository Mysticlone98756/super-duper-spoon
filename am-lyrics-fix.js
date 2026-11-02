// am-lyrics-fix.js
// Permanent workaround: hides am-lyrics' header (romanize / translate buttons,
// format <select>, download button). In Wallpaper Engine's embedded browser,
// rendering that header takes down the renderer ("Aw, Snap!") as soon as
// lyrics load. A wallpaper has no use for those controls anyway.
//
// Found by bisecting: with every other feature enabled, hiding only the header
// stopped the crash on am-lyrics 1.6.0.
//
// Add as a classic script in index.html (position doesn't matter):
//   <script src="am-lyrics-fix.js"></script>
(function () {
    'use strict';

    const CSS = '.lyrics-header{display:none!important}';

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
