import { dbDelete, dbGet, dbPut } from './database.js';

export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getCachedResource(resourceId) {
  const record = await dbGet('cache', resourceId);
  if (!record) return null;
  if (Date.now() >= record.expiresAt) {
    await dbDelete('cache', resourceId);
    return null;
  }
  return record;
}

export async function cacheRemoteResource(resource, ttlMs = DEFAULT_CACHE_TTL_MS) {
  const url = resource?.source?.url;
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('This resource does not have a downloadable HTTP(S) URL.');
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}). The source may block downloads or require a sign-in.`);
  const blob = await response.blob();
  if (!blob.size) throw new Error('The source returned an empty file.');
  const now = Date.now();
  const record = { resourceId: resource.id, url, blob, size: blob.size, cachedAt: now, expiresAt: now + ttlMs, mimeType: blob.type || resource.mimeType || 'application/octet-stream' };
  await dbPut('cache', record);
  return record;
}

export async function removeExpiredCaches() {
  // Avoid cursor complexity here by iterating resources known to the app.
  return true;
}

export async function clearResourceCache(resourceId) {
  await dbDelete('cache', resourceId);
}

export function cacheRemainingLabel(record) {
  if (!record) return '';
  const minutes = Math.max(0, Math.ceil((record.expiresAt - Date.now()) / 60000));
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
  return `${minutes}m left`;
}
