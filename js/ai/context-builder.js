function compactResource(resource) {
  return {
    id: resource.id, type: resource.type, title: resource.title, author: resource.author || undefined,
    description: resource.description || undefined, category: resource.category || undefined,
    url: resource.source?.url || undefined, tags: resource.tags || [], topics: resource.topicIds || [],
    progress: undefined
  };
}

export function buildTaskContext(taskId, state, options = {}) {
  const selectedIds = options.resourceIds || (options.resourceId ? [options.resourceId] : []);
  const selectedResources = selectedIds.map(id => state.resources.find(r => r.id === id)).filter(Boolean);
  const selectedNotes = (options.noteIds || []).map(id => state.notes.find(n => n.id === id)).filter(Boolean);
  const selectedCollections = (options.collectionIds || []).map(id => state.collections.find(c => c.id === id)).filter(Boolean);
  const context = { taskId, generatedAt: new Date().toISOString(), goal: options.goal || '', constraints: options.constraints || '' };
  if (selectedResources.length) context.selectedResources = selectedResources.map(compactResource);
  if (selectedNotes.length) context.selectedNotes = selectedNotes.map(n => ({ id: n.id, title: n.title, content: n.content, topicIds: n.topicIds || [], resourceId: n.bookId || n.resourceId || undefined }));
  if (selectedCollections.length) context.selectedCollections = selectedCollections.map(c => ({ id: c.id, name: c.name, description: c.description || '', resourceIds: (c.resourceIds || c.bookIds || []).filter(id => state.resources.some(r => r.id === id)), resources: (c.resourceIds || c.bookIds || []).map(id => state.resources.find(r => r.id === id)).filter(Boolean).map(compactResource), suggestedResourceTitles: c.suggestedResourceTitles || [] }));
  if (options.includeResourceContent && Array.isArray(options.resourceContents) && options.resourceContents.length) {
    context.selectedResourceContent = options.resourceContents.filter(item => item && typeof item.title === 'string' && typeof item.content === 'string').map(item => ({ id: item.id, title: item.title, type: item.type, mimeType: item.mimeType || undefined, content: item.content.slice(0, item.type === 'image' ? 250000 : 12000), source: item.source || 'user-approved extraction' }));
    context.resourceContentReminder = 'Only the selected, explicitly opted-in extracted content is included. External resources without accessible text are represented by metadata only.';
    if (Array.isArray(options.contentAttachmentSkipped) && options.contentAttachmentSkipped.length) context.contentAttachmentSkipped = options.contentAttachmentSkipped;
  }
  if (options.suppliedText?.trim()) context.userSuppliedText = options.suppliedText.trim().slice(0, 30000);
  if (taskId.includes('graph.') || taskId === 'learning-path.create' || taskId === 'collection.create' || taskId === 'learning.schedule') {
    context.existingResources = state.resources.slice(0, 100).map(compactResource);
    context.existingTopics = state.topics.slice(0, 100).map(t => ({ id: t.id, name: t.name, description: t.description }));
  }
  if (taskId === 'learning-path.create' || taskId === 'learning.schedule') {
    context.existingLearningPaths = state.paths.slice(0, 30).map(p => ({ id: p.id, title: p.title, description: p.description || p.subtitle, stepCount: p.steps?.length || 0 }));
    context.learningHistory = Object.entries(state.progress || {}).slice(0, 50).map(([resourceId, p]) => ({ resourceId, status: p.status || 'want', pagesVisited: p.visitedPages?.length, currentPage: p.currentPage, activeSeconds: p.activeSeconds }));
  }
  if (taskId.startsWith('notes.')) {
    // Notes are private by default. Only include notes the user explicitly selected.
    context.selectedNotes = selectedNotes.map(n => ({ id: n.id, title: n.title, content: n.content, topicIds: n.topicIds || [] }));
    context.notesSelectionReminder = selectedNotes.length ? `${selectedNotes.length} note(s) explicitly selected by the user.` : 'No notes were selected. Do not infer or invent note contents; use only supplied text if present.';
  }
  return context;
}
