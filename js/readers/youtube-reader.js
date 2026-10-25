import { youtubeVideoId } from '../resources/detect-type.js';

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  return new Promise((resolve, reject) => {
    let timer;
    const oldCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { try { oldCallback?.(); } catch {} clearTimeout(timer); resolve(window.YT); };
    if (!document.querySelector('script[data-youtube-api]')) {
      const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.dataset.youtubeApi = '1'; script.onerror = () => { clearTimeout(timer); reject(new Error('Could not load YouTube IFrame Player API.')); }; document.head.append(script);
    }
    timer = setTimeout(() => reject(new Error('YouTube Player API did not become ready. Check your connection or open the video on YouTube.')), 15000);
  });
}

export async function mountYouTubeReader(container, { resource, progress = {}, onProgress = () => {}, onActivity = () => {} }) {
  let player = null, timer = null, destroyed = false, playing = false, countedSeconds = Number(progress.watchedSeconds || 0), activeSeconds = Number(progress.activeSeconds || 0), lastPosition = Number(progress.lastPosition || 0), duration = Number(progress.duration || 0), lastObservedPosition = lastPosition, currentState = 'loading';
  const videoId = youtubeVideoId(resource.source?.url || '');
  container.innerHTML = `<div class="video-reader"><div class="youtube-stage"><div id="youtubePlayer"></div><div id="youtubeStatus" class="embed-status">Connecting to YouTube…</div></div><div class="video-metrics"><div><small>WATCH TIME</small><strong id="ytWatched">${formatTime(countedSeconds)}</strong></div><div><small>RESUME POSITION</small><strong id="ytPosition">${formatTime(lastPosition)}</strong></div><div><small>DURATION</small><strong id="ytDuration">${duration ? formatTime(duration) : 'Not available'}</strong></div></div><p class="reader-hint">Watch time is counted from observed playback, not from time the tab is open or from skipped sections. Some videos restrict embedding.</p><a class="button secondary" href="${escapeAttr(resource.source?.url || '')}" target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a></div>`;
  if (!videoId) { container.querySelector('#youtubeStatus').textContent = 'Could not extract a video ID from this URL.'; return () => {}; }
  try {
    const YT = await loadYouTubeApi();
    if (destroyed) return () => {};
    const playerTarget = container.querySelector('#youtubePlayer');
    player = new YT.Player(playerTarget, {
      videoId, playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: event => {
          if (destroyed) return;
          container.querySelector('#youtubeStatus').textContent = 'Player ready';
          try { if (lastPosition > 0) event.target.seekTo(lastPosition, true); } catch {}
          try { duration = event.target.getDuration() || duration; } catch {}
          persist();
        },
        onStateChange: event => {
          if (destroyed) return;
          playing = event.data === YT.PlayerState.PLAYING;
          currentState = event.data === YT.PlayerState.ENDED ? 'ended' : event.data === YT.PlayerState.PAUSED ? 'paused' : playing ? 'playing' : currentState;
          container.querySelector('#youtubeStatus').textContent = playing ? 'Playing · tracking observed playback' : currentState === 'ended' ? 'Video ended' : 'Paused';
          if (playing && !progress.everPlayed) { progress.everPlayed = true; onActivity('Started a video'); }
          persist();
        },
        onError: event => { const status = container.querySelector('#youtubeStatus'); if (status) status.textContent = `YouTube embed error (${event.data}). Open the video directly instead.`; }
      }
    });
  } catch (error) {
    container.querySelector('#youtubeStatus').textContent = error.message;
  }
  function persist() {
    if (!player || destroyed) return;
    try { lastPosition = player.getCurrentTime() || lastPosition; duration = player.getDuration() || duration; } catch {}
    const p = { ...progress, watchedSeconds: Math.floor(countedSeconds), activeSeconds: Math.floor(activeSeconds), lastPosition, duration: duration || null, percentage: duration > 0 ? Math.min(100, Math.round(lastPosition / duration * 100)) : null, lastViewedAt: new Date().toISOString(), playbackState: currentState };
    container.querySelector('#ytWatched').textContent = formatTime(countedSeconds);
    container.querySelector('#ytPosition').textContent = formatTime(lastPosition);
    container.querySelector('#ytDuration').textContent = duration ? formatTime(duration) : 'Not available';
    onProgress(p);
  }
  timer = setInterval(() => {
    if (destroyed || !player || !playing || document.hidden) return;
    try {
      const current = player.getCurrentTime() || 0; const delta = current - lastObservedPosition;
      // Count only plausible forward playback. A seek is not viewing time.
      if (delta > 0 && delta <= 2.5) { countedSeconds += delta; activeSeconds += 1; }
      lastObservedPosition = current; lastPosition = current;
      persist();
    } catch {}
  }, 1000);
  const visibility = () => { if (document.hidden) { try { player?.pauseVideo(); } catch {} } else { try { lastObservedPosition = player?.getCurrentTime?.() || lastPosition; } catch {} } };
  document.addEventListener('visibilitychange', visibility);
  return () => { destroyed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visibility); try { player?.destroy(); } catch {} };
}
function formatTime(seconds) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; }
function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(value) { return escapeText(value); }
