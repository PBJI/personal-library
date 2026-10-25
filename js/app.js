import { loadAppState, saveState, resetAppState } from './storage/app-state.js';
import { dbGet, dbPut, dbDelete, dbGetAll } from './storage/database.js';
import { storeFile, getBlobForResource, storeFileHandle, deleteStoredFile, deleteStoredFileHandle } from './storage/file-store.js';
import { cacheRemoteResource, getCachedResource, clearResourceCache, cacheRemainingLabel } from './storage/cache-manager.js';
import { detectFileType, detectUrlType, validateResourceUrl, safeHttpUrl } from './resources/detect-type.js';
import { validateLearningPath, normalizeLearningPath, exportLearningPath, PATH_FORMAT } from './paths/path-format.js';
import { AI_TASKS, getTask } from './ai/task-registry.js';
import { buildPrompt } from './ai/prompt-builder.js';
import { parseAIResponse, correctionPrompt } from './ai/response-parser.js';

let state;
let route = 'home';
let globalQuery = '';
let libraryFilter = 'All';
let selectedPathId = null;
let selectedTopicId = 'psychology';
let selectedResourceId = null;
let activeReaderCleanup = null;
let readerToken = 0;
let pendingAIResult = null;
let pendingAIExpectedTask = '';
let pendingBackupImport = null;
let debouncedSaveTimer = null;
let storageCaption = 'Browser storage';
const appContent = () => document.querySelector('#appContent');
const modalBackdrop = () => document.querySelector('#modalBackdrop');
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const makeId = prefix => `${prefix}-${crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`}`;
const findResource = id => state.resources.find(resource => resource.id === id);
const getProgress = id => state.progress?.[id] || {};
const categories = () => ['All', ...new Set(state.resources.map(resource => resource.category).filter(Boolean))];
const typeLabels = { book:'Book', pdf:'PDF', epub:'EPUB', image:'Image', youtube:'YouTube', website:'Website', audio:'Audio', video:'Video', text:'Text', file:'File' };
const typeIcons = { book:'▤', pdf:'▧', epub:'▤', image:'▧', youtube:'▶', website:'↗', audio:'♫', video:'▷', text:'≋', file:'⌑' };

function toast(message, type = 'success') {
  const region = $('#toastRegion');
  const node = document.createElement('div'); node.className = `toast ${type === 'error' ? 'toast-error' : ''}`; node.textContent = message;
  region.append(node); setTimeout(() => node.remove(), 4000);
}
function setModal(title, body, eyebrow = 'NEO WORLD', wide = false) {
  $('#modalTitle').textContent = title; $('#modalEyebrow').textContent = eyebrow;
  $('#modalBody').innerHTML = body; $('#modal').classList.toggle('modal-wide', wide); modalBackdrop().hidden = false;
  document.body.classList.add('modal-open');
  const focus = $('#modalBody input, #modalBody textarea, #modalBody button, #modalBody select'); focus?.focus({ preventScroll: true });
}
function closeModal() { modalBackdrop().hidden = true; document.body.classList.remove('modal-open'); pendingAIResult = null; pendingAIExpectedTask = ''; }
function setActiveNavigation() {
  $$('[data-route]').forEach(el => el.classList.toggle('active', el.dataset.route === route));
  $$('.bottom-nav [data-route]').forEach(el => el.classList.toggle('mobile-active', el.dataset.route === route));
}
function titleForRoute() {
  if (route === 'reader') return findResource(selectedResourceId)?.title || 'Reader';
  if (route === 'paths' && selectedPathId) return findPath(selectedPathId)?.title || 'Learning Paths';
  return ({ home:'Home', discover:'Discover', library:'My Library', notes:'My Notes', graph:'Knowledge Graph', paths:'Learning Paths', garden:'Knowledge Garden', 'ai-tasks':'AI Task Bridge' })[route] || 'Neo World';
}
function updateSidebar() {
  $('#libraryCount').textContent = state.libraryIds.length;
  $('#notesCount').textContent = state.notes.length;
  $('#pathsCount').textContent = state.paths.length;
  const count = Number(state.garden?.activityCount || 0);
  $('#gardenCaption').textContent = count >= 18 ? 'Your forest is taking shape.' : count >= 10 ? 'Look at those roots growing.' : 'Small steps make a forest.';
  $('#storageCaption').textContent = storageCaption;
}
function persistSoon() {
  clearTimeout(debouncedSaveTimer);
  debouncedSaveTimer = setTimeout(async () => {
    try { const result = await saveState(state); storageCaption = result.mode === 'indexeddb' ? 'Saved in this browser' : 'Browser fallback storage'; updateSidebar(); }
    catch (error) { toast(`Could not save: ${error.message}`, 'error'); }
  }, 650);
}
async function persistNow() {
  clearTimeout(debouncedSaveTimer);
  try { const result = await saveState(state); storageCaption = result.mode === 'indexeddb' ? 'Saved in this browser' : 'Browser fallback storage'; updateSidebar(); return true; }
  catch (error) { toast(`Could not save: ${error.message}`, 'error'); return false; }
}
function addActivity(type, label) {
  if (!state.garden) state.garden = { activityCount: 0, unlocked: [], activityLog: [] };
  state.garden.activityCount = (state.garden.activityCount || 0) + 1;
  state.garden.activityLog ||= [];
  state.garden.activityLog.unshift({ id: makeId('activity'), type, label, date: new Date().toISOString() });
  state.garden.activityLog = state.garden.activityLog.slice(0, 40);
  state.garden.unlocked ||= [];
  for (const [level, threshold] of [['sage',5],['grove',10],['forest',18]]) if (state.garden.activityCount >= threshold && !state.garden.unlocked.includes(level)) state.garden.unlocked.push(level);
  persistSoon(); updateSidebar();
}
function humanDate(date) { if (!date) return 'Not opened yet'; const d = new Date(date); if (Number.isNaN(d.getTime())) return 'Recently'; return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }); }
function formatTime(seconds) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); return n >= 3600 ? `${Math.floor(n/3600)}h ${Math.floor((n%3600)/60)}m` : `${Math.floor(n/60)}m ${n%60}s`; }
function progressSummary(resource) {
  const p = getProgress(resource.id);
  switch (resource.type) {
    case 'pdf': return p.pageCount ? `${(p.visitedPages || []).length}/${p.pageCount} pages visited` : p.currentPage ? `Last page ${p.currentPage}` : 'Not started';
    case 'epub': return p.percentage != null ? `${p.percentage}% · ${p.currentSection || 'Reading'}` : p.currentSection ? `Section ${p.currentSection}` : 'Not started';
    case 'image': return p.viewedAt ? `Viewed ${humanDate(p.viewedAt)}` : 'Not viewed';
    case 'youtube': return `Watched ${formatTime(p.watchedSeconds || 0)}${p.duration ? ` · ${Math.round((p.lastPosition || 0) / p.duration * 100)}% position` : ''}`;
    case 'audio': case 'video': return `Played ${formatTime(p.watchedSeconds || 0)}${p.duration ? ` · ${Math.round((p.lastPosition || 0) / p.duration * 100)}% position` : ''}`;
    case 'website': return p.status === 'explored' ? 'Marked explored' : p.activeSeconds ? `${formatTime(p.activeSeconds)} active in app` : 'Not explored';
    case 'text': return p.status === 'explored' ? 'Explored' : p.maxScrollPercent ? `${p.maxScrollPercent}% furthest scroll` : 'Not started';
    case 'book': return p.status === 'completed' || p.progress >= 100 ? 'Completed' : p.progress ? `${p.progress}% sample reading` : 'Catalog entry';
    default: return p.status || 'Not started';
  }
}
function resourceTypeChip(resource) { return `<span class="type-chip type-${escapeHTML(resource.type)}">${escapeHTML(typeIcons[resource.type] || '⌑')} ${escapeHTML(typeLabels[resource.type] || resource.type)}</span>`; }
function resourceCard(resource, options = {}) {
  const inLibrary = state.libraryIds.includes(resource.id);
  const p = progressSummary(resource);
  const cover = resource.coverUrl || resource.thumbnail || (resource.type === 'image' ? resource.source?.url : '');
  const coverHTML = cover && resource.type === 'image' ? `<div class="resource-cover image-cover"><img src="${escapeHTML(cover)}" alt="" loading="lazy"></div>` : `<div class="resource-cover cover-${escapeHTML(resource.type)}"><span>${escapeHTML(typeIcons[resource.type] || '✦')}</span><small>${escapeHTML((resource.category || 'RESOURCE').toUpperCase())}</small></div>`;
  return `<article class="resource-card"><div class="resource-card-top">${coverHTML}<button class="bookmark-button ${inLibrary?'is-saved':''}" data-action="toggle-library" data-id="${escapeHTML(resource.id)}" title="${inLibrary?'Remove from':'Add to'} My Library" aria-label="${inLibrary?'Remove from':'Add to'} My Library">${inLibrary?'✓':'＋'}</button></div><div class="resource-card-body">${resourceTypeChip(resource)}<h3><button class="card-title-button" data-action="open-resource" data-id="${escapeHTML(resource.id)}">${escapeHTML(resource.title)}</button></h3><div class="resource-author">${escapeHTML(resource.author || resource.category || 'Personal resource')}</div><p>${escapeHTML(resource.description || 'A resource in your knowledge universe.')}</p><div class="resource-card-meta"><span>${escapeHTML(resource.category || 'Uncategorized')}</span><span title="Progress">${escapeHTML(p)}</span></div><div class="resource-card-actions"><button class="button primary small" data-action="open-resource" data-id="${escapeHTML(resource.id)}">${p === 'Not started' || p === 'Not viewed' ? 'Open resource' : 'Continue'} ↗</button><button class="icon-btn card-more" data-action="resource-menu" data-id="${escapeHTML(resource.id)}" aria-label="Resource options">···</button></div></div></article>`;
}
function pageHeading(eyebrow, title, desc, action = '') { return `<section class="page-heading"><div><div class="eyebrow">${escapeHTML(eyebrow)}</div><h1>${title}</h1><p>${desc}</p></div><div class="heading-actions">${action}</div></section>`; }
function emptyState(icon, title, detail, action = '') { return `<div class="empty-state"><div class="empty-icon">${icon}</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(detail)}</p>${action}</div>`; }

function renderHome() {
  const lib = state.resources.filter(r => state.libraryIds.includes(r.id));
  const continued = lib.find(r => { const p = getProgress(r.id); return p.status === 'reading' || p.currentPage || p.lastPosition || p.activeSeconds; }) || lib[0];
  const recent = (state.recentResources || []).map(findResource).filter(Boolean).slice(0,4);
  const topics = state.topics.slice(0,6);
  const doneSteps = state.paths.reduce((n,p) => n + (p.steps || []).filter(s=>s.done).length, 0);
  return `${pageHeading('YOUR KNOWLEDGE UNIVERSE','Your world of knowledge.','Books, links, videos, and ideas, all in one place.', '<button class="button primary" data-action="add-resource">＋ Add resource</button>')}
    <section class="hero-panel"><div class="hero-copy"><span class="hero-kicker">✦ A SPACE FOR CURIOSITY</span><h2>Explore what<br><em>moves your mind.</em></h2><p>Collect useful things, connect ideas, and keep track of what you actually explored.</p><div class="hero-actions"><button class="button white" data-route="discover">Discover resources ↗</button><button class="hero-link" data-action="add-resource">Import a file or link <span>＋</span></button></div></div><div class="hero-art" aria-hidden="true"><div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div><div class="art-book book-a">▤</div><div class="art-book book-b">✧</div><div class="art-book book-c">≋</div><span class="art-star star-a">✦</span><span class="art-star star-b">✧</span><span class="art-planet"></span></div></section>
    <section class="stat-grid"><div class="stat-card"><span class="stat-icon violet">▤</span><div><small>IN YOUR LIBRARY</small><strong>${lib.length}</strong><em>saved resources</em></div></div><div class="stat-card"><span class="stat-icon mint">✎</span><div><small>IDEAS CAPTURED</small><strong>${state.notes.length}</strong><em>notes and observations</em></div></div><div class="stat-card"><span class="stat-icon peach">↗</span><div><small>LEARNING PATHS</small><strong>${state.paths.length}</strong><em>${doneSteps} steps completed</em></div></div><div class="stat-card"><span class="stat-icon blue">❋</span><div><small>GARDEN ACTIVITY</small><strong>${state.garden.activityCount || 0}</strong><em>moments of exploration</em></div></div></section>
    <section class="section-block"><div class="section-title-row"><div><div class="eyebrow">PICK UP WHERE YOU LEFT OFF</div><h2>Continue your journey</h2></div><button class="text-button" data-route="library">View library ↗</button></div>${continued ? `<div class="continue-card"><div class="continue-mark cover-${escapeHTML(continued.type)}">${escapeHTML(typeIcons[continued.type] || '✦')}</div><div class="continue-main"><div class="card-kicker">${resourceTypeChip(continued)}</div><h3>${escapeHTML(continued.title)}</h3><p>${escapeHTML(continued.description || 'Pick up where you left off.')}</p><div class="continue-progress"><span>${escapeHTML(progressSummary(continued))}</span>${typeof getProgress(continued.id).progress === 'number' && continued.type === 'book' ? `<div class="progress-track"><span style="width:${Math.min(100,getProgress(continued.id).progress)}%"></span></div>` : ''}</div></div><button class="button primary" data-action="open-resource" data-id="${escapeHTML(continued.id)}">Continue ↗</button></div>` : emptyState('▤','Your library is waiting','Add a PDF, video, website, image, or book to begin.','<button class="button primary" data-action="add-resource">＋ Add resource</button>')}</section>
    <section class="section-block"><div class="section-title-row"><div><div class="eyebrow">A FEW PLACES TO START</div><h2>Explore your universe</h2></div><button class="text-button" data-route="discover">Browse everything ↗</button></div><div class="topic-pills">${topics.map(t=>`<button class="topic-pill" data-action="select-topic" data-id="${escapeHTML(t.id)}"><span>✦</span>${escapeHTML(t.name)}</button>`).join('')}<button class="topic-pill topic-add" data-action="new-topic">＋ New topic</button></div></section>
    <section class="section-block"><div class="section-title-row"><div><div class="eyebrow">RECENTLY EXPLORED</div><h2>Back to something useful</h2></div><button class="text-button" data-route="library">My library ↗</button></div><div class="resource-grid">${(recent.length ? recent : lib.slice(0,3)).map(r=>resourceCard(r)).join('') || emptyState('✦','Nothing explored yet','Open a resource and it will appear here.')}</div></section>
    <section class="home-bottom-grid"><div class="garden-teaser"><div><div class="eyebrow">YOUR KNOWLEDGE GARDEN</div><h2>Small acts.<br><em>Lasting roots.</em></h2><p>Reading, saving ideas, and connecting topics slowly grow your garden.</p><button class="button secondary" data-route="garden">Visit the garden ↗</button></div><div class="garden-teaser-art">🌱　🌿<br>　🌼　♧</div></div><div class="ai-teaser"><div class="ai-spark">✳</div><div class="eyebrow">NEED A HAND?</div><h2>Let an AI help shape the next step.</h2><p>Neo World prepares a contextual prompt. You choose an external AI, bring back the result, then review before applying it.</p><button class="button primary" data-route="ai-tasks">Open AI Task Bridge ↗</button></div></section>`;
}

function renderDiscover() {
  const normalized = globalQuery.toLowerCase();
  const resources = state.resources.filter(r => (!normalized || !state.libraryIds.includes(r.id)) && matchesResource(r, normalized));
  return `${pageHeading('FIND YOUR NEXT THREAD','Discover resources','Browse books and add your own videos, websites, images, PDFs, and more.','<button class="button primary" data-action="add-resource">＋ Add resource</button>')}
    <div class="discover-toolbar"><div class="catalog-search"><span>⌕</span><input id="catalogSearch" type="search" placeholder="Search title, topic, author, or type…" value="${escapeHTML(globalQuery)}"><kbd>/</kbd></div><select id="discoverType" aria-label="Filter by resource type"><option value="All">All types</option>${Object.entries(typeLabels).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select><select id="discoverCategory" aria-label="Filter by category"><option value="All">All categories</option>${categories().filter(c=>c!=='All').map(c=>`<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('')}</select></div>
    <div class="subtle-info"><span>✦</span><div><strong>Discover is a catalog, not a paywall.</strong><p>Without a search, this starts with resources outside your shelf. Search also includes resources already saved in My Library. Some demo books have illustrative excerpts rather than full text.</p></div></div>
    <div id="discoverGrid" class="resource-grid">${resources.length ? resources.map(r=>resourceCard(r)).join('') : emptyState('⌕','No matching resources','Try a different search, or import the material you have in mind.','<button class="button primary" data-action="add-resource">＋ Add resource</button>')}</div>`;
}
function matchesResource(r, query) { if (!query) return true; return [r.title,r.author,r.category,r.description,r.type,...(r.tags||[])].filter(Boolean).join(' ').toLowerCase().includes(query); }

function renderLibrary() {
  const activeCollectionId = libraryFilter.startsWith('collection:') ? libraryFilter.slice('collection:'.length) : '';
  const activeCollection = activeCollectionId ? state.collections.find(c=>c.id===activeCollectionId) : null;
  const collectionIds = activeCollection ? (activeCollection.resourceIds || activeCollection.bookIds || []) : null;
  const resources = state.resources.filter(r => state.libraryIds.includes(r.id) && matchesResource(r, globalQuery) && (activeCollection ? collectionIds.includes(r.id) : (libraryFilter === 'All' || r.type === libraryFilter)));
  const counts = ['All',...new Set(state.resources.filter(r=>state.libraryIds.includes(r.id)).map(r=>r.type))];
  const collectionCards = state.collections.length ? `<div class="collection-strip">${state.collections.map(c=>{const ids=c.resourceIds||c.bookIds||[];return `<button class="collection-tile ${activeCollectionId===c.id?'selected':''}" data-action="filter-library" data-filter="collection:${escapeHTML(c.id)}"><span class="collection-glyph">▥</span><span><strong>${escapeHTML(c.name)}</strong><small>${ids.length} saved resources</small></span><b>↗</b></button>`}).join('')}</div>` : '';
  return `${pageHeading('YOUR PERSONAL COLLECTION','My Library','Your saved resources, in one place. Files stay in this browser unless you choose an external source.','<button class="button secondary" data-action="new-collection">＋ New collection</button><button class="button primary" data-action="add-resource">＋ Add resource</button>')}
    ${collectionCards}
    <div class="library-toolbar"><div class="filter-tabs">${counts.map(f=>`<button class="filter-tab ${!activeCollection && libraryFilter===f?'active':''}" data-action="filter-library" data-filter="${escapeHTML(f)}">${f==='All'?'Everything':escapeHTML(typeLabels[f]||f)}${f==='All'?` <small>${state.libraryIds.length}</small>`:''}</button>`).join('')}${activeCollection?`<button class="filter-tab active" data-action="filter-library" data-filter="collection:${escapeHTML(activeCollection.id)}">${escapeHTML(activeCollection.name)}</button>`:''}</div><span class="muted-small">${resources.length} resource${resources.length===1?'':'s'}${activeCollection?` in ${escapeHTML(activeCollection.name)}`:''}</span></div>
    ${activeCollection?`<div class="collection-banner"><div><strong>${escapeHTML(activeCollection.name)}</strong><p>${escapeHTML(activeCollection.description||'A collection in your personal library.')}</p></div><button class="button secondary small" data-action="edit-collection" data-id="${escapeHTML(activeCollection.id)}">Edit collection</button><button class="button secondary small" data-action="clear-collection-filter">Show all</button></div>`:''}
    <div class="resource-grid">${resources.length ? resources.map(r=>resourceCard(r)).join('') : emptyState('▤',activeCollection?'This collection is empty':'Your shelf is quiet',activeCollection?'Add saved resources to this collection, or edit its contents.':'Save a resource from Discover or import a file or URL.','<button class="button primary" data-action="add-resource">＋ Add resource</button>')}</div>
    <section class="storage-card"><div class="storage-icon">▧</div><div><strong>Files are stored locally</strong><p>Imported file copies use IndexedDB. Cloud resources remain links unless you explicitly cache a downloadable file for 24 hours.</p></div><button class="button secondary small" data-action="storage-manager">Manage storage</button></section>`;
}

function renderNotes() {
  const notes = state.notes.filter(n => [n.title,n.content,n.topicIds?.join(' ')].filter(Boolean).join(' ').toLowerCase().includes(globalQuery.toLowerCase()));
  return `${pageHeading('YOUR NOTEBOOK','My Notes','Capture ideas from books, webpages, videos, and your own thinking.','<button class="button primary" data-action="new-note">＋ New note</button>')}
    <div class="notes-toolbar"><div class="catalog-search"><span>⌕</span><input id="notesSearch" type="search" placeholder="Search your notes…" value="${escapeHTML(globalQuery)}"></div><button class="button secondary" data-action="prepare-task" data-id="notes.consolidate">Consolidate notes with AI ↗</button><button class="button secondary" data-action="prepare-task" data-id="notes.flashcards">Make flashcards ↗</button></div>
    <div class="notes-grid">${notes.length ? notes.map(n=>`<article class="note-card"><div class="note-card-top"><span class="note-pin">✎</span><div class="note-actions"><button class="icon-btn" data-action="toggle-note-favorite" data-id="${escapeHTML(n.id)}" aria-label="Favorite note">${n.favorite?'★':'☆'}</button><button class="icon-btn" data-action="edit-note" data-id="${escapeHTML(n.id)}" aria-label="Edit note">↗</button></div></div><button class="note-title-button" data-action="edit-note" data-id="${escapeHTML(n.id)}">${escapeHTML(n.title)}</button><p>${escapeHTML(n.content)}</p><div class="note-tags">${(n.topicIds||[]).map(id=>state.topics.find(t=>t.id===id)?.name).filter(Boolean).map(t=>`<span>${escapeHTML(t)}</span>`).join('')}</div><div class="note-footer"><span>${escapeHTML(humanDate(n.createdAt))}</span><span>${escapeHTML(findResource(n.resourceId || n.bookId)?.title || 'Personal idea')}</span></div></article>`).join('') : emptyState('✎','No notes match that search','Create an idea, save a summary, or bring notes back from an AI task.','<button class="button primary" data-action="new-note">＋ New note</button>')}</div>
    <section class="study-sets-section"><div class="section-title-row"><div><div class="eyebrow">CREATED WITH AI TASKS</div><h2>Study tools</h2></div><button class="text-button" data-route="ai-tasks">Create another ↗</button></div><div class="study-set-grid">${(state.flashcards||[]).map(set=>`<article class="study-set-card"><span class="study-set-icon">▤</span><div><strong>${escapeHTML(set.title||'Flashcards')}</strong><small>${(set.cards||[]).length} cards · ${escapeHTML(humanDate(set.createdAt))}</small></div><button class="button secondary small" data-action="open-study-set" data-kind="flashcards" data-id="${escapeHTML(set.id)}">Review ↗</button></article>`).join('')}${(state.quizzes||[]).map(set=>`<article class="study-set-card"><span class="study-set-icon quiz">✓</span><div><strong>${escapeHTML(set.title||'Quiz')}</strong><small>${(set.questions||[]).length} questions · ${escapeHTML(humanDate(set.createdAt))}</small></div><button class="button secondary small" data-action="open-study-set" data-kind="quiz" data-id="${escapeHTML(set.id)}">Take quiz ↗</button></article>`).join('')}${(state.schedules||[]).map(set=>`<article class="study-set-card"><span class="study-set-icon schedule">◷</span><div><strong>${escapeHTML(set.title||'Study schedule')}</strong><small>${(set.sessions||[]).length} sessions · ${escapeHTML(humanDate(set.createdAt))}</small></div><button class="button secondary small" data-action="open-study-set" data-kind="schedule" data-id="${escapeHTML(set.id)}">View ↗</button></article>`).join('')}${!(state.flashcards||[]).length && !(state.quizzes||[]).length && !(state.schedules||[]).length?'<div class="study-set-empty">No study sets yet. Generate flashcards, a quiz, or a study schedule from the AI Task Bridge.</div>':''}</div></section>`;
}


function openCollectionEditor(collectionId = '') {
  const collection = state.collections.find(c => c.id === collectionId);
  const selected = new Set(collection?.resourceIds || collection?.bookIds || []);
  const choices = state.resources.filter(r => state.libraryIds.includes(r.id));
  const options = choices.map(r => `<option value="${escapeHTML(r.id)}" ${selected.has(r.id) ? 'selected' : ''}>${escapeHTML(r.title)} · ${escapeHTML(typeLabels[r.type] || r.type)}</option>`).join('');
  setModal(collection ? 'Edit collection' : 'Create collection', `<form id="collectionForm">
    <input type="hidden" name="collectionId" value="${escapeHTML(collection?.id || '')}">
    <label>Collection name<input name="name" required maxlength="120" value="${escapeHTML(collection?.name || '')}" placeholder="Frontend reading list"></label>
    <label>Description<textarea name="description" rows="3" maxlength="1000" placeholder="What brings these resources together?">${escapeHTML(collection?.description || '')}</textarea></label>
    <label>Resources <small class="muted">Select multiple with Ctrl/Cmd or use your phone's multi-select control.</small><select name="resourceIds" multiple size="8">${options}</select></label>
    <p class="muted">Only resources already saved to My Library are listed. Save more resources from Discover first.</p>
    <div class="form-actions"><button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">${collection ? 'Save collection' : 'Create collection'}</button></div>
  </form>`, 'PERSONAL COLLECTIONS');
}
function saveCollection(form) {
  const fd = new FormData(form);
  const name = String(fd.get('name') || '').trim();
  if (!name) { toast('Give the collection a name first.', 'error'); return; }
  const ids = [...new Set($$('select[name="resourceIds"] option:checked', form).map(option => option.value).filter(id => findResource(id)))];
  const description = String(fd.get('description') || '').trim();
  const collectionId = String(fd.get('collectionId') || '');
  let collection = state.collections.find(c => c.id === collectionId);
  if (collection) {
    collection.name = name; collection.description = description; collection.resourceIds = ids; collection.bookIds = ids;
  } else {
    collection = { id: makeId('collection'), name, description, resourceIds: ids, bookIds: ids, createdAt: new Date().toISOString() };
    state.collections.unshift(collection);
  }
  libraryFilter = `collection:${collection.id}`;
  closeModal(); persistSoon(); navigate('library'); toast(collectionId ? 'Collection updated.' : 'Collection created.');
}
function openStudySet(kind, id) {
  if (kind === 'flashcards') {
    const set = (state.flashcards || []).find(x => x.id === id); if (!set) return;
    setModal(set.title || 'Flashcards', `<p class="muted">Try answering before opening each card. These cards were generated from an AI response, so review any uncertain answers.</p><div class="study-review-list">${(set.cards || []).map((card, i) => `<details class="study-review-card"><summary><span>${String(i + 1).padStart(2, '0')}</span>${escapeHTML(card.question || 'Question')}</summary><div class="study-answer">${escapeHTML(card.answer || '')}</div></details>`).join('') || '<p class="muted">This set contains no cards.</p>'}</div><div class="form-actions"><button class="button primary" data-action="close-modal">Done</button></div>`, 'STUDY TOOLS', true);
    return;
  }
  if (kind === 'quiz') {
    const set = (state.quizzes || []).find(x => x.id === id); if (!set) return;
    const questions = set.questions || [];
    const body = `<p class="muted">Choose one answer per question. The score is calculated locally from the answer key returned in the imported AI result.</p><form id="quizAnswerForm" data-quiz-id="${escapeHTML(id)}">${questions.map((q, i) => `<fieldset class="quiz-question"><legend><span>${i + 1}</span>${escapeHTML(q.question || '')}</legend>${(q.options || []).map((option, j) => `<label class="quiz-option"><input type="radio" name="q${i}" value="${j}" required><span>${escapeHTML(option)}</span></label>`).join('')}</fieldset>`).join('')}<div id="quizResults" aria-live="polite"></div><div class="form-actions"><button class="button secondary" type="button" data-action="close-modal">Close</button><button class="button primary" type="submit">Check answers</button></div></form>`;
    setModal(set.title || 'Practice quiz', body, 'STUDY TOOLS', true); return;
  }
  if (kind === 'schedule') {
    const set = (state.schedules || []).find(x => x.id === id); if (!set) return;
    setModal(set.title || 'Study schedule', `<p>${escapeHTML(set.goal || 'A suggested study plan.')}</p><div class="schedule-list">${(set.sessions || []).map((session, i) => `<article class="schedule-session"><span>${String(i + 1).padStart(2, '0')}</span><div><strong>${escapeHTML(session.dayLabel || `Session ${i + 1}`)} · ${escapeHTML(session.title || '')}</strong><p>${escapeHTML((session.objectives || []).join(' · '))}</p><small>${Number(session.estimatedMinutes) || 0} minutes</small></div></article>`).join('') || '<p class="muted">No sessions were included.</p>'}</div><div class="form-actions"><button class="button primary" data-action="close-modal">Done</button></div>`, 'STUDY TOOLS', true);
  }
}

function renderGraph() {
  const topic = state.topics.find(t=>t.id===selectedTopicId) || state.topics[0];
  if (!topic) return `${pageHeading('SEE THE CONNECTIONS','Knowledge Graph','Connect resources, topics, and ideas.','<button class="button primary" data-action="new-topic">＋ New topic</button>')}${emptyState('◎','No topics yet','Create a topic or ask an AI task to suggest connections.')}`;
  const connectedIds = new Set(state.connections.filter(c=>c.source===topic.id || c.target===topic.id).map(c=>c.source===topic.id?c.target:c.source));
  const relatedResources = state.resources.filter(r=>(r.topicIds||[]).includes(topic.id));
  const relatedNotes = state.notes.filter(n=>(n.topicIds||[]).includes(topic.id));
  const graphNodes = state.topics.map((t,i)=>({ ...t, x: 12 + (i%4)*25, y: i%2===0?24:68 }));
  const nodes = graphNodes.map(t=>`<button class="graph-topic ${t.id===topic.id?'selected':''}" data-action="select-topic" data-id="${escapeHTML(t.id)}" style="--x:${t.x}%;--y:${t.y}%"><span>✦</span>${escapeHTML(t.name)}</button>`).join('');
  return `${pageHeading('YOUR IDEA MAP','Knowledge Graph','Explore how topics, resources, and saved ideas connect.','<button class="button secondary" data-action="prepare-task" data-id="graph.connections">Suggest connections with AI ↗</button><button class="button primary" data-action="new-topic">＋ New topic</button>')}
    <div class="graph-layout"><section class="graph-canvas-card"><div class="graph-canvas-top"><div><div class="eyebrow">CONNECTED TOPICS</div><h2>${state.topics.length} topics · ${state.connections.length} links</h2></div><span class="type-chip">Select a topic</span></div><div class="graph-field"><svg class="graph-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${state.connections.map(c=>{const a=graphNodes.find(t=>t.id===c.source),b=graphNodes.find(t=>t.id===c.target);return a&&b?`<line x1="${a.x+8}" y1="${a.y+2}" x2="${b.x+8}" y2="${b.y+2}"/>`:''}).join('')}</svg>${nodes}</div><div class="graph-legend"><span>● Topic</span><span>─ Relationship</span><button class="text-button" data-action="new-connection">＋ Connect topics</button></div></section>
    <aside class="topic-detail-card"><div class="eyebrow">SELECTED TOPIC</div><div class="topic-orb">✦</div><h2>${escapeHTML(topic.name)}</h2><p>${escapeHTML(topic.description || 'A topic in your knowledge universe.')}</p><div class="detail-divider"></div><div class="section-mini-title">CONNECTED TOPICS <small>${connectedIds.size}</small></div>${[...connectedIds].map(id=>state.topics.find(t=>t.id===id)).filter(Boolean).map(t=>`<button class="connected-row" data-action="select-topic" data-id="${escapeHTML(t.id)}"><span class="mini-dot"></span>${escapeHTML(t.name)}<b>↗</b></button>`).join('') || '<p class="muted-small">No connections yet.</p>'}<div class="detail-divider"></div><div class="section-mini-title">RELATED RESOURCES <small>${relatedResources.length}</small></div>${relatedResources.map(r=>`<button class="related-row" data-action="open-resource" data-id="${escapeHTML(r.id)}"><span class="resource-mini-icon">${escapeHTML(typeIcons[r.type]||'✦')}</span><span><strong>${escapeHTML(r.title)}</strong><small>${escapeHTML(typeLabels[r.type]||r.type)}</small></span><b>↗</b></button>`).join('') || '<p class="muted-small">No resources linked to this topic yet.</p>'}<div class="section-mini-title">YOUR NOTES <small>${relatedNotes.length}</small></div>${relatedNotes.map(n=>`<button class="connected-row" data-action="edit-note" data-id="${escapeHTML(n.id)}">✎ ${escapeHTML(n.title)} <b>↗</b></button>`).join('') || '<p class="muted-small">No related notes yet.</p>'}<button class="button secondary full" data-action="new-note" data-topic-id="${escapeHTML(topic.id)}">＋ Add an idea</button></aside></div>`;
}

function findPath(id) { return state.paths.find(p=>p.id===id); }
function renderPaths() {
  if (selectedPathId) {
    const path = findPath(selectedPathId);
    if (path) return renderPathDetail(path);
    selectedPathId = null;
  }
  return `${pageHeading('STRUCTURED EXPLORATION','Learning Paths','Build a route through a subject. Import and export paths as portable JSON.','<button class="button secondary" data-action="import-json">Import JSON ↥</button><button class="button secondary" data-action="prepare-task" data-id="learning-path.create">Create with AI ↗</button><button class="button primary" data-action="new-path">＋ Create path</button>')}
    <div class="paths-info"><span>↗</span><div><strong>Paths are portable.</strong><p>Use the documented <code>neo-world.learning-path</code> JSON format. You can write it yourself or ask an external AI to generate it using a context-aware prompt.</p></div><button class="text-button" data-action="copy-path-prompt">Copy JSON format prompt ↗</button></div>
    <div class="path-grid">${state.paths.map(path=>{const total=path.steps?.length||0,done=(path.steps||[]).filter(s=>s.done).length,percent=total?Math.round(done/total*100):0;return `<article class="path-card"><div class="path-card-top"><span class="path-icon">${escapeHTML(path.icon||'↗')}</span><span class="type-chip">${escapeHTML(path.difficulty||path.category||'Learning')}</span><button class="icon-btn" data-action="export-path" data-id="${escapeHTML(path.id)}" title="Export path">⇩</button></div><h2>${escapeHTML(path.title)}</h2><p>${escapeHTML(path.description||path.subtitle||'A structured learning journey.')}</p><div class="path-tags">${(path.tags||[path.category]).filter(Boolean).slice(0,3).map(t=>`<span>${escapeHTML(t)}</span>`).join('')}</div><div class="path-progress-row"><span>${done}/${total} steps complete</span><b>${percent}%</b></div><div class="progress-track"><span style="width:${percent}%"></span></div><div class="path-card-footer"><span>◷ ${path.minutes||path.steps.reduce((n,s)=>n+(s.estimatedMinutes||0),0)} min estimated</span><button class="button primary small" data-action="open-path" data-id="${escapeHTML(path.id)}">Open path ↗</button></div></article>`}).join('')}</div>`;
}
function renderPathDetail(path) {
  const total = path.steps.length, done = path.steps.filter(s=>s.done).length;
  return `${pageHeading('YOUR LEARNING JOURNEY',escapeHTML(path.title),escapeHTML(path.description||path.subtitle||'Move through the steps at your own pace.'),`<button class="button secondary" data-action="export-path" data-id="${escapeHTML(path.id)}">Export JSON ⇩</button><button class="button secondary" data-action="back-paths">← All paths</button>`)}
    <section class="path-detail-hero"><div><div class="eyebrow">${escapeHTML(path.category||'LEARNING PATH')}</div><h2>${escapeHTML(path.title)}</h2><p>${escapeHTML(path.description||path.subtitle||'')}</p><div class="path-progress-row"><span>${done} of ${total} steps completed</span><strong>${total?Math.round(done/total*100):0}%</strong></div><div class="progress-track"><span style="width:${total?done/total*100:0}%"></span></div></div><div class="path-detail-badge">${total?Math.round(done/total*100):0}%</div></section>
    <div class="path-steps-list">${path.steps.map((step,index)=>`<article class="path-step ${step.done?'step-done':''}"><button class="step-check" data-action="toggle-path-step" data-path-id="${escapeHTML(path.id)}" data-step-id="${escapeHTML(step.id)}" aria-label="${step.done?'Mark incomplete':'Mark complete'}">${step.done?'✓':String(index+1).padStart(2,'0')}</button><div class="path-step-content"><div class="path-step-top"><h3>${escapeHTML(step.title)}</h3><span>${step.estimatedMinutes?`◷ ${step.estimatedMinutes} min`:''}</span></div><p>${escapeHTML(step.detail||step.description||'Explore this step and capture an idea.')}</p>${step.resourceId&&findResource(step.resourceId)?`<button class="text-button" data-action="open-resource" data-id="${escapeHTML(step.resourceId)}">Open ${escapeHTML(findResource(step.resourceId).title)} ↗</button>`:step.resource?.url?`<a class="text-button external-step-link" href="${escapeHTML(step.resource.url)}" target="_blank" rel="noopener noreferrer">Open suggested resource ↗</a><small class="unverified-note">External suggestion; not verified by Neo World.</small>`:''}</div><button class="step-complete-action ${step.done?'':'active'}" data-action="toggle-path-step" data-path-id="${escapeHTML(path.id)}" data-step-id="${escapeHTML(step.id)}">${step.done?'Completed':'Mark done'}</button></article>`).join('')}</div><div class="path-end-actions"><button class="button secondary" data-action="prepare-task" data-id="learning-path.create">Ask AI to improve this path ↗</button><button class="button danger-ghost" data-action="delete-path" data-id="${escapeHTML(path.id)}">Delete path</button></div>`;
}

function renderGarden() {
  const count = Number(state.garden.activityCount || 0), level = count >= 18 ? 'Little forest' : count >= 10 ? 'Growing grove' : count >= 5 ? 'Finding roots' : 'First sprout';
  const plantCount = Math.min(16, Math.max(3, Math.floor(count / 2) + 2));
  const plants = Array.from({length:plantCount},(_,i)=>`<div class="garden-plant plant-${i%6}" style="--plant-x:${5+i*(90/Math.max(1,plantCount-1))}%;--plant-h:${42+(i*17)%52}px;--plant-delay:${i*.12}s"><span>${['✿','♧','❀','✾','✧'][i%5]}</span><i></i></div>`).join('');
  const recent = (state.garden.activityLog||[]).slice(0,8);
  return `${pageHeading('A QUIETER KIND OF PROGRESS','Knowledge Garden','A visual reminder of what you have explored. It is not a score of your intelligence.','<button class="button secondary" data-action="garden-guide">How it grows ↗</button>')}
    <section class="garden-hero"><div class="garden-hero-copy"><span class="hero-kicker">✦ YOUR PERSONAL GARDEN</span><h2>A little care.<br><em>A little growth.</em></h2><p>Reading sessions, new ideas, and connected topics make your garden grow.</p><div class="garden-stage"><span>❋</span><div><small>YOUR GARDEN STAGE</small><strong>${level}</strong></div><b>${count} activities</b></div><button class="button white" data-route="discover">Explore something new ↗</button></div><div class="garden-scene"><div class="garden-moon"></div><div class="garden-hill hill-back"></div><div class="garden-hill hill-front"></div><div class="garden-plants">${plants}</div><div class="garden-stars">✦　✧<br>　·　✦</div></div></section>
    <section class="stat-grid"><div class="stat-card"><span class="stat-icon violet">✦</span><div><small>ACTIVITIES</small><strong>${count}</strong><em>moments of growth</em></div></div><div class="stat-card"><span class="stat-icon mint">♧</span><div><small>IDEAS CAPTURED</small><strong>${state.notes.length}</strong><em>seeds of thought</em></div></div><div class="stat-card"><span class="stat-icon peach">↗</span><div><small>PATH STEPS</small><strong>${state.paths.reduce((n,p)=>n+p.steps.filter(s=>s.done).length,0)}</strong><em>new ground explored</em></div></div><div class="stat-card"><span class="stat-icon blue">▤</span><div><small>SAVED RESOURCES</small><strong>${state.libraryIds.length}</strong><em>things to return to</em></div></div></section>
    <section class="garden-activity-panel"><div class="section-title-row"><div><div class="eyebrow">RECENT LITTLE MOMENTS</div><h2>Activity log</h2></div><span class="saved-status">● Saved locally</span></div>${recent.length ? recent.map(a=>`<div class="activity-row"><span class="activity-icon">${({reading:'▤',note:'✎',path:'↗',connection:'◎',resource:'✦',garden:'❋'})[a.type]||'✦'}</span><div><strong>${escapeHTML(a.label)}</strong><small>${escapeHTML(humanDate(a.date))}</small></div></div>`).join('') : '<p class="muted">Explore a resource or save an idea to start growing your garden.</p>'}</section>`;
}

function renderAITasks() {
  const history = state.aiTaskHistory || [];
  return `${pageHeading('EXTERNAL AI, CONNECTED TO YOUR CONTEXT','AI Task Bridge','Neo World prepares the prompt, validates the response, and lets you approve changes. No AI API key required.','<button class="button secondary" data-action="import-ai-result">Import AI response ↥</button>')}
    <div class="ai-bridge-banner"><div class="ai-big-icon">✳</div><div><h2>Neo World handles the structured work.</h2><p>Choose a task, copy a context-aware prompt into any AI, then return its JSON or text. Every change is previewed before it is applied.</p><div class="ai-bridge-flow"><span>01 Prepare</span><b>→</b><span>02 Copy</span><b>→</b><span>03 Paste response</span><b>→</b><span>04 Review & apply</span></div></div></div>
    <div class="task-categories">${[...new Set(AI_TASKS.map(t=>t.category))].map(category=>`<section class="task-category"><div class="section-title-row"><div><div class="eyebrow">TASK COLLECTION</div><h2>${escapeHTML(category)}</h2></div></div><div class="task-grid">${AI_TASKS.filter(t=>t.category===category).map(task=>`<article class="task-card"><div class="task-icon">${escapeHTML(task.icon)}</div><h3>${escapeHTML(task.title)}</h3><p>${escapeHTML(task.description)}</p><div class="task-card-footer"><span>${task.output==='learning-path'?'Path JSON':'Structured result'}</span><button class="button primary small" data-action="prepare-task" data-id="${escapeHTML(task.id)}">${escapeHTML(task.button)} ↗</button></div></article>`).join('')}</div></section>`).join('')}</div>
    <section class="task-history"><div class="section-title-row"><div><div class="eyebrow">YOUR TASK LOG</div><h2>Recent AI tasks</h2></div><button class="button secondary small" data-action="import-ai-result">Return a response ↥</button></div>${history.length?history.slice(0,8).map(h=>`<div class="history-row"><span class="history-icon">✳</span><div><strong>${escapeHTML(h.title || getTask(h.taskId)?.title || h.taskId)}</strong><small>${escapeHTML(h.status || 'prompt-ready')} · ${escapeHTML(humanDate(h.createdAt))}</small></div><button class="text-button" data-action="view-task-prompt" data-id="${escapeHTML(h.id)}">View prompt ↗</button></div>`).join(''):'<p class="muted">Prepared prompts appear here. No responses are sent to an external service by Neo World.</p>'}</section>`;
}

function renderReader() {
  const resource = findResource(selectedResourceId);
  if (!resource) return `${pageHeading('RESOURCE READER','Resource not found','This resource may have been removed.','<button class="button secondary" data-route="library">Back to library</button>')}`;
  const p = getProgress(resource.id);
  const sourceUrl = resource.source?.url;
  const sourceAction = sourceUrl ? `<a class="button secondary small" href="${escapeHTML(sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : '';
  const cacheAction = sourceUrl && ['pdf','image','audio','video','epub'].includes(resource.type) ? `<button class="button secondary small" data-action="cache-resource" data-id="${escapeHTML(resource.id)}">Cache 24h ↓</button>` : '';
  const cachedLabelPromisePlaceholder = '';
  return `<div class="reader-page"><div class="reader-header"><button class="text-button" data-action="back-to-previous">← Back</button><div class="reader-title"><div class="eyebrow">${resourceTypeChip(resource)} · ${escapeHTML(resource.category||'Resource')}</div><h1>${escapeHTML(resource.title)}</h1><p>${escapeHTML(resource.description||'')}</p></div><div class="reader-header-actions"><button class="button secondary small" data-action="new-note" data-resource-id="${escapeHTML(resource.id)}">＋ Note</button>${sourceAction}${cacheAction}${sourceUrl && ['pdf','epub','image','audio','video'].includes(resource.type) ? `<button class="button secondary small" data-action="save-local-copy" data-id="${escapeHTML(resource.id)}">Save local copy ⇩</button>` : ''}<button class="button secondary small" data-action="resource-menu" data-id="${escapeHTML(resource.id)}">···</button></div></div><div class="reader-progress-strip"><span><strong>Progress</strong> ${escapeHTML(progressSummary(resource))}</span><span>${p.lastViewedAt?`Last opened ${escapeHTML(humanDate(p.lastViewedAt))}`:'Ready to explore'}</span></div><div id="readerMount" class="reader-mount"><div class="reader-state">Preparing reader…</div></div><div class="reader-bottom-actions"><button class="button secondary" data-action="toggle-library" data-id="${escapeHTML(resource.id)}">${state.libraryIds.includes(resource.id)?'✓ Saved in My Library':'＋ Add to My Library'}</button><button class="button secondary" data-action="new-note" data-resource-id="${escapeHTML(resource.id)}">Capture an idea ↗</button></div></div>`;
}

function render() {
  if (route !== 'reader') destroyReader();
  const views = { home:renderHome, discover:renderDiscover, library:renderLibrary, notes:renderNotes, graph:renderGraph, paths:renderPaths, garden:renderGarden, 'ai-tasks':renderAITasks, reader:renderReader };
  appContent().innerHTML = (views[route] || renderHome)();
  $('#pageLabel').textContent = titleForRoute();
  setActiveNavigation(); updateSidebar();
  document.title = `${titleForRoute()} · Neo World`;
  if (route === 'reader') mountReader();
}

function navigate(next, opts = {}) {
  if (next !== 'reader') destroyReader();
  route = next; if (!opts.keepQuery) globalQuery = '';
  $('.app-shell').classList.remove('menu-open');
  render(); if (opts.scroll !== false) window.scrollTo({ top:0, behavior:'smooth' });
  appContent().focus({ preventScroll:true });
}

async function getResourcePayload(resource) {
  try {
    const blob = await getBlobForResource(resource);
    if (blob) return { blob, url: null, cached: false };
  } catch (error) { toast(error.message, 'error'); return { blob: null, url: resource.source?.url || null, error }; }
  try {
    const cached = await getCachedResource(resource.id);
    if (cached) return { blob: cached.blob, url: null, cached: true, expiresAt: cached.expiresAt };
  } catch {}
  return { blob: null, url: resource.source?.url || null, cached: false };
}
function destroyReader() { readerToken++; if (activeReaderCleanup) { try { activeReaderCleanup(); } catch {} activeReaderCleanup = null; } }
async function mountReader() {
  if (activeReaderCleanup) { try { activeReaderCleanup(); } catch {} activeReaderCleanup = null; }
  const token = readerToken + 1; readerToken = token;
  const resource = findResource(selectedResourceId); const mount = $('#readerMount');
  if (!resource || !mount) return;
  const progress = getProgress(resource.id);
  if (['pdf','epub','image','audio','video','book','text','file'].includes(resource.type)) {
    if (resource.source?.fileId || resource.source?.handleId || resource.source?.url) {
      const payload = await getResourcePayload(resource);
      if (token !== readerToken || !$('#readerMount')) return;
      if (payload.error && !payload.url && resource.source?.handleId) {
        mount.innerHTML = `<div class="reader-state error-state"><strong>Neo World needs permission to reopen this original file.</strong><p>${escapeHTML(payload.error.message || 'The browser did not grant access.')}</p><div class="form-actions"><button class="button primary" data-action="relink-original-file" data-id="${escapeHTML(resource.id)}">Choose file / grant access ↗</button><button class="button secondary" data-action="add-resource">Import a copy instead</button></div></div>`;
        return;
      }
      let cleanup = () => {};
      const opts = { resource, blob: payload.blob, progress: getProgress(resource.id), onProgress: p => saveResourceProgress(resource.id,p), onActivity: label => addActivity(resource.type==='book'?'reading':'resource',label) };
      try {
        if (resource.type === 'pdf') { const { mountPDFReader } = await import('./readers/pdf-reader.js'); cleanup = await mountPDFReader(mount, opts); }
        else if (resource.type === 'epub') { const { mountEPUBReader } = await import('./readers/epub-reader.js'); cleanup = await mountEPUBReader(mount, opts); }
        else if (resource.type === 'image') { const { mountImageReader } = await import('./readers/image-reader.js'); cleanup = mountImageReader(mount, opts); }
        else if (resource.type === 'audio' || resource.type === 'video') { const { mountMediaReader } = await import('./readers/media-reader.js'); cleanup = mountMediaReader(mount, opts); }
        else if (resource.type === 'file') { const { mountGenericFileReader } = await import('./readers/file-reader.js'); cleanup = mountGenericFileReader(mount, opts); }
        else { const { mountTextReader } = await import('./readers/text-reader.js'); cleanup = mountTextReader(mount, opts); }
      } catch (error) { mount.innerHTML = `<div class="reader-state error-state"><strong>Could not start this reader.</strong><p>${escapeHTML(error.message)}</p></div>`; }
      if (token !== readerToken) { try { cleanup?.(); } catch {} } else activeReaderCleanup = cleanup;
      return;
    }
  }
  if (resource.type === 'youtube') {
    const { mountYouTubeReader } = await import('./readers/youtube-reader.js');
    if (token !== readerToken || !$('#readerMount')) return;
    const cleanup = await mountYouTubeReader(mount,{resource,progress,onProgress:p=>saveResourceProgress(resource.id,p),onActivity:label=>addActivity('resource',label)});
    if (token !== readerToken) cleanup?.(); else activeReaderCleanup=cleanup;
    return;
  }
  if (resource.type === 'website') {
    const { mountWebsiteReader } = await import('./readers/website-reader.js');
    if (token !== readerToken || !$('#readerMount')) return;
    activeReaderCleanup = mountWebsiteReader(mount,{resource,progress,onProgress:p=>saveResourceProgress(resource.id,p),onActivity:label=>addActivity('resource',label)});
    return;
  }
  if (resource.type === 'file') { const { mountGenericFileReader } = await import('./readers/file-reader.js'); if (token !== readerToken || !$('#readerMount')) return; activeReaderCleanup = mountGenericFileReader(mount,{resource,progress}); return; }
  const { mountTextReader } = await import('./readers/text-reader.js');
  if (token !== readerToken || !$('#readerMount')) return;
  activeReaderCleanup = mountTextReader(mount,{resource,progress,onProgress:p=>saveResourceProgress(resource.id,p),onActivity:label=>addActivity('reading',label)});
}
function saveResourceProgress(resourceId, progress) {
  state.progress ||= {}; state.progress[resourceId] = { ...state.progress[resourceId], ...progress };
  persistSoon();
}
function openResource(id) {
  const resource = findResource(id); if (!resource) { toast('Resource not found.', 'error'); return; }
  selectedResourceId = id;
  state.recentResources = [id, ...(state.recentResources||[]).filter(x=>x!==id)].slice(0,10);
  const progress = getProgress(id);
  if (!progress.firstOpenedAt) { state.progress[id] = { ...progress, firstOpenedAt:new Date().toISOString(), lastViewedAt:new Date().toISOString() }; }
  if (resource.type === 'book' && !state.libraryIds.includes(id)) state.libraryIds.push(id);
  persistSoon(); navigate('reader');
}
function toggleLibrary(id) {
  const inLibrary = state.libraryIds.includes(id);
  if (inLibrary) state.libraryIds = state.libraryIds.filter(x=>x!==id);
  else { state.libraryIds.push(id); addActivity('resource',`Saved “${findResource(id)?.title || 'resource'}” to My Library`); }
  state.collections.forEach(c => { c.resourceIds ||= c.bookIds || []; c.bookIds = c.resourceIds; });
  persistSoon(); render(); toast(inLibrary ? 'Removed from My Library.' : 'Added to My Library.');
}

function addResourceRecord(resource, addToLibrary = true) {
  const duplicate = resource.source?.url && state.resources.find(r => r.source?.url === resource.source.url);
  if (duplicate) { toast('That URL is already in your catalog. Opening the existing resource.'); openResource(duplicate.id); return duplicate; }
  state.resources.unshift(resource);
  if (addToLibrary && !state.libraryIds.includes(resource.id)) state.libraryIds.unshift(resource.id);
  addActivity('resource',`Added “${resource.title}”`);
  persistSoon(); return resource;
}
function createResourceFromUrl(formData) {
  const validation = validateResourceUrl(formData.get('url'));
  if (!validation.ok) { toast(validation.error, 'error'); return; }
  const override = String(formData.get('type')||'auto');
  const type = override === 'auto' ? validation.type : override;
  if (type === 'youtube' && validation.type !== 'youtube') { toast('Choose a valid YouTube video URL for a YouTube resource.', 'error'); return; }
  const url = validation.url;
  const title = String(formData.get('title')||'').trim() || defaultTitleFromUrl(url);
  const resource = { id:makeId('resource'), type, title, author:String(formData.get('author')||'').trim(), category:String(formData.get('category')||'Uncategorized').trim()||'Uncategorized', description:String(formData.get('description')||'').trim(), tags:String(formData.get('tags')||'').split(',').map(x=>x.trim()).filter(Boolean), topicIds:[], source:{kind:'url',url}, createdAt:new Date().toISOString(), addedAt:new Date().toISOString() };
  const saved = addResourceRecord(resource,true);
  if (formData.get('cacheNow') === 'on' && ['pdf','epub','image','audio','video'].includes(type)) cacheRemoteResource(saved).then(()=>toast('Temporary cache ready for 24 hours.')).catch(error=>toast(`Resource added, but caching failed: ${error.message}`,'error'));
  closeModal(); render();
}
function defaultTitleFromUrl(url) { try { const u = new URL(url); const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname); return last.replace(/[-_]+/g,' ').replace(/\.(pdf|epub|png|jpe?g|webp|mp3|mp4|md|txt)$/i,'') || u.hostname; } catch { return 'Untitled resource'; } }
function openAddResourceModal() {
  const hasPicker = typeof window.showOpenFilePicker === 'function';
  setModal('Add a resource', `<div class="import-tabs"><button class="import-tab active" data-action="import-tab" data-tab="file">Upload file</button><button class="import-tab" data-action="import-tab" data-tab="url">Paste a link</button><button class="import-tab" data-action="import-tab" data-tab="json">Import JSON</button><button class="import-tab" data-action="import-tab" data-tab="manual">Create manually</button></div>
  <div class="import-panel" data-import-panel="file"><form id="importFileForm"><label class="dropzone" for="resourceFileInput"><span class="dropzone-icon">⇧</span><strong>Choose a file from your device</strong><span>PDF, EPUB, image, audio, video, TXT, Markdown, or JSON</span><input id="resourceFileInput" type="file" accept=".pdf,.epub,.txt,.md,.markdown,.csv,.json,image/*,audio/*,video/*"></label><div class="form-grid"><label>Title<input name="title" id="importFileTitle" placeholder="Detected from filename"></label><label>Category<input name="category" placeholder="e.g. Technology"></label></div><label>Description<textarea name="description" rows="2" placeholder="Optional context for future search and AI prompts"></textarea></label><div class="form-actions"><button class="button secondary" type="button" data-action="import-original-file" ${hasPicker?'':'disabled title="This browser does not support the File System Access API."'}>Use original file (supported browsers)</button><button class="button primary" type="submit">Import a copy ↗</button></div><p class="form-help">Import a copy stores the file in this browser. The original-file option stores a permissioned browser file handle where supported and may ask for permission again later.</p></form></div>
  <div class="import-panel hidden" data-import-panel="url"><form id="importUrlForm"><label>Resource URL<input name="url" type="url" required placeholder="https://…"></label><div class="form-grid"><label>Title<input name="title" placeholder="Auto-detected from URL"></label><label>Resource type<select name="type"><option value="auto">Auto-detect</option>${Object.entries(typeLabels).filter(([v])=>v!=='book').map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><label>Category<input name="category" placeholder="e.g. Psychology"></label><label>Author / creator<input name="author" placeholder="Optional"></label></div><label>Description<textarea name="description" rows="2" placeholder="What is useful about this resource?"></textarea></label><label>Tags, comma separated<input name="tags" placeholder="frontend, accessibility, design"></label><label class="check-row"><input name="cacheNow" type="checkbox"><span><strong>Try to cache the file for 24 hours</strong><small>Only for downloadable files and servers that permit browser access. YouTube videos are not downloaded.</small></span></label><div class="form-actions"><button class="button primary" type="submit">Add resource ↗</button></div></form></div>
  <div class="import-panel hidden" data-import-panel="json"><p>Import a Learning Path v1 or a structured AI result. The app validates the content and previews changes before applying them.</p><form id="importJSONForm"><label>Choose JSON file<input id="jsonImportFile" type="file" accept=".json,application/json"></label><label>Or paste JSON / AI response<textarea id="jsonImportText" rows="8" placeholder='{"format":"neo-world.learning-path","schemaVersion":1,"path":{...}}'></textarea></label><div class="form-actions"><button class="button secondary" type="button" data-action="import-ai-result">Open AI result importer</button><button class="button primary" type="submit">Validate and preview ↗</button></div></form></div>
  <div class="import-panel hidden" data-import-panel="manual"><form id="manualResourceForm"><label>Title<input name="title" required placeholder="Resource title"></label><div class="form-grid"><label>Type<select name="type">${Object.entries(typeLabels).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><label>Category<input name="category" placeholder="General"></label></div><label>Source URL (optional)<input name="url" type="url" placeholder="https://…"></label><label>Description<textarea name="description" rows="3" placeholder="What is it, and why did you save it?"></textarea></label><label>Tags<input name="tags" placeholder="topic, concept"></label><div class="form-actions"><button class="button primary" type="submit">Create resource</button></div></form></div>`, 'IMPORT YOUR KNOWLEDGE', true);
  const fileInput = $('#resourceFileInput');
  fileInput?.addEventListener('change', async () => { const file=fileInput.files?.[0]; if (file && !$('#importFileTitle').value) $('#importFileTitle').value=file.name.replace(/\.[^.]+$/,''); if (file && detectFileType(file)==='json') { const text=await file.text(); closeModal(); handleStructuredResponse(text); } });
}
function switchImportTab(tab) {
  $$('[data-import-panel]').forEach(panel=>panel.classList.toggle('hidden',panel.dataset.importPanel!==tab));
  $$('.import-tab').forEach(btn=>btn.classList.toggle('active',btn.dataset.tab===tab));
}
async function importSelectedFile(form) {
  const data = new FormData(form); const input = $('#resourceFileInput'); const file = input?.files?.[0];
  if (!file) { toast('Choose a file first.', 'error'); return; }
  const type = detectFileType(file);
  if (type === 'json') { const text = await file.text(); closeModal(); handleStructuredResponse(text); return; }
  if (type === 'file' && !['application/octet-stream',''].includes(file.type)) toast('The file type is not recognized. It will be stored as a generic file.', 'error');
  try {
    const fileId = await storeFile(file,{name:file.name,type:file.type});
    const resource = { id:makeId('resource'), type, title:String(data.get('title')||'').trim()||file.name.replace(/\.[^.]+$/,''), category:String(data.get('category')||'Uncategorized').trim()||'Uncategorized', description:String(data.get('description')||'').trim(), author:'', tags:[], topicIds:[], mimeType:file.type, source:{kind:'file',fileId,fileName:file.name,size:file.size}, metadata:{fileName:file.name,size:file.size,lastModified:file.lastModified}, createdAt:new Date().toISOString(), addedAt:new Date().toISOString() };
    addResourceRecord(resource,true); closeModal(); selectedResourceId=resource.id; navigate('reader'); toast(`${typeLabels[type]||'File'} imported into this browser.`);
  } catch (error) { toast(`Import failed: ${error.message}. Browser storage may be full.`, 'error'); }
}
async function importOriginalFile() {
  if (typeof window.showOpenFilePicker !== 'function') { toast('Original-file handles are not supported in this browser. Use Import a copy.', 'error'); return; }
  try {
    const [handle] = await window.showOpenFilePicker({ multiple:false });
    const file = await handle.getFile(); const type = detectFileType(file); const handleId=await storeFileHandle(handle,{name:file.name});
    const resource={id:makeId('resource'),type,title:file.name.replace(/\.[^.]+$/,''),category:'Uncategorized',description:'Linked to the original file on this device. The browser may request permission again later.',tags:[],topicIds:[],mimeType:file.type,source:{kind:'handle',handleId,fileName:file.name,size:file.size},metadata:{fileName:file.name,size:file.size,lastModified:file.lastModified},createdAt:new Date().toISOString(),addedAt:new Date().toISOString()};
    addResourceRecord(resource,true); closeModal(); selectedResourceId=resource.id; navigate('reader'); toast('Original file linked. Permission will be checked when it is opened.');
  } catch (error) { if (error?.name !== 'AbortError') toast(`Could not link the original file: ${error.message}`, 'error'); }
}
async function relinkOriginalFile(resourceId) {
  const resource=findResource(resourceId);
  if(!resource)return;
  if(typeof window.showOpenFilePicker!=='function'){toast('This browser cannot keep a file handle. Choose Import a copy instead.','error');openAddResourceModal();return;}
  try{
    const [handle]=await window.showOpenFilePicker({multiple:false});
    const file=await handle.getFile();
    const expectedName=resource.source?.fileName||resource.metadata?.fileName;
    if(expectedName&&file.name!==expectedName){toast(`Selected ${file.name}, but this resource was linked to ${expectedName}. No change was made.`,'error');return;}
    const type=detectFileType(file);
    if(type!==resource.type&&!(resource.type==='file'&&type==='file')){toast(`Selected file is ${typeLabels[type]||type}, but this resource expects ${typeLabels[resource.type]||resource.type}. No change was made.`,'error');return;}
    const handleId=await storeFileHandle(handle,{name:file.name});
    resource.source={...(resource.source||{}),kind:'handle',handleId,fileName:file.name,size:file.size};
    resource.mimeType=file.type||resource.mimeType;resource.metadata={...(resource.metadata||{}),fileName:file.name,size:file.size,lastModified:file.lastModified};
    persistSoon();render();toast('File access restored.');
  }catch(error){if(error?.name!=='AbortError')toast(`Could not restore file access: ${error.message}`,'error');}
}
function createManualResource(form) {
  const data=new FormData(form); const title=String(data.get('title')||'').trim(); if(!title){toast('Add a title first.','error');return;}
  const urlRaw=String(data.get('url')||'').trim(); let source={kind:'manual'}; let type=String(data.get('type')||'text');
  if(urlRaw){const url=safeHttpUrl(urlRaw);if(!url){toast('Use a valid HTTP(S) URL.','error');return;}source={kind:'url',url};if(type==='website')type=detectUrlType(url);}
  const resource={id:makeId('resource'),type,title,category:String(data.get('category')||'General').trim()||'General',description:String(data.get('description')||'').trim(),tags:String(data.get('tags')||'').split(',').map(s=>s.trim()).filter(Boolean),topicIds:[],source,createdAt:new Date().toISOString(),addedAt:new Date().toISOString()};
  addResourceRecord(resource,true);closeModal();selectedResourceId=resource.id;navigate('reader');
}

function openNoteEditor(noteId = '', resourceId = '', topicId = '') {
  const note=noteId?state.notes.find(n=>n.id===noteId):null;
  const selectedResource=resourceId || note?.resourceId || note?.bookId || '';
  setModal(note?'Edit note':'Capture an idea', `<form id="noteForm"><input type="hidden" name="noteId" value="${escapeHTML(note?.id||'')}"><label>Title<input name="title" required maxlength="180" value="${escapeHTML(note?.title||'')}" placeholder="What do you want to remember?"></label><label>Your idea<textarea name="content" rows="6" required maxlength="12000" placeholder="Write the thought in your own words…">${escapeHTML(note?.content||'')}</textarea></label><div class="form-grid"><label>Related resource<select name="resourceId"><option value="">Personal idea</option>${state.resources.map(r=>`<option value="${escapeHTML(r.id)}" ${selectedResource===r.id?'selected':''}>${escapeHTML(r.title)}</option>`).join('')}</select></label><label>Topics<select name="topicIds" id="noteTopicSelect" multiple size="4">${state.topics.map(t=>`<option value="${escapeHTML(t.id)}" ${(note?.topicIds||[topicId].filter(Boolean)).includes(t.id)?'selected':''}>${escapeHTML(t.name)}</option>`).join('')}</select></label></div><label class="check-row"><input type="checkbox" name="favorite" ${note?.favorite?'checked':''}><span><strong>Keep this idea close</strong><small>Add the note to favorites.</small></span></label><div class="form-actions">${note?`<button class="button danger-ghost" type="button" data-action="delete-note" data-id="${escapeHTML(note.id)}">Delete note</button>`:''}<button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">${note?'Save changes':'Save idea'} ↗</button></div></form>`, 'YOUR NOTEBOOK', true);
}
function saveNote(form) {
  const data=new FormData(form), title=String(data.get('title')||'').trim(), content=String(data.get('content')||'').trim();
  if(!title||!content){toast('A note needs a title and content.','error');return;}
  const noteId=String(data.get('noteId')||''), resourceId=String(data.get('resourceId')||''), topicIds=$$('select[name="topicIds"] option:checked',form).map(o=>o.value), favorite=data.get('favorite')==='on';
  if(noteId){const note=state.notes.find(n=>n.id===noteId);if(note)Object.assign(note,{title,content,resourceId,bookId:resourceId,topicIds,favorite,updatedAt:new Date().toISOString()});}
  else {state.notes.unshift({id:makeId('note'),title,content,resourceId,bookId:resourceId,topicIds,createdAt:new Date().toISOString(),favorite});addActivity('note','Captured an idea');}
  persistSoon();closeModal();render();toast(noteId?'Note updated.':'Idea saved.');
}

function openNewTopicModal() {
  setModal('Create a topic', `<form id="topicForm"><label>Topic name<input name="name" required maxlength="100" placeholder="e.g. Browser performance"></label><label>Description<textarea name="description" rows="3" placeholder="What does this topic cover?"></textarea></label><div class="form-actions"><button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Create topic</button></div></form>`, 'KNOWLEDGE GRAPH');
}
function openNewConnectionModal() {
  setModal('Connect two topics', `<form id="connectionForm"><label>Source topic<select name="source" required>${state.topics.map(t=>`<option value="${escapeHTML(t.id)}">${escapeHTML(t.name)}</option>`).join('')}</select></label><label>Target topic<select name="target" required>${state.topics.map(t=>`<option value="${escapeHTML(t.id)}">${escapeHTML(t.name)}</option>`).join('')}</select></label><label>Why are these connected?<textarea name="reason" rows="2" placeholder="Optional note about the relationship"></textarea></label><div class="form-actions"><button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Connect topics</button></div></form>`, 'KNOWLEDGE GRAPH');
}
function createManualPath() {
  setModal('Create a learning path', `<form id="newPathForm"><label>Path title<input name="title" required maxlength="180" placeholder="e.g. Learn web accessibility"></label><label>Description<textarea name="description" rows="2" placeholder="What should this path help you learn?"></textarea></label><div class="form-grid"><label>Difficulty<select name="difficulty"><option>beginner</option><option>intermediate</option><option>advanced</option></select></label><label>Tags<input name="tags" placeholder="frontend, accessibility"></label></div><label>Steps (one title per line)<textarea name="steps" rows="5" required placeholder="Understand the fundamentals\nExplore practical examples\nApply what you learned"></textarea></label><div class="form-actions"><button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Create path</button></div></form>`, 'LEARNING PATHS');
}

function prepareTask(taskId, initial = {}) {
  const task=getTask(taskId);if(!task){toast('Unknown AI task.','error');return;}
  const initialResourceId=initial.resourceId||'';
  const resourceOptions=state.resources.map(r=>`<option value="${escapeHTML(r.id)}" ${r.id===initialResourceId?'selected':''}>${escapeHTML(r.title)} · ${escapeHTML(typeLabels[r.type]||r.type)}</option>`).join('');
  const noteOptions=state.notes.map(n=>`<option value="${escapeHTML(n.id)}">${escapeHTML(n.title)}</option>`).join('');
  setModal(task.title, `<div class="task-modal-intro"><div class="task-icon large">${escapeHTML(task.icon)}</div><p>${escapeHTML(task.description)} The prompt includes your selected resources, notes, and pasted text, plus limited catalog metadata where the task needs it. Review the full prompt before copying it externally.</p></div><form id="prepareTaskForm"><input type="hidden" name="taskId" value="${escapeHTML(task.id)}"><label>Goal / question<textarea name="goal" rows="2" required>${escapeHTML(initial.goal||task.description)}</textarea></label><label>Additional constraints<textarea name="constraints" rows="2" placeholder="Time limit, audience, preferred style, things to avoid…">${escapeHTML(initial.constraints||'')}</textarea></label><div class="form-grid"><label>Relevant resources <small>Multi-select</small><select name="resourceIds" multiple size="5">${resourceOptions}</select></label><label>Relevant notes <small>Multi-select</small><select name="noteIds" multiple size="5">${noteOptions}</select></label></div><label>Content to include (optional)<textarea name="suppliedText" rows="5" placeholder="Paste relevant excerpts, transcript, article text, or notes here. A URL alone does not give Neo World the page contents."></textarea></label><div class="prompt-privacy-note">ⓘ The prompt will contain only the selected metadata, notes, and text above. Review it before copying it to an external AI.</div><div class="form-actions"><button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Prepare contextual prompt ↗</button></div></form>`, 'AI TASK BRIDGE', true);
}
function generateTaskPrompt(form) {
  const data=new FormData(form), taskId=String(data.get('taskId')||'');
  const resourceIds=$$('select[name="resourceIds"] option:checked',form).map(o=>o.value), noteIds=$$('select[name="noteIds"] option:checked',form).map(o=>o.value);
  const options={ goal:String(data.get('goal')||''), constraints:String(data.get('constraints')||''), suppliedText:String(data.get('suppliedText')||''), resourceIds, noteIds };
  let prompt;
  try { prompt=buildPrompt(taskId,state,options); } catch(error) { toast(error.message,'error');return; }
  const task=getTask(taskId), run={id:makeId('taskrun'),taskId,title:task.title,goal:options.goal,resourceIds,noteIds,prompt,status:'prompt-ready',createdAt:new Date().toISOString()};
  state.aiTaskHistory.unshift(run);state.aiTaskHistory=state.aiTaskHistory.slice(0,40);persistSoon();
  showPreparedPrompt(run);
}
function showPreparedPrompt(run) {
  setModal('Your prompt is ready', `<div class="prompt-ready-banner"><span>✳</span><div><strong>${escapeHTML(run.title)}</strong><small>Context included: ${run.resourceIds.length} resources · ${run.noteIds.length} notes</small></div><span class="saved-status">Not sent</span></div><label>Copy this prompt into the AI tool you prefer<textarea id="preparedPromptText" rows="18" readonly>${escapeHTML(run.prompt)}</textarea></label><div class="form-actions"><button class="button secondary" data-action="copy-prompt" data-id="${escapeHTML(run.id)}">Copy prompt ⧉</button><button class="button secondary" data-action="import-ai-result" data-task-id="${escapeHTML(run.taskId)}">Paste AI response ↥</button><button class="button primary" data-action="close-modal">Done</button></div><p class="form-help">Neo World has not sent anything to an external AI. You control what you copy and where you paste it.</p>`, 'COPY · USE EXTERNAL AI', true);
}
function openAIResultImporter(taskId='') {
  pendingAIResult=null;pendingAIExpectedTask=taskId;
  setModal('Return an AI response', `<p class="muted">Paste a structured JSON response, or choose the “Save an AI answer as a note” task to import ordinary text or Markdown. The result is previewed before it changes your library.</p><form id="aiResultForm"> <label>Expected task (optional)<select id="expectedTaskId" name="expectedTaskId"><option value="">Auto-detect from result</option>${AI_TASKS.map(t=>`<option value="${escapeHTML(t.id)}" ${taskId===t.id?'selected':''}>${escapeHTML(t.title)}</option>`).join('')}</select></label><label>Response file<input id="aiResultFile" type="file" accept=".json,.txt,.md,.markdown,application/json,text/plain,text/markdown"></label><label>Paste AI response<textarea id="aiResultText" name="response" rows="10" placeholder='Paste JSON, plain text, or Markdown here.'></textarea></label><div id="aiResultErrors"></div><div class="form-actions"><button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Validate response ↗</button></div></form>`, 'AI TASK BRIDGE', true);
  $('#aiResultFile').addEventListener('change',async ev=>{const file=ev.target.files?.[0];if(file)$('#aiResultText').value=await file.text();});
}
function handleStructuredResponse(raw, expectedTaskId='') {
  const source = String(raw || '').trim();
  if (source.length > 2_000_000) { toast('This import is larger than 2 MB. Keep JSON imports focused; binary files belong in the file importer.', 'error'); return; }
  let rawObject = null;
  try { rawObject = JSON.parse(source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch {}
  if (rawObject?.format === 'neo-world.library-backup') {
    const errors = [];
    if (Number(rawObject.schemaVersion) !== 1) errors.push('Unsupported backup schema version. Expected version 1.');
    for (const key of ['resources','libraryIds','progress','collections','notes','topics','connections','paths']) {
      if (key === 'progress') { if (!rawObject[key] || typeof rawObject[key] !== 'object' || Array.isArray(rawObject[key])) errors.push('Backup progress must be an object.'); }
      else if (!Array.isArray(rawObject[key])) errors.push(`Backup ${key} must be an array.`);
    }
    if (Array.isArray(rawObject.resources) && rawObject.resources.length > 10000) errors.push('The backup contains too many resources.');
    if (Array.isArray(rawObject.notes) && rawObject.notes.length > 50000) errors.push('The backup contains too many notes.');
    const objectArray = (key, requiredFields) => {
      const value = rawObject[key];
      if (!Array.isArray(value)) return;
      value.forEach((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`Backup ${key}[${index}] must be an object.`); return; }
        requiredFields.forEach(field => { if (typeof item[field] !== 'string' || !item[field].trim()) errors.push(`Backup ${key}[${index}].${field} must be a non-empty string.`); });
      });
    };
    objectArray('resources', ['id','title','type']);
    objectArray('collections', ['id','name']);
    objectArray('notes', ['id','title']);
    objectArray('topics', ['id','name']);
    objectArray('connections', ['source','target']);
    objectArray('paths', ['id','title']);
    if (Array.isArray(rawObject.resources)) rawObject.resources.forEach((r,i)=>{
      if (!r || typeof r !== 'object') return;
      if (r.source !== undefined && (!r.source || typeof r.source !== 'object' || Array.isArray(r.source))) errors.push(`Backup resources[${i}].source must be an object when supplied.`);
      if (r.source?.url && !safeHttpUrl(r.source.url)) errors.push(`Backup resources[${i}] contains an unsupported URL scheme.`);
      if (r.tags !== undefined && !Array.isArray(r.tags)) errors.push(`Backup resources[${i}].tags must be an array when supplied.`);
      if (r.topicIds !== undefined && !Array.isArray(r.topicIds)) errors.push(`Backup resources[${i}].topicIds must be an array when supplied.`);
    });
    if (Array.isArray(rawObject.resources) && new Set(rawObject.resources.filter(r=>r&&typeof r.id==='string').map(r=>r.id)).size !== rawObject.resources.length) errors.push('Backup resources contain duplicate IDs.');
    if (Array.isArray(rawObject.libraryIds) && rawObject.libraryIds.some(id=>typeof id!=='string')) errors.push('Every libraryIds entry must be a string.');
    if (Array.isArray(rawObject.collections)) rawObject.collections.forEach((c,i)=>{ if (!c || typeof c!=='object' || Array.isArray(c)) return; if ((c.resourceIds!==undefined&&!Array.isArray(c.resourceIds))||(c.bookIds!==undefined&&!Array.isArray(c.bookIds))) errors.push(`Backup collections[${i}] resource IDs must be arrays.`); });
    if (Array.isArray(rawObject.notes)) rawObject.notes.forEach((n,i)=>{ if (!n || typeof n!=='object' || Array.isArray(n)) return; if (n.topicIds!==undefined&&!Array.isArray(n.topicIds)) errors.push(`Backup notes[${i}].topicIds must be an array.`); if (n.content!==undefined&&typeof n.content!=='string') errors.push(`Backup notes[${i}].content must be text.`); });
    if (Array.isArray(rawObject.paths)) rawObject.paths.forEach((p,i)=>{
      if (!p || typeof p!=='object' || Array.isArray(p)) return;
      if (!Array.isArray(p.steps) || p.steps.length > 100) { errors.push(`Backup paths[${i}].steps must be an array with at most 100 entries.`); return; }
      p.steps.forEach((step,j)=>{
        if (!step || typeof step !== 'object' || Array.isArray(step) || typeof step.title !== 'string' || !step.title.trim()) { errors.push(`Backup paths[${i}].steps[${j}] must be an object with a title.`); return; }
        if (step.resource && (typeof step.resource !== 'object' || Array.isArray(step.resource))) errors.push(`Backup paths[${i}].steps[${j}].resource must be an object.`);
        if (step.resource?.url && !safeHttpUrl(step.resource.url)) errors.push(`Backup paths[${i}].steps[${j}] contains an unsupported URL scheme.`);
      });
    });
    if (rawObject.progress && typeof rawObject.progress === 'object' && !Array.isArray(rawObject.progress) && Object.keys(rawObject.progress).length > 20000) errors.push('The backup contains too many progress records.');
    for (const key of ['flashcards','quizzes','schedules']) if (rawObject[key] !== undefined && !Array.isArray(rawObject[key])) errors.push(`Backup ${key} must be an array when supplied.`);
    if (errors.length) { handleInvalidImport(errors, source, expectedTaskId); return; }
    pendingAIResult = { ok: true, kind: 'library-backup', value: rawObject, raw: rawObject };
    showAIResultPreview(pendingAIResult); return;
  }
  const result=parseAIResponse(source,expectedTaskId);
  if(!result.ok){ handleInvalidImport(result.errors, source, expectedTaskId); return; }
  pendingAIResult=result;pendingAIExpectedTask=expectedTaskId;
  showAIResultPreview(result);
}

function handleInvalidImport(errors, raw, expectedTaskId='') {
  const fix=correctionPrompt(raw,errors,expectedTaskId);
  setModal('Response needs repair', `<div class="validation-errors"><strong>Neo World did not apply any changes.</strong><ul>${errors.map(e=>`<li>${escapeHTML(e)}</li>`).join('')}</ul></div><label>Copy this correction prompt to your AI<textarea id="correctionPromptText" rows="10" readonly>${escapeHTML(fix)}</textarea></label><div class="form-actions"><button class="button secondary" data-action="copy-correction">Copy correction prompt ⧉</button><button class="button primary" data-action="import-ai-result" data-task-id="${escapeHTML(expectedTaskId)}">Try another response</button></div>`, 'VALIDATION', true);
}

function showAIResultPreview(result) {
  const task = getTask(result.taskId || 'learning-path.create');
  let summary='';
  if(result.kind==='library-backup') {
    const backup=result.value;
    summary=`<div class="review-warning"><span>!</span><p><strong>This replaces the current library metadata.</strong> Review before applying. Binary files and file-system handles are not embedded in backups; local file references will be restored only when the matching browser copy still exists.</p></div><div class="preview-summary-grid"><div><small>RESOURCES</small><strong>${backup.resources.length}</strong></div><div><small>NOTES</small><strong>${backup.notes.length}</strong></div><div><small>LEARNING PATHS</small><strong>${backup.paths.length}</strong></div><div><small>TOPICS</small><strong>${backup.topics.length}</strong></div></div><p>Exported at ${escapeHTML(backup.exportedAt||'unknown date')}.</p>`;
  } else if(result.kind==='plain-note') {
    summary=`<div class="preview-summary-grid"><div><small>NOTE TITLE</small><strong>${escapeHTML(result.value.title)}</strong></div><div><small>CONTENT LENGTH</small><strong>${result.value.content.length.toLocaleString()} characters</strong></div></div><div class="plain-note-preview">${escapeHTML(result.value.content).replace(/\r?\n/g,'<br>')}</div><p class="muted">Plain text is preserved as text and will be saved as a new note after approval.</p>`;
  } else if(result.kind==='learning-path') {
    const path=result.value;const resources=path.steps.filter(s=>s.resource?.url).length;
    summary=`<div class="preview-summary-grid"><div><small>PATH</small><strong>${escapeHTML(path.title)}</strong></div><div><small>STEPS</small><strong>${path.steps.length}</strong></div><div><small>LINKED URLS</small><strong>${resources}</strong></div><div><small>ESTIMATED TIME</small><strong>${path.minutes||0} min</strong></div></div><p>${escapeHTML(path.description||'No description supplied.')}</p><div class="preview-list">${path.steps.map((s,i)=>`<div><span>${String(i+1).padStart(2,'0')}</span><div><strong>${escapeHTML(s.title)}</strong><small>${escapeHTML(s.detail||'')}${s.resource?.url?` · ${escapeHTML(s.resource.url)} (not verified)`:''}</small></div></div>`).join('')}</div>`;
  } else {
    const value=result.value;
    if(result.taskId==='resource.enrich') summary=`<div class="preview-summary-grid"><div><small>DESCRIPTION</small><strong>${escapeHTML(value.description)}</strong></div><div><small>CATEGORY</small><strong>${escapeHTML(value.category||'No change')}</strong></div></div><p><strong>Suggested tags:</strong> ${escapeHTML((value.tags||[]).join(', '))}</p><p><strong>Suggested topics:</strong> ${escapeHTML((value.topicSuggestions||[]).join(', '))}</p>`;
    else if(result.taskId==='resource.summarize') summary=`<h3>${escapeHTML(value.title||'Summary')}</h3><p>${escapeHTML(value.summary)}</p><ul>${(value.keyPoints||[]).map(p=>`<li>${escapeHTML(p)}</li>`).join('')}</ul><p class="muted">${escapeHTML(value.limitations||'Review the summary for accuracy before saving.')}</p>`;
    else if(result.taskId==='notes.flashcards') summary=`<p>${value.flashcards.length} flashcards proposed.</p><div class="preview-list">${value.flashcards.slice(0,8).map(c=>`<div><span>Q</span><div><strong>${escapeHTML(c.question)}</strong><small>${escapeHTML(c.answer)}</small></div></div>`).join('')}</div>`;
    else if(result.taskId==='notes.quiz') summary=`<h3>${escapeHTML(value.title)}</h3><p>${value.questions.length} questions proposed.</p><div class="preview-list">${value.questions.slice(0,6).map((q,i)=>`<div><span>${i+1}</span><div><strong>${escapeHTML(q.question)}</strong><small>Answer: ${escapeHTML(q.options[q.correctIndex]||'')}</small></div></div>`).join('')}</div>`;
    else if(result.taskId==='graph.connections') summary=`<p>${value.connections.length} candidate connections. Unknown topic names will be skipped instead of invented.</p><div class="preview-list">${value.connections.map(c=>`<div><span>◎</span><div><strong>${escapeHTML(c.sourceTopicName)} → ${escapeHTML(c.targetTopicName)}</strong><small>${escapeHTML(c.reason||'')}</small></div></div>`).join('')}</div>`;
    else if(result.taskId==='collection.create') summary=`<h3>${escapeHTML(value.name)}</h3><p>${escapeHTML(value.description||'')}</p><p>${(value.resourceIds||[]).length} resource IDs referenced; only existing resources will be included.</p>`;
    else if(result.taskId==='notes.consolidate') summary=`<h3>${escapeHTML(value.title)}</h3><p>${escapeHTML(value.synthesis)}</p><p><strong>Shared themes:</strong> ${escapeHTML((value.sharedThemes||[]).join(', '))}</p><p>Original notes will be preserved.</p>`;
    else if(result.taskId==='learning.schedule') summary=`<h3>${escapeHTML(value.title)}</h3><p>${escapeHTML(value.goal||'')}</p><div class="preview-list">${(value.sessions||[]).map(s=>`<div><span>◷</span><div><strong>${escapeHTML(s.dayLabel)} · ${escapeHTML(s.title)}</strong><small>${Number(s.estimatedMinutes)||0} min · ${escapeHTML((s.objectives||[]).join('; '))}</small></div></div>`).join('')}</div>`;
    else summary=`<pre class="json-preview">${escapeHTML(JSON.stringify(value,null,2))}</pre>`;
  }
  setModal('Review AI changes', `<div class="review-warning"><span>ⓘ</span><p><strong>Nothing has been changed yet.</strong> Review the proposal below. Imported AI output can still contain errors or unverified links.</p></div>${summary}<details class="raw-result-details"><summary>View raw structured result</summary><pre class="json-preview">${escapeHTML(JSON.stringify(result.raw,null,2))}</pre></details><div class="form-actions"><button class="button secondary" data-action="import-ai-result" data-task-id="${escapeHTML(result.taskId||'')}">Back / replace</button><button class="button primary" data-action="apply-ai-result">Approve and apply ↗</button></div>`, 'REVIEW BEFORE APPLYING', true);
}
async function applyAIResult() {
  if(!pendingAIResult){toast('There is no validated response to apply.','error');return;}
  const parsed=pendingAIResult;
  if(parsed.kind==='plain-note') {
    const value=parsed.value;
    state.notes.unshift({id:makeId('note'),title:value.title||'AI response note',content:value.content,resourceId:'',bookId:'',topicIds:[],createdAt:new Date().toISOString(),favorite:false,aiGenerated:true});
    const latestRun=(state.aiTaskHistory||[]).find(run=>run.taskId==='notes.capture'&&run.status==='prompt-ready');if(latestRun)latestRun.status='applied';
    addActivity('note','Saved an AI answer as a note');closeModal();persistSoon();navigate('notes');toast('AI answer saved as a new note.');return;
  }
  if(parsed.kind==='library-backup') {
    const backup=parsed.value;
    const previousById=new Map(state.resources.map(r=>[r.id,r]));
    const resources=backup.resources.map(rawResource=>{
      const resource={...rawResource,source:{...(rawResource.source||{})}};
      const previous=previousById.get(resource.id);
      // Binary bytes and permissioned file handles are not in JSON. Preserve a local reference only if this browser already owns it.
      if(previous?.source?.fileId) resource.source.fileId=previous.source.fileId;
      if(previous?.source?.handleId) resource.source.handleId=previous.source.handleId;
      if(!resource.source.fileId&&!resource.source.handleId&&!resource.source.url&&['file','missing-file','handle'].includes(resource.source.kind)) resource.source.kind='missing-file';
      return resource;
    });
    const ids=new Set(resources.map(r=>r.id));
    state={...state,schemaVersion:2,resources,libraryIds:[...new Set(backup.libraryIds.filter(id=>ids.has(id)))],progress:backup.progress||{},collections:(backup.collections||[]).map(c=>({...c,resourceIds:(c.resourceIds||c.bookIds||[]).filter(id=>ids.has(id))})),notes:backup.notes||[],topics:backup.topics||[],connections:backup.connections||[],paths:backup.paths||[],flashcards:backup.flashcards||[],quizzes:backup.quizzes||[],schedules:backup.schedules||[],garden:backup.garden||{activityCount:0,unlocked:[],activityLog:[]},recentResources:[],aiTaskHistory:state.aiTaskHistory||[],preferences:state.preferences||{}};
    closeModal();await persistNow();navigate('home');toast('Library backup restored. Local binary files are available only if this browser still has their saved copies.');return;
  }
  if(parsed.kind==='learning-path') {
    const path=parsed.value;
    path.steps.forEach(step=>{
      if(step.resourceId && findResource(step.resourceId)) return;
      if(step.resource?.url){
        const url=safeHttpUrl(step.resource.url); if(!url)return;
        let resource=state.resources.find(r=>r.source?.url===url);
        if(!resource){resource={id:makeId('resource'),type:step.resource.type||detectUrlType(url),title:step.resource.title||step.title,description:step.resource.description||'Suggested by an AI-generated learning path. Verify before relying on it.',category:path.category||'Learning',tags:[],topicIds:[],source:{kind:'url',url},createdAt:new Date().toISOString(),addedAt:new Date().toISOString(),aiSuggested:true};state.resources.push(resource);}
        step.resourceId=resource.id;
      }
    });
    state.paths.unshift(path);addActivity('path',`Imported learning path “${path.title}”`);selectedPathId=path.id;closeModal();persistSoon();navigate('paths');toast('Learning path imported. Review external links before using them.');return;
  }
  const result=parsed.value, taskId=parsed.taskId;
  const latestRun=(state.aiTaskHistory||[]).find(run=>run.taskId===taskId && run.status==='prompt-ready');
  if(taskId==='resource.enrich') {
    const target=findResource(latestRun?.resourceIds?.[0]);
    if(!target){toast('This task needs a selected resource. Prepare the prompt from a resource context and retry.','error');return;}
    target.description=result.description; if(result.category)target.category=result.category;target.tags=[...new Set([...(target.tags||[]),...(result.tags||[]).map(String)])].slice(0,40);
    for(const name of result.topicSuggestions||[]){const t=state.topics.find(t=>t.name.toLowerCase()===String(name).toLowerCase());if(t&&!target.topicIds.includes(t.id))target.topicIds.push(t.id);}
  } else if(taskId==='resource.summarize') {
    const note={id:makeId('note'),title:result.title||`Summary: ${findResource(latestRun?.resourceIds?.[0])?.title||'Resource'}`,content:`${result.summary}\n\nKey points:\n${(result.keyPoints||[]).map(x=>`• ${x}`).join('\n')}\n\nQuestions to explore:\n${(result.questions||[]).map(x=>`• ${x}`).join('\n')}\n\nLimitations: ${result.limitations||'Review this AI-generated summary against the original material.'}`,resourceId:latestRun?.resourceIds?.[0]||'',bookId:latestRun?.resourceIds?.[0]||'',topicIds:[],createdAt:new Date().toISOString(),favorite:false,aiGenerated:true};state.notes.unshift(note);
  } else if(taskId==='notes.flashcards') {
    state.flashcards ||= []; state.flashcards.unshift({id:makeId('flashcard-set'),title:'AI-generated flashcards',cards:result.flashcards,createdAt:new Date().toISOString(),sourceNoteIds:latestRun?.noteIds||[]});
  } else if(taskId==='notes.quiz') {
    state.quizzes ||= []; state.quizzes.unshift({id:makeId('quiz'),title:result.title,questions:result.questions,createdAt:new Date().toISOString(),sourceNoteIds:latestRun?.noteIds||[]});
  } else if(taskId==='graph.connections') {
    let added=0;for(const c of result.connections||[]){const a=state.topics.find(t=>t.name.toLowerCase()===c.sourceTopicName.toLowerCase()),b=state.topics.find(t=>t.name.toLowerCase()===c.targetTopicName.toLowerCase());if(!a||!b||a.id===b.id)continue;const exists=state.connections.some(x=>(x.source===a.id&&x.target===b.id)||(x.source===b.id&&x.target===a.id));if(!exists){state.connections.push({source:a.id,target:b.id,relationshipType:c.relationshipType||'related',reason:c.reason||''});added++;}}
    if(!added)toast('No new valid connections matched existing topics. You can add missing topics first.','error');
    else addActivity('connection',`Added ${added} knowledge connection${added===1?'':'s'}`);
  } else if(taskId==='collection.create') {
    const ids=(result.resourceIds||[]).filter(id=>findResource(id));state.collections.unshift({id:makeId('collection'),name:result.name,description:result.description||'',resourceIds:ids,bookIds:ids,createdAt:new Date().toISOString(),aiGenerated:true});
  } else if(taskId==='notes.consolidate') {
    state.notes.unshift({id:makeId('note'),title:result.title,content:`${result.synthesis}\n\nShared themes:\n${(result.sharedThemes||[]).map(x=>`• ${x}`).join('\n')}\n\nOpen questions:\n${(result.openQuestions||[]).map(x=>`• ${x}`).join('\n')}\n\nSource note IDs: ${(result.sourceNoteIds||[]).join(', ')}. Original notes were preserved.`,topicIds:[],createdAt:new Date().toISOString(),favorite:false,aiGenerated:true});
  } else if(taskId==='learning.schedule') {
    state.schedules ||= [];state.schedules.unshift({id:makeId('schedule'),title:result.title,goal:result.goal||'',sessions:result.sessions||[],createdAt:new Date().toISOString()});
  }
  if(latestRun)latestRun.status='applied';
  addActivity('resource',`Applied AI task: ${getTask(taskId)?.title||taskId}`);closeModal();persistSoon();render();toast('Reviewed changes applied to Neo World.');
}

function handleJSONImportText(text) {
  if(!text.trim()){toast('Choose a JSON file or paste JSON first.','error');return;}
  closeModal();handleStructuredResponse(text);
}
function showResourceMenu(id) {
  const resource=findResource(id);if(!resource)return;
  const p=getProgress(id);let cacheLine='';
  getCachedResource(id).then(cache=>{if(cache){cacheLine=`<div class="storage-note">Temporary cache: ${escapeHTML(cacheRemainingLabel(cache))} · ${(cache.size/1024/1024).toFixed(1)} MB</div>`;const el=$('#resourceCacheStatus');if(el)el.innerHTML=cacheLine;}}).catch(()=>{});
  setModal('Resource options', `<div class="resource-menu-summary">${resourceTypeChip(resource)}<h3>${escapeHTML(resource.title)}</h3><p>${escapeHTML(resource.description||'')}</p><small>${escapeHTML(progressSummary(resource))}</small></div><div class="resource-option-list"><button data-action="edit-resource" data-id="${escapeHTML(id)}">✎ <span><strong>Edit metadata</strong><small>Title, category, tags, description</small></span><b>↗</b></button><button data-action="new-note" data-resource-id="${escapeHTML(id)}">＋ <span><strong>Capture an idea</strong><small>Attach a note to this resource</small></span><b>↗</b></button><button data-action="prepare-task" data-id="resource.enrich" data-resource-id="${escapeHTML(id)}">✦ <span><strong>Enrich metadata with AI</strong><small>Prepare a prompt using this resource's metadata</small></span><b>↗</b></button><button data-action="prepare-task" data-id="resource.summarize" data-resource-id="${escapeHTML(id)}">≋ <span><strong>Create a summary with AI</strong><small>Include notes or content you supply</small></span><b>↗</b></button>${resource.source?.url && ['pdf','epub','image','audio','video'].includes(resource.type)?`<button data-action="cache-resource" data-id="${escapeHTML(id)}">↓ <span><strong>Cache a copy for 24 hours</strong><small>Available for downloadable files when the source permits it</small></span><b>↗</b></button><button data-action="save-local-copy" data-id="${escapeHTML(id)}">⇩ <span><strong>Save local copy to device</strong><small>Downloads the permitted file and asks where to save it when supported</small></span><b>↗</b></button>`:''}<button data-action="export-resource-metadata" data-id="${escapeHTML(id)}">⇩ <span><strong>Export metadata JSON</strong><small>Does not include the binary file</small></span><b>↗</b></button><button class="danger-option" data-action="remove-resource" data-id="${escapeHTML(id)}">× <span><strong>Remove resource</strong><small>Imported file blobs are retained unless explicitly cleared in Storage Manager</small></span><b>↗</b></button></div><div id="resourceCacheStatus">${cacheLine}</div><div class="form-actions"><button class="button secondary" data-action="close-modal">Close</button><button class="button primary" data-action="open-resource" data-id="${escapeHTML(id)}">Open resource ↗</button></div>`, 'RESOURCE ACTIONS');
}
function editResource(id) {
  const resource=findResource(id);if(!resource)return;
  setModal('Edit resource metadata', `<form id="editResourceForm"><input type="hidden" name="id" value="${escapeHTML(id)}"><label>Title<input name="title" required value="${escapeHTML(resource.title)}"></label><div class="form-grid"><label>Category<input name="category" value="${escapeHTML(resource.category||'')}"></label><label>Author / creator<input name="author" value="${escapeHTML(resource.author||'')}"></label></div><label>Description<textarea name="description" rows="3">${escapeHTML(resource.description||'')}</textarea></label><label>Tags, comma separated<input name="tags" value="${escapeHTML((resource.tags||[]).join(', '))}"></label><div class="form-actions"><button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Save metadata</button></div></form>`, 'RESOURCE LIBRARY');
}

async function cacheResource(id) {
  const resource=findResource(id);if(!resource)return;
  if(!resource.source?.url){toast('Only URL-based resources can be cached this way.','error');return;}
  try { toast('Trying to download a temporary copy…');await cacheRemoteResource(resource);toast('Cached for 24 hours. The browser may still evict storage under pressure.');persistSoon();if(route==='reader')render(); }
  catch(error){toast(`Could not cache this resource: ${error.message}`,'error');}
}
async function saveRemoteCopyToDevice(id) {
  const resource = findResource(id);
  if (!resource?.source?.url) { toast('This resource has no remote URL to download.', 'error'); return; }
  const url = resource.source.url;
  const suggestedName = resource.source.fileName || `${resource.title.replace(/[^a-z0-9._ -]/gi, '').trim() || 'neo-resource'}${extensionForResource(resource)}`;
  let saveHandle = null;
  try {
    // Open the save picker before awaiting network work, while the click activation is fresh.
    if (typeof window.showSaveFilePicker === 'function') {
      saveHandle = await window.showSaveFilePicker({ suggestedName });
    }
    const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('The server returned an empty file.');
    if (saveHandle) {
      const writable = await saveHandle.createWritable();
      await writable.write(blob); await writable.close();
      const handleId = await storeFileHandle(saveHandle, { name: saveHandle.name });
      resource.source.handleId = handleId;
      resource.source.kind = 'handle';
      resource.source.fileName = saveHandle.name;
      resource.source.size = blob.size;
      resource.mimeType = blob.type || resource.mimeType;
      persistSoon();
      toast('Local copy saved. Neo World can request permission to reopen it later.');
    } else {
      const objectUrl = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = objectUrl; a.download = suggestedName; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
      toast('Download started. Import the saved file if you want Neo World to keep a browser copy.');
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    toast(`Could not download this source: ${error.message} The server may block cross-origin downloads; try opening it directly.`, 'error');
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
function extensionForResource(resource) {
  const known = { pdf:'.pdf', epub:'.epub', image:'.img', audio:'.audio', video:'.video' };
  try { const ext = new URL(resource.source.url).pathname.match(/\.[a-z0-9]{2,5}$/i)?.[0]; if (ext) return ext; } catch {}
  return known[resource.type] || '.bin';
}

async function openStorageManager() {
  const [files, handles, caches] = await Promise.all([
    dbGetAll('files').catch(() => []), dbGetAll('handles').catch(() => []), dbGetAll('cache').catch(() => [])
  ]);
  const fileOwner = new Map(state.resources.filter(r=>r.source?.fileId).map(r=>[r.source.fileId,r]));
  const handleOwner = new Map(state.resources.filter(r=>r.source?.handleId).map(r=>[r.source.handleId,r]));
  const cacheOwner = new Map(state.resources.map(r=>[r.id,r]));
  const used = files.reduce((n,f)=>n+(f.size||0),0) + caches.reduce((n,c)=>n+(c.size||0),0);
  const fileRows = files.map(file=>{const resource=fileOwner.get(file.id);return `<div><span class="resource-mini-icon">▧</span><span><strong>${escapeHTML(resource?.title||file.name||'Unlinked file copy')}</strong><small>${((file.size||0)/1024/1024).toFixed(2)} MB · ${escapeHTML(file.name||'unknown filename')}${resource?'':' · Unlinked from library'}</small></span><button class="button danger-ghost small" data-action="delete-file-record" data-id="${escapeHTML(file.id)}">Delete copy</button></div>`;}).join('');
  const handleRows = handles.map(record=>{const resource=handleOwner.get(record.id);return `<div><span class="resource-mini-icon">⌁</span><span><strong>${escapeHTML(resource?.title||record.name||'Original file handle')}</strong><small>Original file permission handle${resource?'':' · Not linked to a resource'}</small></span><button class="button danger-ghost small" data-action="delete-handle-record" data-id="${escapeHTML(record.id)}">Forget handle</button></div>`;}).join('');
  const cacheRows = caches.map(record=>{const resource=cacheOwner.get(record.resourceId);return `<div><span class="resource-mini-icon">◷</span><span><strong>${escapeHTML(resource?.title||'Unlinked cached file')}</strong><small>${((record.size||0)/1024/1024).toFixed(2)} MB · ${escapeHTML(cacheRemainingLabel(record)||'Expired')}${resource?'':' · Unlinked from library'}</small></span><button class="button danger-ghost small" data-action="delete-cache-record" data-id="${escapeHTML(record.resourceId)}">Delete cache</button></div>`;}).join('');
  setModal('Storage manager', `<div class="storage-overview"><div><small>FILE COPIES</small><strong>${files.length}</strong></div><div><small>KNOWN STORAGE</small><strong>${(used/1024/1024).toFixed(1)} MB</strong></div><div><small>TEMP CACHE</small><strong>${caches.length}</strong></div></div><p class="muted">The manager lists unlinked files and expired cache records too, so removing a library entry does not leave hidden browser storage behind. Device handles store permissions, not file contents.</p><h3>Imported copies</h3><div class="storage-file-list">${fileRows||'<p class="muted">No imported file copies found in IndexedDB.</p>'}</div><h3>Original file handles</h3><div class="storage-file-list">${handleRows||'<p class="muted">No saved file handles.</p>'}</div><h3>Temporary cache</h3><div class="storage-file-list">${cacheRows||'<p class="muted">No cached file copies.</p>'}</div><div class="form-actions"><button class="button secondary" data-action="clear-expired-cache">Clean expired cache records</button><button class="button secondary" data-action="clear-all-cache">Clear temporary cache</button><button class="button primary" data-action="close-modal">Done</button></div>`, 'LOCAL STORAGE', true);
}
async function cleanExpiredCache() {
  const records=await dbGetAll('cache').catch(()=>[]);let removed=0;
  for(const record of records){if(Date.now()>=record.expiresAt){await dbDelete('cache',record.resourceId).catch(()=>{});removed++;}}
  toast(`Removed ${removed} expired cache record${removed===1?'':'s'}.`);openStorageManager();
}
async function clearAllCache() { const records=await dbGetAll('cache').catch(()=>[]);for(const record of records)await clearResourceCache(record.resourceId).catch(()=>{});toast('Temporary cache cleared.');openStorageManager(); }
async function deleteFileRecord(fileId) {
  const record=await dbGet('files',fileId).catch(()=>null);if(!record)return;
  await deleteStoredFile(fileId);
  for(const resource of state.resources){if(resource.source?.fileId===fileId){resource.source.fileId=null;resource.source.kind=resource.source.handleId?'handle':'missing-file';}}
  persistSoon();toast('Stored file copy deleted. Resource metadata remains.');openStorageManager();
}
async function deleteHandleRecord(handleId) {
  await deleteStoredFileHandle(handleId).catch(()=>{});
  for(const resource of state.resources){if(resource.source?.handleId===handleId){resource.source.handleId=null;resource.source.kind=resource.source.fileId?'file':'missing-file';}}
  persistSoon();toast('Saved original-file handle forgotten.');openStorageManager();
}
async function deleteCacheRecord(resourceId) { await clearResourceCache(resourceId).catch(()=>{});toast('Temporary cache record deleted.');openStorageManager(); }
async function deleteFileBlobForResource(id) {
  const resource=findResource(id);if(!resource?.source?.fileId)return;
  await deleteStoredFile(resource.source.fileId).catch(error=>toast(error.message,'error'));
  resource.source.fileId=null;resource.source.kind='missing-file';resource.description=`${resource.description||''} [Local file copy was deleted from Storage Manager.]`.trim();persistSoon();toast('File copy deleted. The resource metadata remains.');openStorageManager();
}
function exportJSON(filename, value) {
  const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function exportLibraryBackup() {
  const resources = state.resources.map(raw => { const resource={...raw,source:{...(raw.source||{})}}; if(resource.source.fileId||resource.source.handleId){delete resource.source.fileId;delete resource.source.handleId;resource.source.kind='missing-file';resource.missingFileInBackup=true;} return resource; });
  const backup={format:'neo-world.library-backup',schemaVersion:1,exportedAt:new Date().toISOString(),resources,libraryIds:state.libraryIds,progress:state.progress,collections:state.collections,notes:state.notes,topics:state.topics,connections:state.connections,paths:state.paths,flashcards:state.flashcards||[],quizzes:state.quizzes||[],schedules:state.schedules||[],garden:state.garden,warning:'Binary file contents and file-system handles are not embedded. Exported metadata may contain resource URLs and note text.'};
  exportJSON(`neo-world-backup-${new Date().toISOString().slice(0,10)}.json`,backup);toast('Library backup exported. Binary files are not included.');
}
function exportResourceMetadata(id) { const r=findResource(id);if(r)exportJSON(`neo-resource-${r.id}.json`,{format:'neo-world.resource',schemaVersion:1,resource:r,progress:getProgress(id)}); }
function exportPath(id) { const path=findPath(id);if(!path)return;exportJSON(`${path.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'learning-path'}.json`,exportLearningPath(path));toast('Learning path JSON exported.'); }
function copyPathFormatPrompt() {
  const text=`Create a learning path for Neo World and return only one valid JSON object. Use format "${PATH_FORMAT}" and schemaVersion 1. Required shape: {"format":"neo-world.learning-path","schemaVersion":1,"path":{"title":"...","description":"...","difficulty":"beginner|intermediate|advanced","estimatedMinutes":60,"tags":[],"learningObjectives":[],"steps":[{"id":"step-01","title":"...","description":"...","estimatedMinutes":15,"resource":{"type":"website|youtube|pdf|epub|image|audio|video|text|book","title":"...","url":"https://..."},"completionRule":"manual|engagement|visited|pages"}]}}. Make progressive, practical steps. Use only URLs you know are real; never claim they were verified if you could not verify them. Keep resource metadata separate from source text. Do not include Markdown fences or prose outside the JSON.`;
  copyText(text,'Learning path format prompt copied.');
}
async function copyText(text, success='Copied to clipboard.') {
  try { await navigator.clipboard.writeText(text); toast(success); }
  catch { const textarea=document.createElement('textarea');textarea.value=text;textarea.style.position='fixed';textarea.style.opacity='0';document.body.append(textarea);textarea.select();const ok=document.execCommand('copy');textarea.remove();toast(ok?success:'Clipboard permission was denied. Select and copy the text manually.',ok?'success':'error'); }
}

function resetDemoModal() {
  setModal('Reset demo content?', `<p class="confirm-copy">This restores the original demo books, topics, sample notes, paths, and demo progress. Your imported resources, custom notes, custom paths, and file blobs will be kept.</p><div class="form-actions"><button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" data-action="confirm-reset-demo">Reset demo content</button></div>`, 'SAFE RESET');
}
async function resetDemoPreservingUserData() {
  const { initialState, seedBooks } = await import('./data.js');
  const base = await resetAppState();
  const baseResourceIds=new Set(base.resources.map(r=>r.id));
  const customResources=state.resources.filter(r=>!baseResourceIds.has(r.id));
  const seedNoteIds=new Set(base.notes.map(n=>n.id));const customNotes=state.notes.filter(n=>!seedNoteIds.has(n.id));
  const seedPathIds=new Set(base.paths.map(p=>p.id));const customPaths=state.paths.filter(p=>!seedPathIds.has(p.id));
  const seedCollectionIds=new Set(base.collections.map(c=>c.id));const customCollections=state.collections.filter(c=>!seedCollectionIds.has(c.id));
  const customResourceIds=new Set(customResources.map(r=>r.id));
  state={...base,resources:[...base.resources,...customResources],libraryIds:[...new Set([...base.libraryIds,...state.libraryIds.filter(id=>customResourceIds.has(id))])],notes:[...base.notes,...customNotes],paths:[...base.paths,...customPaths],collections:[...base.collections,...customCollections],progress:{...base.progress,...Object.fromEntries(Object.entries(state.progress||{}).filter(([id])=>customResourceIds.has(id)))},topics:[...base.topics,...state.topics.filter(t=>!base.topics.some(x=>x.id===t.id))],connections:[...base.connections,...state.connections.filter(c=>!base.connections.some(x=>x.source===c.source&&x.target===c.target))],garden:state.garden};
  closeModal();persistSoon();navigate('home');toast('Demo content reset. Your imported resources and notes were kept.');
}
function profileMenu() {
  setModal('Your personal space', `<div class="profile-summary"><span class="avatar-large">P</span><div><strong>Curious learner</strong><small>Personal knowledge universe</small></div></div><div class="storage-overview"><div><small>RESOURCES</small><strong>${state.resources.length}</strong></div><div><small>LIBRARY</small><strong>${state.libraryIds.length}</strong></div><div><small>NOTES</small><strong>${state.notes.length}</strong></div></div><div class="profile-settings-list"><div><span>Storage mode</span><strong>IndexedDB + browser fallback</strong></div><div><span>AI connection</span><strong>External, copy-and-paste</strong></div><div><span>Cache lifetime</span><strong>24 hours for requested file cache</strong></div><div><span>App version</span><strong>0.3 · Resource-first prototype</strong></div></div><div class="form-actions"><button class="button secondary" data-action="storage-manager">Manage storage</button><button class="button primary" data-action="close-modal">Done</button></div>`, 'LOCAL APP');
}

function runLocalSearch(query) {
  globalQuery=query.trim();libraryFilter='All';navigate('discover',{keepQuery:true});
  const type=$('#discoverType'); if(type)type.value='All';filterDiscoverGrid();
}
function filterDiscoverGrid() {
  const grid=$('#discoverGrid');if(!grid)return;
  const q=($('#catalogSearch')?.value||globalQuery).toLowerCase(),type=$('#discoverType')?.value||'All',category=$('#discoverCategory')?.value||'All';
  const resources=state.resources.filter(r=>(q||!state.libraryIds.includes(r.id))&&matchesResource(r,q)&&(type==='All'||r.type===type)&&(category==='All'||r.category===category));
  grid.innerHTML=resources.length?resources.map(r=>resourceCard(r)).join(''):emptyState('⌕','No matching resources','Try a different search or add your own resource.','<button class="button primary" data-action="add-resource">＋ Add resource</button>');
}
function filterNotesGrid() { const oldScroll=window.scrollY;render();window.scrollTo(0,oldScroll);$('#notesSearch')?.focus(); }

// Clicks are delegated so dynamically rendered screens share one interaction layer.
document.addEventListener('click', async event => {
  const routeEl=event.target.closest('[data-route]');
  if(routeEl){event.preventDefault();navigate(routeEl.dataset.route);return;}
  const actionEl=event.target.closest('[data-action]');if(!actionEl)return;
  const action=actionEl.dataset.action,id=actionEl.dataset.id;
  switch(action){
    case 'add-resource':openAddResourceModal();break;
    case 'close-modal':closeModal();break;
    case 'back-to-previous':navigate('library');break;
    case 'toggle-menu':$('.app-shell').classList.toggle('menu-open');break;
    case 'toggle-library':toggleLibrary(id);break;
    case 'open-resource':closeModal();openResource(id);break;
    case 'resource-menu':showResourceMenu(id);break;
    case 'edit-resource':closeModal();editResource(id);break;
    case 'remove-resource':{const r=findResource(id);if(!r)break;setModal('Remove this resource?',`<p>This removes <strong>${escapeHTML(r.title)}</strong> from Neo World metadata and the library. Its stored file blob is not deleted. You can remove that separately in Storage Manager.</p><div class="form-actions"><button class="button secondary" data-action="close-modal">Cancel</button><button class="button danger-ghost" data-action="confirm-remove-resource" data-id="${escapeHTML(id)}">Remove resource</button></div>`,'CONFIRM');break;}
    case 'confirm-remove-resource':{const r=findResource(id);await clearResourceCache(id).catch(()=>{});state.resources=state.resources.filter(x=>x.id!==id);state.libraryIds=state.libraryIds.filter(x=>x!==id);delete state.progress[id];state.collections.forEach(c=>{c.resourceIds=(c.resourceIds||c.bookIds||[]).filter(x=>x!==id);c.bookIds=c.resourceIds;});if(selectedResourceId===id)selectedResourceId=null;persistSoon();closeModal();render();toast('Resource removed. Stored file blobs were retained.');break;}
    case 'new-note':closeModal();openNoteEditor('',actionEl.dataset.resourceId||'',actionEl.dataset.topicId||'');break;
    case 'edit-note':closeModal();openNoteEditor(id);break;
    case 'delete-note':{const note=state.notes.find(n=>n.id===id);if(!note)break;setModal('Delete note?',`<p>Delete <strong>${escapeHTML(note.title)}</strong>? This does not delete the linked resource.</p><div class="form-actions"><button class="button secondary" data-action="close-modal">Keep note</button><button class="button danger-ghost" data-action="confirm-delete-note" data-id="${escapeHTML(id)}">Delete note</button></div>`,'YOUR NOTEBOOK');break;}
    case 'confirm-delete-note':state.notes=state.notes.filter(n=>n.id!==id);persistSoon();closeModal();render();toast('Note deleted.');break;
    case 'toggle-note-favorite':{const n=state.notes.find(n=>n.id===id);if(n){n.favorite=!n.favorite;persistSoon();render();}break;}
    case 'select-topic':selectedTopicId=id;navigate('graph');break;
    case 'new-topic':closeModal();openNewTopicModal();break;
    case 'new-connection':openNewConnectionModal();break;
    case 'open-path':selectedPathId=id;navigate('paths');break;
    case 'back-paths':selectedPathId=null;navigate('paths');break;
    case 'toggle-path-step':{const path=findPath(actionEl.dataset.pathId),step=path?.steps.find(s=>s.id===actionEl.dataset.stepId);if(!step)break;step.done=!step.done;if(step.done)addActivity('path',`Completed “${step.title}”`);persistSoon();render();break;}
    case 'delete-path':{const path=findPath(id);if(!path)break;setModal('Delete learning path?',`<p>Delete <strong>${escapeHTML(path.title)}</strong>? This removes the path metadata and its completion state from this library. Linked resources and notes will remain.</p><div class="form-actions"><button class="button secondary" data-action="close-modal">Keep path</button><button class="button danger-ghost" data-action="confirm-delete-path" data-id="${escapeHTML(id)}">Delete path</button></div>`,'CONFIRM');break;}
    case 'confirm-delete-path':state.paths=state.paths.filter(p=>p.id!==id);selectedPathId=null;persistSoon();closeModal();navigate('paths');toast('Learning path deleted. Linked resources were kept.');break;
    case 'filter-library':libraryFilter=actionEl.dataset.filter;render();break;
    case 'clear-collection-filter':libraryFilter='All';render();break;
    case 'new-collection':openCollectionEditor();break;
    case 'edit-collection':openCollectionEditor(id);break;
    case 'open-study-set':openStudySet(actionEl.dataset.kind,id);break;
    case 'prepare-task':closeModal();prepareTask(id,{resourceId:actionEl.dataset.resourceId||''});break;
    case 'import-ai-result':openAIResultImporter(actionEl.dataset.taskId||'');break;
    case 'apply-ai-result':await applyAIResult();break;
    case 'copy-prompt':{const run=state.aiTaskHistory.find(r=>r.id===id);if(run)copyText(run.prompt);break;}
    case 'copy-correction':copyText($('#correctionPromptText')?.value||'Correction prompt missing.');break;
    case 'view-task-prompt':{const run=state.aiTaskHistory.find(r=>r.id===id);if(run)showPreparedPrompt(run);break;}
    case 'import-json':closeModal();openAddResourceModal();switchImportTab('json');break;
    case 'import-tab':switchImportTab(actionEl.dataset.tab);break;
    case 'import-original-file':await importOriginalFile();break;
    case 'relink-original-file':await relinkOriginalFile(id);break;
    case 'export-path':exportPath(id);break;
    case 'copy-path-prompt':copyPathFormatPrompt();break;
    case 'new-path':createManualPath();break;
    case 'export-library':exportLibraryBackup();break;
    case 'export-resource-metadata':exportResourceMetadata(id);break;
    case 'cache-resource':await cacheResource(id);break;
    case 'save-local-copy':await saveRemoteCopyToDevice(id);break;
    case 'storage-manager':closeModal();await openStorageManager();break;
    case 'clear-expired-cache':await cleanExpiredCache();break;
    case 'clear-all-cache':await clearAllCache();break;
    case 'delete-file-blob':await deleteFileBlobForResource(id);break;
    case 'delete-file-record':await deleteFileRecord(id);break;
    case 'delete-handle-record':await deleteHandleRecord(id);break;
    case 'delete-cache-record':await deleteCacheRecord(id);break;
    case 'reset-demo':resetDemoModal();break;
    case 'confirm-reset-demo':await resetDemoPreservingUserData();break;
    case 'profile-menu':profileMenu();break;
    case 'garden-guide':setModal('How your garden grows',`<div class="guide-content"><div class="guide-illustration">❋</div><p>Opening resources, capturing ideas, completing steps, and connecting topics add activity to your garden. Progress is a friendly visual reminder, not a measure of intelligence.</p><p>Your imported files and notes remain your own. Resetting demo content keeps your custom resources, notes, paths, and file blobs.</p><div class="form-actions"><button class="button primary" data-action="close-modal">Got it</button></div></div>`,'KNOWLEDGE GARDEN');break;
  }
});

document.addEventListener('submit', async event => {
  const form=event.target;
  if(form.id==='searchForm'){event.preventDefault();runLocalSearch($('#globalSearch').value);return;}
  if(form.id==='importFileForm'){event.preventDefault();await importSelectedFile(form);return;}
  if(form.id==='importUrlForm'){event.preventDefault();createResourceFromUrl(new FormData(form));return;}
  if(form.id==='manualResourceForm'){event.preventDefault();createManualResource(form);return;}
  if(form.id==='importJSONForm'){event.preventDefault();let text=$('#jsonImportText').value;if(!text.trim()&&$('#jsonImportFile').files[0])text=await $('#jsonImportFile').files[0].text();handleJSONImportText(text);return;}
  if(form.id==='noteForm'){event.preventDefault();saveNote(form);return;}
  if(form.id==='prepareTaskForm'){event.preventDefault();generateTaskPrompt(form);return;}
  if(form.id==='aiResultForm'){event.preventDefault();const expected=$('#expectedTaskId').value;handleStructuredResponse($('#aiResultText').value,expected);return;}
  if(form.id==='collectionForm'){event.preventDefault();saveCollection(form);return;}
  if(form.id==='quizAnswerForm'){
    event.preventDefault();const quiz=(state.quizzes||[]).find(q=>q.id===form.dataset.quizId);if(!quiz)return;
    const questions=quiz.questions||[];let score=0;const feedback=questions.map((q,i)=>{const selected=Number(new FormData(form).get(`q${i}`));const correct=selected===Number(q.correctIndex);if(correct)score++;return `<div class="quiz-feedback ${correct?'correct':'incorrect'}"><strong>${correct?'Correct':'Review this one'} · ${escapeHTML(q.question)}</strong><p>${escapeHTML(q.explanation||`Answer: ${q.options?.[q.correctIndex]||'Not supplied'}`)}</p></div>`;}).join('');
    $('#quizResults',form).innerHTML=`<section class="quiz-score"><strong>${score} / ${questions.length}</strong><span>${questions.length?Math.round(score/questions.length*100):0}%</span></section>${feedback}`;
    addActivity('study','Completed a practice quiz');toast(`Quiz checked: ${score}/${questions.length}.`);return;
  }
  if(form.id==='topicForm'){event.preventDefault();const f=new FormData(form),name=String(f.get('name')||'').trim();if(!name)return;if(state.topics.some(t=>t.name.toLowerCase()===name.toLowerCase())){toast('A topic with that name already exists.','error');return;}const topic={id:makeId('topic'),name,description:String(f.get('description')||'').trim(),x:Math.round(12+Math.random()*75),y:Math.round(15+Math.random()*70),tone:'violet'};state.topics.push(topic);selectedTopicId=topic.id;persistSoon();closeModal();navigate('graph');toast('Topic created.');return;}
  if(form.id==='connectionForm'){event.preventDefault();const f=new FormData(form),source=String(f.get('source')),target=String(f.get('target'));if(source===target){toast('Choose two different topics.','error');return;}if(state.connections.some(c=>(c.source===source&&c.target===target)||(c.source===target&&c.target===source))){toast('Those topics are already connected.','error');return;}state.connections.push({source,target,relationshipType:'related',reason:String(f.get('reason')||'')});addActivity('connection','Connected two topics');closeModal();render();toast('Topics connected.');return;}
  if(form.id==='newPathForm'){event.preventDefault();const f=new FormData(form),steps=String(f.get('steps')||'').split('\n').map(x=>x.trim()).filter(Boolean);if(!steps.length){toast('Add at least one step.','error');return;}const path={id:makeId('path'),title:String(f.get('title')).trim(),subtitle:String(f.get('description')||'').trim(),description:String(f.get('description')||'').trim(),category:'Learning',difficulty:String(f.get('difficulty')||'beginner'),tags:String(f.get('tags')||'').split(',').map(x=>x.trim()).filter(Boolean),icon:'↗',tone:'violet',minutes:0,steps:steps.map((title,i)=>({id:`step-${i+1}`,title,detail:'',estimatedMinutes:0,done:false,completionRule:'manual'})),createdAt:new Date().toISOString()};state.paths.unshift(path);selectedPathId=path.id;addActivity('path',`Created learning path “${path.title}”`);closeModal();navigate('paths');return;}
  if(form.id==='editResourceForm'){event.preventDefault();const f=new FormData(form),r=findResource(String(f.get('id')));if(!r)return;r.title=String(f.get('title')||'').trim();r.category=String(f.get('category')||'Uncategorized').trim();r.author=String(f.get('author')||'').trim();r.description=String(f.get('description')||'').trim();r.tags=String(f.get('tags')||'').split(',').map(x=>x.trim()).filter(Boolean);r.updatedAt=new Date().toISOString();persistSoon();closeModal();render();toast('Resource metadata updated.');return;}
});

document.addEventListener('input',event=>{
  if(event.target.id==='catalogSearch'){globalQuery=event.target.value;filterDiscoverGrid();}
  if(event.target.id==='notesSearch'){globalQuery=event.target.value;const pos=event.target.selectionStart;render();const el=$('#notesSearch');if(el){el.focus();el.setSelectionRange(pos,pos);}}
});
document.addEventListener('change',event=>{
  if(event.target.id==='discoverType'||event.target.id==='discoverCategory')filterDiscoverGrid();
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){if(!modalBackdrop().hidden)closeModal();$('.app-shell').classList.remove('menu-open');}
  if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&modalBackdrop().hidden){event.preventDefault();$('#globalSearch').focus();}
  if(event.key==='Enter'&&event.target.id==='globalSearch'&&event.ctrlKey){event.preventDefault();runLocalSearch($('#globalSearch').value);}
});
document.addEventListener('neo:new-note-for-resource', event => openNoteEditor('',event.detail?.resourceId||''));

async function init() {
  try { state=await loadAppState(); }
  catch(error) { console.error(error); state={schemaVersion:2,resources:[],libraryIds:[],progress:{},notes:[],topics:[],connections:[],paths:[],collections:[],garden:{activityCount:0,unlocked:[],activityLog:[]},aiTaskHistory:[],flashcards:[],quizzes:[],schedules:[],recentResources:[]};toast('Started a temporary session because browser storage could not be opened.','error'); }
  state.resources ||= [];state.libraryIds ||= [];state.progress ||= {};state.notes ||= [];state.topics ||= [];state.connections ||= [];state.paths ||= [];state.collections ||= [];state.garden ||= {activityCount:0,unlocked:[],activityLog:[]};state.aiTaskHistory ||= [];state.flashcards ||= [];state.quizzes ||= [];state.schedules ||= [];state.recentResources ||= [];
  // Clean expired file-cache entries on startup, for resource IDs known to this library.
  for(const cached of await dbGetAll('cache').catch(()=>[])){if(Date.now()>=cached.expiresAt)await dbDelete('cache',cached.resourceId).catch(()=>{});}
  // Original file handles only work when their browser still grants permission. Check when opened.
  if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
  render();await persistNow();
}
init();
