export function mountWebsiteReader(container, { resource, progress = {}, onProgress = () => {}, onActivity = () => {} }) {
  let destroyed = false, activeSeconds = Number(progress.activeSeconds || 0), lastScrollY = Number(progress.scrollY || 0), scrollPercent = Number(progress.scrollPercent || 0), loaded = false, timer = null, visitedPages = new Set(progress.visitedPages || []), openedAt = progress.openedAt || null, firstOpenCounted = !!progress.openedAt;
  const url = resource.source?.url || '';
  if (!url) {
    container.innerHTML = `<div class="reader-state error-state"><strong>No website URL is attached to this resource.</strong><p>Add or edit the resource URL before opening an embedded website. A blank URL should not load Neo World inside itself, because recursion is not a learning strategy.</p><button class="button secondary" data-action="resource-menu" data-id="${escapeAttr(resource.id)}">Edit resource metadata</button></div>`;
    return () => { destroyed = true; };
  }
  container.innerHTML = `<div class="website-reader"><div class="website-controls"><span class="secure-link">↗ External content</span><a class="button primary" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">Open website in new tab ↗</a></div><div class="website-frame-wrap"><div id="websiteFrameStatus" class="embed-status">Embedded frame requested. Some websites block iframe viewing; if this frame is blank, use Open website in new tab.</div><iframe id="websiteFrame" src="${escapeAttr(url)}" title="${escapeAttr(resource.title || 'Website resource')}" referrerpolicy="strict-origin-when-cross-origin" loading="eager" allow="clipboard-read; clipboard-write; fullscreen" ></iframe></div><div class="video-metrics"><div><small>ACTIVE IN NEO WORLD</small><strong id="siteActiveTime">${Math.floor(activeSeconds / 60)}m ${activeSeconds % 60}s</strong></div><div><small>SCROLL POSITION</small><strong id="siteScroll">${scrollPercent ? `${scrollPercent}% (same-origin only)` : 'Unavailable'}</strong></div><div><small>KNOWN PAGES</small><strong id="sitePages">${visitedPages.size}</strong></div></div><p class="reader-hint">For privacy and browser security, Neo World cannot inspect scroll position or navigation inside most third-party websites. Active time is only an estimate of time spent in this app, not proof that the page was read.</p><button class="button secondary" data-website="explored">Mark as explored</button></div>`;
  const frame = container.querySelector('#websiteFrame');
  frame.addEventListener('load', () => {
    loaded = true; const frameStatus = container.querySelector('#websiteFrameStatus'); if (frameStatus) frameStatus.textContent = 'The frame sent a load event. This does not prove the site content is visible; use Open website in new tab if it looks blank.';
    if (!firstOpenCounted) { firstOpenCounted = true; openedAt = new Date().toISOString(); onActivity('Opened a website'); }
    try { const target = frame.contentWindow.location.href; if (target && !visitedPages.has(target)) visitedPages.add(target); } catch { if (url && !visitedPages.has(url)) visitedPages.add(url); }
    try { const doc = frame.contentDocument; const el = doc.scrollingElement || doc.documentElement; lastScrollY = el.scrollTop; const max = el.scrollHeight - doc.defaultView.innerHeight; scrollPercent = max > 0 ? Math.round(lastScrollY / max * 100) : 0; } catch { /* Cross-origin content is intentionally inaccessible. */ }
    persist();
  });
  const click = ev => { if (ev.target.closest('[data-website="explored"]')) { const p = latest(); p.status = 'explored'; p.exploredAt = new Date().toISOString(); onProgress(p); onActivity('Marked a website explored'); ev.target.closest('button').textContent = '✓ Marked as explored'; } };
  container.addEventListener('click', click);
  function latest() { return { ...progress, activeSeconds: Math.floor(activeSeconds), scrollY: lastScrollY, scrollPercent, visitedPages: [...visitedPages].slice(0,100), openedAt, lastViewedAt: new Date().toISOString() }; }
  function persist() {
    if (destroyed) return;
    container.querySelector('#siteActiveTime').textContent = `${Math.floor(activeSeconds / 60)}m ${activeSeconds % 60}s`;
    container.querySelector('#siteScroll').textContent = scrollPercent ? `${scrollPercent}% (same-origin only)` : 'Unavailable';
    container.querySelector('#sitePages').textContent = visitedPages.size;
    onProgress(latest());
  }
  timer = setInterval(() => { if (destroyed || document.hidden) return; activeSeconds += 1; try { const doc = frame.contentDocument; const el = doc.scrollingElement || doc.documentElement; lastScrollY = el.scrollTop; const max = el.scrollHeight - doc.defaultView.innerHeight; scrollPercent = max > 0 ? Math.round(lastScrollY / max * 100) : 0; } catch {} persist(); }, 1000);
  return () => { destroyed = true; clearInterval(timer); container.removeEventListener('click', click); };
}
function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(value) { return escapeText(value); }
