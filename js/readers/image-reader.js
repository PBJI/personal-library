export function mountImageReader(container, { resource, blob, progress = {}, onProgress = () => {}, onActivity = () => {} }) {
  let objectUrl = null, timer = null, seconds = 0, clean = false, viewedAt = progress.viewedAt || null, viewCount = Number(progress.viewCount || 0), markedViewed = !!viewedAt;
  if (blob) objectUrl = URL.createObjectURL(blob);
  const src = objectUrl || resource.source?.url;
  container.innerHTML = `<div class="image-viewer-wrap"><div class="image-stage"><div class="reader-state">Loading image…</div><img id="resourceImage" alt="${escapeAttr(resource.title || 'Imported image')}" hidden></div><aside class="image-info"><span class="type-chip">IMAGE RESOURCE</span><h3>${escapeText(resource.title)}</h3><p>${escapeText(resource.description || 'An image in your knowledge universe.')}</p><div class="mini-stat-grid"><div><small>STATUS</small><strong id="imageViewStatus">${markedViewed ? 'Viewed' : 'Not viewed yet'}</strong></div><div><small>ACTIVE TIME</small><strong id="imageActiveTime">${Number(progress.activeSeconds || 0)} sec</strong></div><div><small>VIEWS</small><strong id="imageViewCount">${Number(progress.viewCount || 0)}</strong></div></div><p class="muted">An image counts as viewed after it loads and remains visible for one second while this tab is active.</p></aside></div>`;
  const img = container.querySelector('#resourceImage');
  if (!src) { container.querySelector('.reader-state').textContent = 'No image source is available.'; return () => {}; }
  let lastTick = Date.now();
  timer = setInterval(() => {
    if (clean || document.hidden || !img.complete || !img.naturalWidth) { lastTick = Date.now(); return; }
    const now = Date.now(); const delta = Math.min(2, (now - lastTick) / 1000); lastTick = now; seconds += delta;
    const next = { ...progress, activeSeconds: Math.floor(Number(progress.activeSeconds || 0) + seconds), lastViewedAt: new Date().toISOString(), viewedAt, viewCount };
    container.querySelector('#imageActiveTime').textContent = `${next.activeSeconds} sec`;
    if (!markedViewed && seconds >= 1) {
      markedViewed = true; viewedAt = new Date().toISOString(); viewCount = Number(progress.viewCount || 0) + 1; next.viewedAt = viewedAt; next.viewCount = viewCount;
      container.querySelector('#imageViewStatus').textContent = 'Viewed'; container.querySelector('#imageViewCount').textContent = next.viewCount;
      onActivity('Viewed an image');
    }
    onProgress(next);
  }, 1000);
  img.addEventListener('load', () => { container.querySelector('.reader-state')?.remove(); img.hidden = false; });
  img.addEventListener('error', () => { const status = container.querySelector('.reader-state') || document.createElement('div'); status.className = 'reader-state error-state'; status.textContent = 'The image could not be loaded. The source may be unavailable or block access.'; container.querySelector('.image-stage').append(status); });
  img.src = src;
  return () => { clean = true; clearInterval(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); };
}
function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(value) { return escapeText(value); }
