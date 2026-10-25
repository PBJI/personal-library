export async function mountPDFReader(container, { resource, blob, progress = {}, onProgress = () => {} }) {
  let pdf = null, renderTask = null, page = Number(progress.currentPage || 1), destroyed = false;
  let visitedPages = new Set(Array.isArray(progress.visitedPages) ? progress.visitedPages : []);
  let urlForSource = null;
  container.innerHTML = `<div class="reader-toolbar pdf-toolbar"><button class="button secondary small" data-pdf="prev">← Previous</button><label>Page <input id="pdfPageInput" type="number" min="1" value="1" aria-label="PDF page number"> <span id="pdfPageTotal">of …</span></label><button class="button secondary small" data-pdf="next">Next →</button><span class="reader-progress-label" id="pdfProgressLabel">Pages visited: ${visitedPages.size}</span></div><div class="pdf-canvas-wrap" id="pdfCanvasWrap"><div class="reader-state">Loading PDF…</div></div><div class="reader-hint">Pages count as visited when they are rendered. Skipping to a page does not mark the pages in between.</div>`;
  const canvasWrap = container.querySelector('#pdfCanvasWrap');
  const updateProgress = () => onProgress({ ...progress, currentPage: page, furthestPage: Math.max(Number(progress.furthestPage || 0), page), visitedPages: [...visitedPages].sort((a,b)=>a-b), pageCount: pdf?.numPages || progress.pageCount || null, percentage: pdf?.numPages ? Math.round(visitedPages.size / pdf.numPages * 100) : null, lastViewedAt: new Date().toISOString() });
  try {
    let pdfjs;
    try { pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs'); }
    catch { pdfjs = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs'); }
    if (destroyed) return () => {};
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
    const input = blob ? { data: await blob.arrayBuffer() } : { url: resource.source?.url, withCredentials: false };
    if (blob) urlForSource = URL.createObjectURL(blob);
    pdf = await pdfjs.getDocument(input).promise;
    page = Math.max(1, Math.min(pdf.numPages, page));
    container.querySelector('#pdfPageTotal').textContent = `of ${pdf.numPages}`;
    container.querySelector('#pdfPageInput').max = pdf.numPages;
    async function renderPage(target) {
      if (!pdf || destroyed) return;
      page = Math.max(1, Math.min(pdf.numPages, Number(target) || 1));
      container.querySelector('#pdfPageInput').value = page;
      if (renderTask) { try { renderTask.cancel(); } catch {} renderTask = null; }
      const pdfPage = await pdf.getPage(page);
      if (destroyed) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const availableWidth = Math.max(280, canvasWrap.clientWidth - 28);
      const scale = Math.min(1.8, availableWidth / base.width);
      const viewport = pdfPage.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page-canvas';
      const ctx = canvas.getContext('2d', { alpha: false });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * dpr); canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`; canvas.style.height = `${Math.floor(viewport.height)}px`;
      ctx.setTransform(dpr,0,0,dpr,0,0);
      canvasWrap.replaceChildren(canvas);
      renderTask = pdfPage.render({ canvasContext: ctx, viewport });
      try { await renderTask.promise; } catch (error) { if (error?.name !== 'RenderingCancelledException') throw error; }
      visitedPages.add(page);
      container.querySelector('#pdfProgressLabel').textContent = `Pages visited: ${visitedPages.size} / ${pdf.numPages}`;
      updateProgress();
      renderTask = null;
    }
    const clickHandler = ev => {
      const button = ev.target.closest('[data-pdf]'); if (!button) return;
      if (button.dataset.pdf === 'prev') renderPage(page - 1).catch(showError);
      if (button.dataset.pdf === 'next') renderPage(page + 1).catch(showError);
    };
    const keyHandler = ev => { if (ev.key === 'Enter' && ev.target.id === 'pdfPageInput') renderPage(ev.target.value).catch(showError); };
    container.addEventListener('click', clickHandler); container.addEventListener('keydown', keyHandler);
    const resize = () => { if (pdf && !destroyed) renderPage(page).catch(() => {}); };
    let resizeTimer;
    const ro = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150); });
    ro.observe(canvasWrap);
    await renderPage(page);
    return () => { destroyed = true; clearTimeout(resizeTimer); ro.disconnect(); container.removeEventListener('click', clickHandler); container.removeEventListener('keydown', keyHandler); try { renderTask?.cancel(); } catch {} try { pdf?.destroy(); } catch {} if (urlForSource) URL.revokeObjectURL(urlForSource); };
  } catch (error) {
    canvasWrap.innerHTML = `<div class="reader-state error-state"><strong>Could not render this PDF.</strong><p>${escapeText(error?.message || 'The file may be blocked by cross-origin rules or may be invalid.')}</p>${resource.source?.url ? `<a class="button primary" href="${escapeAttr(resource.source.url)}" target="_blank" rel="noopener noreferrer">Open source in a new tab ↗</a>` : '<p>Try importing a local copy of the file.</p>'}</div>`;
    return () => { destroyed = true; try { pdf?.destroy(); } catch {} if (urlForSource) URL.revokeObjectURL(urlForSource); };
  }
}
function showError(error) { console.error(error); }
function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(value) { return escapeText(value); }
