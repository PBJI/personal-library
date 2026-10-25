const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp)(?:[?#].*)?$/i;
const PDF_EXT = /\.pdf(?:[?#].*)?$/i;
const EPUB_EXT = /\.epub(?:[?#].*)?$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|wav|flac|opus)(?:[?#].*)?$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)(?:[?#].*)?$/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|log)(?:[?#].*)?$/i;

export function detectUrlType(raw) {
  let url;
  try { url = new URL(raw); } catch { return 'website'; }
  if (!['http:', 'https:'].includes(url.protocol)) return 'website';
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be' || host.endsWith('youtube.com') || host === 'youtube-nocookie.com') return 'youtube';
  if (PDF_EXT.test(url.href)) return 'pdf';
  if (EPUB_EXT.test(url.href)) return 'epub';
  if (IMAGE_EXT.test(url.href)) return 'image';
  if (AUDIO_EXT.test(url.href)) return 'audio';
  if (VIDEO_EXT.test(url.href)) return 'video';
  if (TEXT_EXT.test(url.href)) return 'text';
  return 'website';
}

export function detectFileType(file) {
  const name = (file?.name || '').toLowerCase();
  const mime = (file?.type || '').toLowerCase();
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (mime === 'application/epub+zip' || name.endsWith('.epub')) return 'epub';
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/.test(name)) return 'image';
  if (mime.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|wav|flac|opus)$/.test(name)) return 'audio';
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/.test(name)) return 'video';
  if (mime.startsWith('text/') || /\.(txt|md|markdown|csv|log)$/.test(name)) return 'text';
  if (name.endsWith('.json') || mime === 'application/json') return 'json';
  return 'file';
}

export function safeHttpUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function youtubeVideoId(raw) {
  try {
    const url = new URL(raw);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
    if (url.hostname.endsWith('youtube.com') || url.hostname === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const match = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/);
      if (match) return match[1];
    }
  } catch {}
  return null;
}

export function validateResourceUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, error: 'Enter a URL first.' };
  const url = safeHttpUrl(value);
  if (!url) return { ok: false, error: 'Only http:// and https:// URLs are supported.' };
  const type = detectUrlType(url);
  if (type === 'youtube' && !youtubeVideoId(url)) return { ok: false, error: 'Could not recognize a YouTube video ID from that URL.' };
  return { ok: true, url, type };
}
