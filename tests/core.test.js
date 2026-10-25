import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFileType, detectUrlType, safeHttpUrl, validateResourceUrl, youtubeVideoId } from '../js/resources/detect-type.js';
import { PATH_FORMAT, exportLearningPath, validateLearningPath } from '../js/paths/path-format.js';
import { AI_TASKS, getTask } from '../js/ai/task-registry.js';
import { buildPrompt } from '../js/ai/prompt-builder.js';
import { parseAIResponse, correctionPrompt } from '../js/ai/response-parser.js';
import { cleanDemoContent, createFreshStateForBackup } from '../js/storage/app-state.js';

const pathFixture = {
  format: PATH_FORMAT,
  schemaVersion: 1,
  path: {
    title: 'Learn web accessibility',
    description: 'A practical starter path',
    difficulty: 'beginner',
    estimatedMinutes: 45,
    tags: ['web', 'accessibility'],
    learningObjectives: ['Understand accessible web basics'],
    steps: [{
      id: 'step-01', title: 'Read the fundamentals', description: 'Start with the WAI introduction.',
      estimatedMinutes: 45, resource: { type: 'website', title: 'WAI', url: 'https://www.w3.org/WAI/fundamentals/' },
      completionRule: 'manual'
    }]
  }
};

test('resource type detection supports the main imported formats', () => {
  assert.equal(detectFileType({ name: 'lecture.PDF', type: 'application/pdf' }), 'pdf');
  assert.equal(detectFileType({ name: 'reader.epub', type: 'application/epub+zip' }), 'epub');
  assert.equal(detectFileType({ name: 'chart.png', type: 'image/png' }), 'image');
  assert.equal(detectFileType({ name: 'notes.md', type: 'text/markdown' }), 'text');
  assert.equal(detectUrlType('https://youtu.be/M7lc1UVf-VE'), 'youtube');
  assert.equal(detectUrlType('https://example.org/book.pdf'), 'pdf');
  assert.equal(detectUrlType('https://example.org/cover.png'), 'image');
  assert.equal(detectUrlType('https://example.org/article'), 'website');
});

test('URL validation only accepts HTTP(S) and recognizes YouTube IDs', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(validateResourceUrl('file:///etc/passwd').ok, false);
  assert.equal(validateResourceUrl('https://example.org/page').ok, true);
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=M7lc1UVf-VE'), 'M7lc1UVf-VE');
  assert.equal(youtubeVideoId('https://youtu.be/M7lc1UVf-VE'), 'M7lc1UVf-VE');
});

test('Learning Path JSON v1 validates, normalizes, and exports', () => {
  const validated = validateLearningPath(pathFixture);
  assert.equal(validated.ok, true, JSON.stringify(validated.errors));
  assert.equal(validated.value.steps.length, 1);
  const roundTrip = validateLearningPath(exportLearningPath(validated.value));
  assert.equal(roundTrip.ok, true);
  assert.equal(validateLearningPath({ ...pathFixture, schemaVersion: 99 }).ok, false);
  const duplicate = structuredClone(pathFixture);
  duplicate.path.steps.push({ ...duplicate.path.steps[0], title: 'Duplicate' });
  assert.equal(validateLearningPath(duplicate).ok, false);
  const unsafe = structuredClone(pathFixture);
  unsafe.path.steps[0].resource.url = 'javascript:alert(1)';
  assert.equal(validateLearningPath(unsafe).ok, false);
  const unknownType = structuredClone(pathFixture);
  unknownType.path.steps[0].resource.type = 'custom-browser-exploit';
  assert.equal(validateLearningPath(unknownType).ok, false);
  const badRule = structuredClone(pathFixture);
  badRule.path.steps[0].completionRule = 'pretend-automatic';
  assert.equal(validateLearningPath(badRule).ok, false);
});

test('AI task registry contains reusable task definitions', () => {
  assert.ok(AI_TASKS.length >= 9);
  assert.ok(getTask('learning-path.create'));
  assert.equal(getTask('task.not-real'), null);
});

test('plain-text AI answers can be reviewed as notes without JSON wrapping', () => {
  const plain = '# Better learning notes\n\nSpaced retrieval and regular practice help strengthen recall.';
  const parsed = parseAIResponse(plain, 'notes.capture');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, 'plain-note');
  assert.equal(parsed.value.title, 'Better learning notes');
  assert.match(parsed.value.content, /Spaced retrieval/);
  assert.equal(parseAIResponse(plain).ok, false);
  const fenced = parseAIResponse('```markdown\n# Fenced note\n\nUseful text.\n```', 'notes.capture');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.value.title, 'Fenced note');
  assert.doesNotMatch(fenced.value.content, /```/);
  const wrapped = { format:'neo-world.ai-result', schemaVersion:1, taskId:'notes.capture', result:{ title:'A note', content:'Plain content.' } };
  assert.equal(parseAIResponse(JSON.stringify(wrapped), 'notes.capture').ok, true);
});

test('AI response parser validates a task result and enforces the expected task', () => {
  const response = {
    format: 'neo-world.ai-result', schemaVersion: 1, taskId: 'notes.flashcards',
    result: { flashcards: [{ id: 'c1', question: 'What is semantic HTML?', answer: 'HTML that expresses structure and meaning.' }] }
  };
  assert.equal(parseAIResponse(JSON.stringify(response), 'notes.flashcards').ok, true);
  assert.equal(parseAIResponse(JSON.stringify(response), 'notes.quiz').ok, false);
  const invalid = { ...response, result: { flashcards: [{ question: 4, answer: 'Wrong type' }] } };
  assert.equal(parseAIResponse(JSON.stringify(invalid)).ok, false);
  assert.match(correctionPrompt('bad', ['The result is invalid.'], 'notes.quiz'), /VALIDATION ERRORS/);
});

test('context-aware prompt includes only explicitly selected note contents', () => {
  const state = {
    resources: [{ id: 'r1', title: 'Intro to AI', type: 'book', category: 'Technology', description: 'Sample metadata only', tags: [], topicIds: [], source: { kind: 'catalog' } }],
    notes: [
      { id: 'n1', title: 'Selected thought', content: 'This selected note may be shared.', topicIds: [] },
      { id: 'n2', title: 'Private thought', content: 'This unselected secret must not be included.', topicIds: [] }
    ],
    topics: [], paths: [], progress: {}
  };
  const prompt = buildPrompt('notes.flashcards', state, { resourceIds: ['r1'], noteIds: ['n1'], suppliedText: 'A supplied excerpt.' });
  assert.match(prompt, /This selected note may be shared/);
  assert.match(prompt, /A supplied excerpt/);
  assert.doesNotMatch(prompt, /This unselected secret must not be included/);
  assert.match(prompt, /Do not claim to have opened/);
});


test('graph connection results accept exact existing topic IDs without invented names', () => {
  const response = {
    format: 'neo-world.ai-result', schemaVersion: 1, taskId: 'graph.connections',
    result: { connections: [{ sourceTopicId: 'topic-a', targetTopicId: 'topic-b', relationshipType: 'supports', reason: 'They share a concept.' }] }
  };
  assert.equal(parseAIResponse(JSON.stringify(response), 'graph.connections').ok, true);
  const invalid = structuredClone(response);
  invalid.result.connections[0].targetTopicId = '';
  assert.equal(parseAIResponse(JSON.stringify(invalid), 'graph.connections').ok, false);
});

test('demo cleanup removes seeded records while preserving user records and custom notes', () => {
  const state = {
    schemaVersion: 2,
    resources: [
      { id: 'thinking-clearly', title: 'Seed book', type: 'book' },
      { id: 'demo-wai-site', title: 'Seed site', type: 'website', demo: true },
      { id: 'mine-pdf', title: 'My PDF', type: 'pdf', source: { fileId: 'file-kept' } }
    ],
    libraryIds: ['thinking-clearly', 'mine-pdf'],
    progress: { 'thinking-clearly': { progress: 20 }, 'mine-pdf': { currentPage: 3 } },
    notes: [
      { id: 'note-1', title: 'Seed note', content: 'demo' },
      { id: 'mine-note', title: 'My note', content: 'Keep me', bookId: 'thinking-clearly' }
    ],
    topics: [{ id: 'psychology', name: 'Seed topic' }, { id: 'mine-topic', name: 'Custom topic' }],
    connections: [{ source: 'psychology', target: 'mine-topic' }],
    paths: [{ id: 'ai', title: 'Seed path' }, { id: 'mine-path', title: 'Custom path', steps: [] }],
    collections: [{ id: 'thinking-collection', name: 'Seed collection' }, { id: 'mine-collection', name: 'My collection', resourceIds: ['mine-pdf', 'thinking-clearly'] }],
    schedules: [{ id: 'mine-schedule', title: 'My schedule', sessions: [] }],
    garden: { activityCount: 9, unlocked: ['sage'], activityLog: [{ id: 'act-1' }, { id: 'act-2' }, { id: 'act-3' }] }
  };
  const cleaned = cleanDemoContent(state);
  assert.deepEqual(cleaned.resources.map(resource => resource.id), ['mine-pdf']);
  assert.deepEqual(cleaned.libraryIds, ['mine-pdf']);
  assert.equal(cleaned.resources[0].source.fileId, 'file-kept');
  assert.equal(cleaned.notes[0].id, 'mine-note');
  assert.equal(cleaned.notes[0].bookId, '');
  assert.deepEqual(cleaned.topics.map(topic => topic.id), ['mine-topic']);
  assert.deepEqual(cleaned.paths.map(path => path.id), ['mine-path']);
  assert.equal(cleaned.collections[0].resourceIds.includes('thinking-clearly'), false);
  assert.equal(cleaned.schedules[0].id, 'mine-schedule');
  assert.equal(cleaned.garden.activityCount, 0);
});

test('AI context includes selected collection metadata and only opted-in extracted content', () => {
  const state = {
    resources: [{ id: 'r1', title: 'Local article', type: 'text', category: 'Research', description: '', tags: [], topicIds: [], source: {} }],
    notes: [], topics: [], paths: [], progress: {},
    collections: [{ id: 'c1', name: 'Research stack', description: 'Read together', resourceIds: ['r1'] }]
  };
  const metadataOnly = buildPrompt('resource.summarize', state, { collectionIds: ['c1'] });
  assert.match(metadataOnly, /Research stack/);
  assert.doesNotMatch(metadataOnly, /explicitly selected content should not leak/);
  const attached = buildPrompt('resource.summarize', state, { resourceIds: ['r1'], includeResourceContent: true, resourceContents: [{ id: 'r1', title: 'Local article', type: 'text', content: 'explicitly selected content should not leak', source: 'local file' }] });
  assert.match(attached, /explicitly selected content should not leak/);
});

test('fresh state starts with no seeded demo content', () => {
  const fresh = createFreshStateForBackup();
  assert.deepEqual(fresh.resources, []);
  assert.deepEqual(fresh.libraryIds, []);
  assert.deepEqual(fresh.notes, []);
  assert.deepEqual(fresh.topics, []);
  assert.deepEqual(fresh.paths, []);
  assert.deepEqual(fresh.collections, []);
  assert.equal(fresh.garden.activityCount, 0);
});
