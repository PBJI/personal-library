import { initialState, seedBooks } from '../data.js';
import { dbGet, saveAppState } from './database.js';

const LEGACY_KEY = 'neo-world-library-v1';
const FALLBACK_KEY = 'neo-world-library-v2-fallback';

function bookResource(book) {
  return {
    id: book.id, type: 'book', title: book.title, author: book.author, category: book.category || 'Uncategorized',
    description: book.description || '', tags: [book.category].filter(Boolean), topicIds: ({ Psychology: ['psychology','biases'], Philosophy: ['decisions'], Technology: ['programming'], Design: ['design'], Business: ['economics','investing'], Science: ['decisions'], Literature: ['behavior'] }[book.category] || []),
    source: { kind: 'catalog' }, sampleText: book.sample || '', publicDomain: !!book.publicDomain,
    metadata: { year: book.year, pageCount: book.pages }, createdAt: new Date().toISOString(), addedAt: new Date().toISOString()
  };
}

function demoResources() {
  return [
    { id: 'demo-wai-site', type: 'website', title: 'Web Accessibility Fundamentals', author: 'W3C Web Accessibility Initiative', category: 'Technology', description: 'A practical starting point for accessible web design.', source: { kind: 'url', url: 'https://www.w3.org/WAI/fundamentals/' }, tags: ['accessibility','frontend'], topicIds: ['programming','design'], demo: true, createdAt: '2026-10-25T00:00:00.000Z', addedAt: '2026-10-25T00:00:00.000Z' },
    { id: 'demo-youtube', type: 'youtube', title: 'YouTube Player API sample', author: 'YouTube Developers', category: 'Technology', description: 'A demonstration resource for playback and resume tracking.', source: { kind: 'url', url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE' }, tags: ['video','api'], topicIds: ['programming'], demo: true, createdAt: '2026-10-25T00:00:00.000Z', addedAt: '2026-10-25T00:00:00.000Z' },
    { id: 'demo-image', type: 'image', title: 'Bookshelf inspiration', author: 'Unsplash', category: 'Design', description: 'A sample image resource to demonstrate image viewing progress.', source: { kind: 'url', url: 'https://images.unsplash.com/photo-1495446815901-a7297e633e8d?auto=format&fit=crop&w=1200&q=85' }, tags: ['image','library'], topicIds: ['design'], demo: true, createdAt: '2026-10-25T00:00:00.000Z', addedAt: '2026-10-25T00:00:00.000Z' }
  ];
}

function freshState() {
  const state = initialState();
  const books = seedBooks.map(bookResource);
  const resources = [...books, ...demoResources()];
  return {
    ...state,
    schemaVersion: 2,
    resources,
    libraryIds: [...(state.libraryIds || [])],
    progress: { ...(state.progress || {}) },
    collections: (state.collections || []).map(c => ({ ...c, resourceIds: [...(c.resourceIds || c.bookIds || [])] })),
    flashcards: [], quizzes: [], schedules: [], aiTaskHistory: [], recentResources: [...(state.recentlyViewed || [])],
    preferences: { cacheTtlHours: 24, lastRoute: 'home', ...state.preferences }
  };
}

function migrateLegacy() {
  const base = freshState();
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return base;
    const old = JSON.parse(raw);
    if (!old || typeof old !== 'object') return base;
    const merged = { ...base, ...old, schemaVersion: 2, resources: base.resources };
    merged.collections = (old.collections || base.collections).map(c => ({ ...c, resourceIds: [...(c.resourceIds || c.bookIds || [])] }));
    merged.recentResources = old.recentResources || old.recentlyViewed || [];
    merged.flashcards ||= [];
    merged.quizzes ||= [];
    merged.schedules ||= [];
    merged.aiTaskHistory ||= [];
    merged.preferences = { cacheTtlHours: 24, ...(old.preferences || {}) };
    return merged;
  } catch (error) {
    console.warn('Could not migrate prior Neo World state; opening a clean demo.', error);
    return base;
  }
}

export async function loadAppState() {
  try {
    const saved = await dbGet('appState', 'current');
    if (saved && saved.schemaVersion === 2 && Array.isArray(saved.resources)) return saved;
  } catch (error) {
    console.warn('IndexedDB state not available; checking fallback storage.', error);
  }
  try {
    const fallback = JSON.parse(localStorage.getItem(FALLBACK_KEY) || 'null');
    if (fallback && fallback.schemaVersion === 2) return fallback;
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
