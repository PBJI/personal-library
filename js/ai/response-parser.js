import { stripCodeFence, validateLearningPath } from '../paths/path-format.js';
import { getTask } from './task-registry.js';

export function parseAIResponse(raw, expectedTaskId = '') {
  const source = String(raw || '').trim();
  if (!source) return { ok: false, errors: ['Paste the AI response or choose its JSON file.'] };
  const cleaned = stripCodeFence(source);
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch {
    if (expectedTaskId === 'notes.capture' && !/^[\[{]/.test(cleaned)) {
      const firstLine = cleaned.split(/\r?\n/, 1)[0].replace(/^#{1,6}\s*/, '').trim();
      const title = firstLine && firstLine.length <= 120 ? firstLine : 'AI response note';
      return { ok: true, kind: 'plain-note', taskId: 'notes.capture', value: { title, content: cleaned }, raw: source };
    }
    return { ok: false, errors: ['Could not parse JSON. Select “Save an AI answer as a note” to import plain text, or ask the external AI to return the required JSON.'] };
  }
  if (parsed?.format === 'neo-world.learning-path') {
    const result = validateLearningPath(parsed);
    if (!result.ok) return result;
    return { ok: true, kind: 'learning-path', taskId: 'learning-path.create', value: result.value, raw: parsed };
  }
  if (parsed?.format !== 'neo-world.ai-result' || Number(parsed.schemaVersion) !== 1) {
    return { ok: false, errors: ['Unsupported result format. Expected neo-world.learning-path or neo-world.ai-result v1.'] };
  }
  if (!parsed.taskId || !getTask(parsed.taskId)) return { ok: false, errors: ['The result taskId is missing or unsupported.'] };
  if (expectedTaskId && parsed.taskId !== expectedTaskId) return { ok: false, errors: [`This response belongs to ${parsed.taskId}, but the selected task is ${expectedTaskId}.`] };
  if (!parsed.result || typeof parsed.result !== 'object' || Array.isArray(parsed.result)) return { ok: false, errors: ['The result field must be a JSON object.'] };
  const errors = validateTaskResult(parsed.taskId, parsed.result);
  if (errors.length) return { ok: false, errors };
  return { ok: true, kind: 'ai-result', taskId: parsed.taskId, value: parsed.result, raw: parsed };
}

function validateTaskResult(taskId, result) {
  const errors = [];
  const requireString = (key) => { if (typeof result[key] !== 'string' || !result[key].trim()) errors.push(`result.${key} must be a non-empty string.`); };
  const requireArray = (key) => { if (!Array.isArray(result[key])) errors.push(`result.${key} must be an array.`); };
  switch (taskId) {
    case 'resource.enrich': requireString('description'); requireArray('tags'); requireArray('topicSuggestions'); break;
    case 'resource.summarize': requireString('summary'); requireArray('keyPoints'); requireArray('questions'); break;
    case 'notes.capture': requireString('title'); requireString('content'); break;
    case 'notes.flashcards': requireArray('flashcards'); if (Array.isArray(result.flashcards) && result.flashcards.some(c => !c || typeof c.question !== 'string' || typeof c.answer !== 'string')) errors.push('Each flashcard needs question and answer strings.'); break;
    case 'notes.quiz': requireString('title'); requireArray('questions'); if (Array.isArray(result.questions) && result.questions.some(q => !q || typeof q.question !== 'string' || !Array.isArray(q.options) || !Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length)) errors.push('Each quiz question needs text, options, and a valid correctIndex.'); break;
    case 'graph.connections': requireArray('connections'); if (Array.isArray(result.connections) && result.connections.some(c => !c || typeof c.sourceTopicName !== 'string' || typeof c.targetTopicName !== 'string')) errors.push('Each connection needs sourceTopicName and targetTopicName.'); break;
    case 'collection.create': requireString('name'); requireArray('resourceIds'); break;
    case 'notes.consolidate': requireString('title'); requireString('synthesis'); requireArray('sourceNoteIds'); break;
    case 'learning.schedule': requireString('title'); requireArray('sessions'); break;
    default: errors.push('No validator exists for this task.');
  }
  return errors;
}

export function correctionPrompt(raw, errors, taskId = '') {
  return `Please repair the following Neo World AI result. Return only valid JSON, no Markdown fences or prose. Keep the intended taskId (${taskId || 'infer from input'}) and comply with the Neo World AI result schema. Fix only the listed errors; do not invent IDs or claim unverified resources are verified.\n\nVALIDATION ERRORS:\n${errors.map(e => `- ${e}`).join('\n')}\n\nORIGINAL RESPONSE:\n${String(raw || '').slice(0, 24000)}`;
}
