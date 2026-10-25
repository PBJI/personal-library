function loadEpubLibrary() {
  if (window.ePub) return Promise.resolve(window.ePub);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-epubjs]');
    if (existing) { existing.addEventListener('load', () => resolve(window.ePub), { once: true }); existing.addEventListener('error', () => reject(new Error('EPUB reader library failed to load.')), { once: true }); return; }
    const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js'; script.dataset.epubjs = '1';
    script.onload = () => window.ePub ? resolve(window.ePub) : reject(new Error('EPUB reader library loaded without its API.'));
    script.onerror = () => reject(new Error('Could not load the EPUB reader library. Connect to the internet and retry.'));
    document.head.append(script);
  });
}

export async function mountEPUBReader(container, { resource, blob, progress = {}, onProgress = () => {} }) {
  let book, rendition, sourceUrl = null, destroyed = false;
  container.innerHTML = `<div class="reader-toolbar epub-toolbar"><button class="button secondary small" data-epub="prev">← Previous</button><span id="epubLocation">Opening book…</span><button class="button secondary small" data-epub="next">Next →</button></div><div id="epubViewport" class="epub-viewport"></div><div class="reader-hint">EPUB navigation and position tracking are provided by the reader library. The book file is stored in this browser unless it was linked from its original location.</div>`;
  try {
    const ePub = await loadEpubLibrary();
    if (destroyed) return () => {};
    if (blob) { sourceUrl = URL.createObjectURL(blob); book = ePub(sourceUrl); }
    else if (resource.source?.url) book = ePub(resource.source.url);
    else throw new Error('No EPUB file is attached to this resource.');
    rendition = book.renderTo('epubViewport', { width: '100%', height: '100%', flow: 'paginated', spread: 'auto', manager: 'default' });
    const location = progress.cfi || undefined;
    await rendition.display(location);
    const locationsPromise = book.locations.generate(800).catch(() => null);
    rendition.on('relocated', loc => {
      if (destroyed || !loc?.start) return;
      const pct = book.locations?.percentageFromCfi?.(loc.start.cfi);
      const displayed = loc.start.displayed || {};
      container.querySelector('#epubLocation').textContent = Number.isFinite(pct) ? `${Math.round(pct * 100)}% · Section ${loc.start.href || ''}` : `Section ${loc.start.href || 'current'}`;
      onProgress({ ...progress, cfi: loc.start.cfi, currentSection: loc.start.href || '', currentPage: displayed.page || null, pageCount: displayed.total || null, percentage: Number.isFinite(pct) ? Math.round(pct * 100) : progress.percentage || null, lastViewedAt: new Date().toISOString() });
    });
    locationsPromise.then(() => { if (!destroyed && rendition?.currentLocation?.()) { const loc = rendition.currentLocation(); if (loc?.start?.cfi) rendition.display(loc.start.cfi); } });
    const handler = ev => { const button = ev.target.closest('[data-epub]'); if (!button) return; if (button.dataset.epub === 'prev') rendition?.prev(); if (button.dataset.epub === 'next') rendition?.next(); };
    container.addEventListener('click', handler);
    return () => { destroyed = true; container.removeEventListener('click', handler); try { rendition?.destroy(); book?.destroy(); } catch {} if (sourceUrl) URL.revokeObjectURL(sourceUrl); };
  } catch (error) {
    container.innerHTML = `<div class="reader-state error-state"><strong>Could not open this EPUB.</strong><p>${escapeText(error?.message || 'The file may be invalid or the source may block access.')}</p>${resource.source?.url ? `<a class="button primary" href="${escapeAttr(resource.source.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : '<p>Import a local EPUB copy and retry.</p>'}</div>`;
    return () => { destroyed = true; try { rendition?.destroy(); book?.destroy(); } catch {} if (sourceUrl) URL.revokeObjectURL(sourceUrl); };
  }
}
function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(value) { return escapeText(value); }
