import { dbDelete, dbGet, dbPut } from './database.js';

export async function storeFile(blob, metadata = {}) {
  const id = `file-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  await dbPut('files', { id, blob, name: metadata.name || 'resource-file', type: metadata.type || blob.type || 'application/octet-stream', size: blob.size, storedAt: new Date().toISOString() });
  return id;
}

export async function readStoredFile(fileId) {
  if (!fileId) return null;
  return (await dbGet('files', fileId)) || null;
}

export async function deleteStoredFile(fileId) {
  if (fileId) await dbDelete('files', fileId);
}

export async function storeFileHandle(handle, metadata = {}) {
  const id = `handle-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  await dbPut('handles', { id, handle, name: metadata.name || handle.name || 'local-file', storedAt: new Date().toISOString() });
  return id;
}

export async function readFileHandle(handleId) {
  if (!handleId) return null;
  return (await dbGet('handles', handleId)) || null;
}


export async function deleteStoredFileHandle(handleId) {
  if (handleId) await dbDelete('handles', handleId);
}

export async function getBlobForResource(resource) {
  if (resource?.source?.fileId) {
    const saved = await readStoredFile(resource.source.fileId);
    return saved?.blob || null;
  }
  if (resource?.source?.handleId) {
    const record = await readFileHandle(resource.source.handleId);
    if (!record?.handle) return null;
    let permission = await record.handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted') permission = await record.handle.requestPermission({ mode: 'read' });
    if (permission !== 'granted') throw new Error('Permission to the original file was not granted. Re-select it or import a copy.');
    return record.handle.getFile();
  }
  return null;
}
