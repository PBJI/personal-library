export function mountMediaReader(container, { resource, blob, progress = {}, onProgress = () => {}, onActivity = () => {} }) {
  let objectUrl = blob ? URL.createObjectURL(blob) : null;
  const src = objectUrl || resource.source?.url || '';
  const isAudio = resource.type === 'audio';
  const tag = isAudio ? 'audio' : 'video';
  container.innerHTML = `<div class="media-reader"><div class="media-stage ${isAudio ? 'audio-stage' : ''}">${isAudio ? '<div class="audio-art">♫</div>' : ''}<${tag} id="mediaPlayer" controls preload="metadata" ${isAudio ? '' : 'playsinline'} src="${escapeAttr(src)}"></${tag}></div><div class="video-metrics"><div><small>LISTENED / WATCHED</small><strong id="mediaWatched">${formatTime(progress.watchedSeconds || 0)}</strong></div><div><small>RESUME POSITION</small><strong id="mediaPosition">${formatTime(progress.lastPosition || 0)}</strong></div><div><small>DURATION</small><strong id="mediaDuration">${progress.duration ? formatTime(progress.duration) : 'Not available'}</strong></div></div><p class="reader-hint">Media time is counted from observed playback. Seeking does not count as listening or watching the skipped segment.</p></div>`;
  const media = container.querySelector('#mediaPlayer'); let playing = false, lastTime = Number(progress.lastPosition || 0), watched = Number(progress.watchedSeconds || 0), active = Number(progress.activeSeconds || 0), duration = Number(progress.duration || 0), lastObservation = lastTime, interval = null, destroyed = false, wasSeeking = false;
  media.addEventListener('loadedmetadata', () => { duration = Number.isFinite(media.duration) ? media.duration : duration; media.currentTime = Math.min(lastTime, duration || lastTime); update(); });
  media.addEventListener('play', () => { playing = true; onActivity('Started media playback'); });
  media.addEventListener('pause', () => { playing = false; update(); });
  media.addEventListener('seeking', () => { wasSeeking = true; });
  media.addEventListener('seeked', () => { lastObservation = media.currentTime || 0; lastTime = lastObservation; wasSeeking = false; update(); });
  media.addEventListener('timeupdate', update);
  media.addEventListener('ended', () => { playing = false; update(); });
  interval = setInterval(() => {
    if (destroyed || document.hidden || !playing || media.paused) { lastObservation = media.currentTime || lastObservation; return; }
    const current = media.currentTime || 0, delta = current - lastObservation;
    if (!wasSeeking && delta > 0 && delta <= 2.5) { watched += delta; active += 1; }
    lastObservation = current; lastTime = current; update();
  }, 1000);
  function update() {
    if (destroyed) return;
    lastTime = Number.isFinite(media.currentTime) ? media.currentTime : lastTime;
    duration = Number.isFinite(media.duration) ? media.duration : duration;
    container.querySelector('#mediaWatched').textContent = formatTime(watched);
    container.querySelector('#mediaPosition').textContent = formatTime(lastTime);
    container.querySelector('#mediaDuration').textContent = duration ? formatTime(duration) : 'Not available';
    onProgress({ ...progress, watchedSeconds: Math.floor(watched), activeSeconds: Math.floor(active), lastPosition: lastTime, duration: duration || null, percentage: duration > 0 ? Math.min(100, Math.round(lastTime / duration * 100)) : null, lastViewedAt: new Date().toISOString() });
  }
  media.addEventListener('error', () => { const note = document.createElement('p'); note.className = 'reader-state error-state'; note.textContent = 'This media could not be played in the browser. The source may block access or use an unsupported format.'; container.append(note); });
  if (!src) { const note = document.createElement('p'); note.className='reader-state error-state'; note.textContent='No playable media source is attached.'; container.append(note); }
  return () => { destroyed = true; clearInterval(interval); media.pause(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
}
function formatTime(seconds) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; }
function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(value) { return escapeText(value); }
