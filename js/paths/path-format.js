import { detectUrlType, safeHttpUrl } from '../resources/detect-type.js';

export const PATH_FORMAT = 'neo-world.learning-path';
export const PATH_SCHEMA_VERSION = 1;

function str(value, max = 500) { return String(value ?? '').trim().slice(0, max); }

export function validateLearningPath(input) {
  const errors = [];
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(stripCodeFence(input)); } catch { return { ok: false, errors: ['The response is not valid JSON.'] }; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: ['Expected one JSON object.'] };
  if (data.format !== PATH_FORMAT) errors.push(`Expected format "${PATH_FORMAT}".`);
  if (Number(data.schemaVersion) !== PATH_SCHEMA_VERSION) errors.push(`Unsupported schemaVersion. Expected ${PATH_SCHEMA_VERSION}.`);
  const path = data.path;
  if (!path || typeof path !== 'object' || Array.isArray(path)) errors.push('Missing path object.');
  if (path && !str(path.title, 180)) errors.push('Path title is required.');
  if (path && !Array.isArray(path.steps)) errors.push('Path steps must be an array.');
  const steps = Array.isArray(path?.steps) ? path.steps : [];
  if (!steps.length) errors.push('Add at least one learning step.');
  if (steps.length > 100) errors.push('A path cannot contain more than 100 steps.');
  const ids = new Set();
  const supportedTypes = new Set(['book','pdf','epub','image','youtube','website','audio','video','text','file']);
  const completionRules = new Set(['manual','engagement','visited','pages']);
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) { errors.push(`Step ${index + 1} must be an object.`); return; }
    const id = str(step.id, 100) || `step-${index + 1}`;
    if (ids.has(id)) errors.push(`Duplicate step ID: ${id}.`);
    ids.add(id);
    if (!str(step.title, 180)) errors.push(`Step ${index + 1} needs a title.`);
    if (step.estimatedMinutes !== undefined && (!Number.isFinite(Number(step.estimatedMinutes)) || Number(step.estimatedMinutes) < 0 || Number(step.estimatedMinutes) > 100000)) errors.push(`Step ${index + 1} has an invalid estimatedMinutes value.`);
    if (step.completionRule !== undefined && !completionRules.has(step.completionRule)) errors.push(`Step ${index + 1} has an unsupported completionRule.`);
    const resource = step.resource;
    if (resource !== undefined && resource !== null && (typeof resource !== 'object' || Array.isArray(resource))) errors.push(`Step ${index + 1} resource must be an object.`);
    if (resource && typeof resource === 'object') {
      if (resource.type && !supportedTypes.has(resource.type)) errors.push(`Step ${index + 1} uses unsupported resource type "${str(resource.type, 40)}".`);
      if (resource.url && !safeHttpUrl(resource.url)) errors.push(`Step ${index + 1} has an invalid resource URL.`);
      if (resource.title !== undefined && typeof resource.title !== 'string') errors.push(`Step ${index + 1} resource title must be text.`);
    }
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: normalizeLearningPath(data) };
}

export function normalizeLearningPath(data, existingPath = null) {
  const raw = data.path || data;
  const id = existingPath?.id || `path-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2,7)}`}`;
  const steps = raw.steps.map((step, index) => {
    const resource = step.resource && typeof step.resource === 'object' ? { ...step.resource } : null;
    if (resource?.url) {
      resource.url = safeHttpUrl(resource.url);
      resource.type = resource.type || detectUrlType(resource.url);
    }
    return {
      id: str(step.id, 100) || `step-${index + 1}`,
      title: str(step.title, 180), detail: str(step.description || step.detail, 1500), done: !!step.done,
      estimatedMinutes: Math.max(0, Math.min(100000, Number(step.estimatedMinutes || 0))),
      resourceId: str(step.resourceId || resource?.id, 150) || null,
      resource, completionRule: ['manual','engagement','visited','pages'].includes(step.completionRule) ? step.completionRule : 'manual'
    };
  });
  return {
    id, title: str(raw.title, 180), subtitle: str(raw.description || raw.subtitle, 300), description: str(raw.description, 2500),
    category: str(raw.category || raw.tags?.[0] || 'Learning', 80), icon: '↗', tone: 'violet',
    minutes: Math.max(0, Math.min(100000, Number(raw.estimatedMinutes || steps.reduce((n,s)=>n+s.estimatedMinutes,0)))),
    difficulty: ['beginner','intermediate','advanced'].includes(raw.difficulty) ? raw.difficulty : 'beginner',
    tags: Array.isArray(raw.tags) ? raw.tags.map(x=>str(x,50)).filter(Boolean).slice(0,30) : [],
    learningObjectives: Array.isArray(raw.learningObjectives) ? raw.learningObjectives.map(x=>str(x,300)).filter(Boolean).slice(0,30) : [],
    steps, createdAt: existingPath?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

export function exportLearningPath(path) {
  return { format: PATH_FORMAT, schemaVersion: PATH_SCHEMA_VERSION, path: {
    title: path.title, description: path.description || path.subtitle || '', difficulty: path.difficulty || 'beginner',
    estimatedMinutes: path.minutes || path.steps.reduce((n,s)=>n+(s.estimatedMinutes||0),0), tags: path.tags || [],
    learningObjectives: path.learningObjectives || [], steps: path.steps.map((step, i) => ({
      id: step.id || `step-${i+1}`, title: step.title, description: step.detail || '', estimatedMinutes: step.estimatedMinutes || 0,
      resource: step.resource || undefined, resourceId: step.resourceId || undefined,
      completionRule: step.completionRule || 'manual', done: !!step.done
    }))
  } };
}

export function stripCodeFence(text) {
  return String(text || '').trim().replace(/^```(?:[a-z0-9_-]+)?\s*/i, '').replace(/\s*```$/, '').trim();
}
