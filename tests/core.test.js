import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFileType, detectUrlType, safeHttpUrl, validateResourceUrl, youtubeVideoId } from '../js/resources/detect-type.js';
import { PATH_FORMAT, exportLearningPath, validateLearningPath } from '../js/paths/path-format.js';
import { AI_TASKS, getTask } from '../js/ai/task-registry.js';
import { buildPrompt } from '../js/ai/prompt-builder.js';
import { parseAIResponse, correctionPrompt } from '../js/ai/response-parser.js';

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
