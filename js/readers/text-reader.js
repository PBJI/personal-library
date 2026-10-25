export function mountTextReader(container, { resource, blob, progress = {}, onProgress = () => {}, onActivity = () => {} }) {
  let destroyed = false, activeSeconds = Number(progress.activeSeconds || 0), maxScrollPercent = Number(progress.maxScrollPercent || 0), timer = null, objectUrl = null;
  container.innerHTML = `<div class="text-reader-shell"><div class="text-reader-toolbar"><span class="type-chip">${escapeText(String(resource.type || 'text').toUpperCase())} RESOURCE</span><button class="button secondary small" data-text="mark">Mark explored</button><button class="button secondary small" data-text="note">Save a note</button></div><article id="resourceTextContent" class="resource-text-content"><p class="muted">Loading content…</p></article><div class="text-progress"><span id="textScrollLabel">Reading position: ${maxScrollPercent}%</span><div class="progress-track"><span id="textScrollBar" style="width:${maxScrollPercent}%"></span></div><span id="textActiveLabel">Active time: ${activeSeconds}s</span></div></div>`;
  const article = container.querySelector('#resourceTextContent');
  const ready = async () => {
    let text = resource.sampleText || resource.description || 'This resource has metadata but no readable text attached.';
    if (blob) text = await blob.text();
    if (destroyed) return;
    article.textContent = text;
    article.classList.add('reader-prose');
    requestAnimationFrame(updateScroll);
  };
  ready().catch(error => { article.textContent = `Could not read this resource: ${error.message}`; });
  function updateScroll() {
    if (destroyed) return;
    const max = article.scrollHeight - article.clientHeight;
    const percent = max > 0 ? Math.round(article.scrollTop / max * 100) : 100;
    maxScrollPercent = Math.max(maxScrollPercent, percent);
    container.querySelector('#textScrollLabel').textContent = `Furthest reading position: ${maxScrollPercent}%`;
    container.querySelector('#textScrollBar').style.width = `${maxScrollPercent}%`;
    onProgress({ ...progress, maxScrollPercent, activeSeconds, status: maxScrollPercent >= 100 ? 'explored' : progress.status || 'reading', lastViewedAt: new Date().toISOString() });
  }
  article.addEventListener('scroll', updateScroll, { passive: true });
  let lastTick = Date.now();
  timer = setInterval(() => {
    if (destroyed || document.hidden) { lastTick = Date.now(); return; }
    const now = Date.now(); activeSeconds += Math.min(2, (now - lastTick) / 1000); lastTick = now;
    container.querySelector('#textActiveLabel').textContent = `Active time: ${Math.floor(activeSeconds)}s`;
    onProgress({ ...progress, maxScrollPercent, activeSeconds: Math.floor(activeSeconds), lastViewedAt: new Date().toISOString() });
  }, 1000);
  const click = ev => {
    const btn = ev.target.closest('[data-text]'); if (!btn) return;
    if (btn.dataset.text === 'mark') { onProgress({ ...progress, status: 'explored', exploredAt: new Date().toISOString(), maxScrollPercent, activeSeconds: Math.floor(activeSeconds) }); onActivity('Marked a text resource explored'); btn.textContent = '✓ Explored'; }
    if (btn.dataset.text === 'note') document.dispatchEvent(new CustomEvent('neo:new-note-for-resource', { detail: { resourceId: resource.id } }));
  };
  container.addEventListener('click', click);
  return () => { destroyed = true; clearInterval(timer); article.removeEventListener('scroll', updateScroll); container.removeEventListener('click', click); if (objectUrl) URL.revokeObjectURL(objectUrl); };
}
function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
