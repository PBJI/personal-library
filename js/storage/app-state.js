import { seedBooks, seedTopics, seedConnections, seedNotes, seedPaths, initialState } from '../data.js';
import { dbGet, saveAppState } from './database.js';

const LEGACY_KEY = 'neo-world-library-v1';
const FALLBACK_KEY = 'neo-world-library-v2-fallback';
const SEEDED_RESOURCE_IDS = new Set([...seedBooks.map(book => book.id), 'demo-wai-site', 'demo-youtube', 'demo-image']);
const SEEDED_TOPIC_IDS = new Set(seedTopics.map(topic => topic.id));
const SEEDED_NOTE_IDS = new Set(seedNotes.map(note => note.id));
const SEEDED_PATH_IDS = new Set(seedPaths.map(path => path.id));
const SEEDED_COLLECTION_IDS = new Set((initialState().collections || []).map(collection => collection.id));
const SEEDED_CONNECTION_KEYS = new Set(seedConnections.map(connection => connectionKey(connection.source, connection.target)));
const SEEDED_ACTIVITY_IDS = new Set(['act-1', 'act-2', 'act-3']);

function connectionKey(a, b) { return [String(a || ''), String(b || '')].sort().join('::'); }

function freshState() {
  return {
    schemaVersion: 2,
    resources: [], libraryIds: [], progress: {}, collections: [], notes: [], topics: [], connections: [], paths: [],
    flashcards: [], quizzes: [], schedules: [], aiTaskHistory: [], recentResources: [],
    garden: { activityCount: 0, unlocked: [], activityLog: [] },
    preferences: { cacheTtlHours: 24, lastRoute: 'home' }
  };
}

/** Remove known prototype seeds while retaining user-created records and file-store records. */
export function cleanDemoContent(input = {}) {
  const next = { ...freshState(), ...(input || {}), schemaVersion: 2 };
  const originalResources = Array.isArray(input.resources) ? input.resources : [];
  const resources = originalResources.filter(resource => resource && !SEEDED_RESOURCE_IDS.has(resource.id) && resource.demo !== true);
  const keptResourceIds = new Set(resources.map(resource => resource.id));
  const removedResourceIds = new Set(originalResources.filter(resource => !keptResourceIds.has(resource?.id)).map(resource => resource?.id).filter(Boolean));

  next.resources = resources;
  next.libraryIds = [...new Set((input.libraryIds || []).filter(id => keptResourceIds.has(id)))];
  next.progress = Object.fromEntries(Object.entries(input.progress || {}).filter(([id]) => keptResourceIds.has(id)));
  next.recentResources = (input.recentResources || input.recentlyViewed || []).filter(id => keptResourceIds.has(id));

  next.topics = (input.topics || []).filter(topic => topic && !SEEDED_TOPIC_IDS.has(topic.id));
  const topicIds = new Set(next.topics.map(topic => topic.id));
  next.notes = (input.notes || []).filter(note => note && !SEEDED_NOTE_IDS.has(note.id)).map(note => removedResourceIds.has(note.resourceId || note.bookId) ? { ...note, resourceId: '', bookId: '' } : note);
  next.paths = (input.paths || []).filter(path => path && !SEEDED_PATH_IDS.has(path.id));
  next.collections = (input.collections || []).filter(collection => collection && !SEEDED_COLLECTION_IDS.has(collection.id)).map(collection => {
    const ids = (collection.resourceIds || collection.bookIds || []).filter(id => keptResourceIds.has(id));
    return { ...collection, resourceIds: [...new Set(ids)], bookIds: [...new Set(ids)] };
  });
  next.connections = (input.connections || []).filter(connection => connection && topicIds.has(connection.source) && topicIds.has(connection.target) && connection.source !== connection.target && !SEEDED_CONNECTION_KEYS.has(connectionKey(connection.source, connection.target)));

  const originalGarden = input.garden || {};
  const log = (originalGarden.activityLog || []).filter(activity => activity && !SEEDED_ACTIVITY_IDS.has(activity.id));
  const removedSeedActivityCount = (originalGarden.activityLog || []).filter(activity => SEEDED_ACTIVITY_IDS.has(activity?.id)).length;
  next.garden = {
    ...originalGarden,
    activityLog: log,
    activityCount: Math.max(log.length, Math.max(0, Number(originalGarden.activityCount || 0) - (removedSeedActivityCount ? 9 : 0))),
    unlocked: []
  };
  // A demo-only garden starts clean. User activity remains untouched otherwise.
  if (next.garden.activityCount >= 5) next.garden.unlocked.push('sage');
  if (next.garden.activityCount >= 10) next.garden.unlocked.push('grove');
  if (next.garden.activityCount >= 18) next.garden.unlocked.push('forest');
  next.flashcards = Array.isArray(input.flashcards) ? input.flashcards : [];
  next.quizzes = Array.isArray(input.quizzes) ? input.quizzes : [];
  next.schedules = Array.isArray(input.schedules) ? input.schedules : [];
  next.aiTaskHistory = Array.isArray(input.aiTaskHistory) ? input.aiTaskHistory : [];
  next.preferences = { cacheTtlHours: 24, lastRoute: 'home', ...(input.preferences || {}) };
  delete next.recentlyViewed;
  return next;
}

function migrateLegacy() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return freshState();
    const old = JSON.parse(raw);
    if (!old || typeof old !== 'object') return freshState();
    const legacyResources = Array.isArray(old.resources) ? old.resources : [];
    return cleanDemoContent({
      ...old,
      resources: legacyResources,
      libraryIds: old.libraryIds || [],
      recentResources: old.recentResources || old.recentlyViewed || [],
      collections: old.collections || [], notes: old.notes || [], topics: old.topics || [], connections: old.connections || [], paths: old.paths || [],
      flashcards: old.flashcards || [], quizzes: old.quizzes || [], schedules: old.schedules || [], aiTaskHistory: old.aiTaskHistory || [],
      garden: old.garden || { activityCount: 0, unlocked: [], activityLog: [] }
    });
  } catch (error) {
    console.warn('Could not migrate prior Neo World state; opening a clean library.', error);
    return freshState();
  }
}

export async function loadAppState() {
  try {
    const saved = await dbGet('appState', 'current');
    if (saved && saved.schemaVersion === 2 && Array.isArray(saved.resources)) {
      const cleaned = cleanDemoContent(saved);
      if (JSON.stringify(cleaned) !== JSON.stringify(saved)) await saveState(cleaned);
      return cleaned;
    }
  } catch (error) {
    console.warn('IndexedDB state not available; checking fallback storage.', error);
  }
  try {
    const fallback = JSON.parse(localStorage.getItem(FALLBACK_KEY) || 'null');
    if (fallback && fallback.schemaVersion === 2) {
      const cleaned = cleanDemoContent(fallback);
      if (JSON.stringify(cleaned) !== JSON.stringify(fallback)) await saveState(cleaned);
      return cleaned;
    }
  } catch {}
  const state = migrateLegacy();
  await saveState(state);
  return state;
}

export async function saveState(state) {
  state.schemaVersion = 2;
  const result = await saveAppState(state);
  if (!result.ok) throw result.error || new Error('Could not save app state.');
  return result;
}

export async function resetAppState() {
  const state = freshState();
  await saveState(state);
  return state;
}

export function createFreshStateForBackup() { return freshState(); }
