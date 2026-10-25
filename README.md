# Neo World Library 0.4

A browser-first personal learning app for collecting books, PDFs, EPUBs, images, YouTube videos, websites, audio/video, text files, and other file attachments. It also includes notes, topics, a knowledge graph, Learning Path JSON import/export, a progress-aware reader layer, and a copy-and-paste AI Task Bridge.

## Run locally

Run the included core checks with `npm test` (Node.js 18+). The app itself has no build step and no runtime npm dependencies.

Use a local HTTP server. ES modules, IndexedDB and the optional service worker behave more predictably over HTTP than when opening `index.html` directly.

### Windows / macOS / Linux

```bash
cd neo-world-library
python -m http.server 8000
```

Open <http://127.0.0.1:8000>.

### Android with Termux

```bash
pkg install python
cd /path/to/neo-world-library
python -m http.server 8000
```

Open `http://127.0.0.1:8000` in the phone browser. Replace the example path with the actual extracted directory path. If the project is in shared storage, run `termux-setup-storage` once and grant permission.

## Main features

- **Resource-first model:** books are one type of resource alongside PDF, EPUB, image, YouTube, website, audio, video, text, and generic files.
- **Add Resource:** import a file copy, optionally link an original file via the File System Access API in supporting browsers, paste a URL, or create a metadata-only resource.
- **Browser-first storage:** resource metadata, progress, notes, topics, collections, paths and binary file copies are stored in IndexedDB. A localStorage fallback is used for metadata when IndexedDB cannot be opened.
- **PDF reader:** uses PDF.js from a pinned CDN release; tracks current page, furthest page, unique pages visited and total pages when available.
- **EPUB reader:** uses epub.js from a pinned CDN release; tracks current CFI/section and percentage when location data is available.
- **Image reader:** marks an image viewed after it loads and remains visible for at least one second while the page is visible.
- **YouTube reader:** uses the official YouTube IFrame Player API to record observed playback time, duration where available and resume position.
- **Website reader:** embeds sites that allow it and provides an external-open fallback. Tracks time in Neo World and any same-origin scroll signals it can access.
- **Audio/video reader:** tracks observed playback time, resume position, and duration when available.
- **Learning Paths:** create manually or import/export `neo-world.learning-path` JSON schema v1.
- **AI Task Bridge:** generates context-aware prompts for an external AI, supports searchable resource/note/collection pickers, validates structured results, previews proposed changes and applies only after approval. Collection prompts include member titles and metadata, not full files. The “Save an AI answer as a note” task can import plain text without JSON.
- **Study schedules:** a dedicated schedule dashboard lets you mark sessions complete, edit objectives, set or change dates, and delete plans.
- **Opt-in content attachments:** off by default. When enabled, local PDFs and text files can contribute extracted text, EPUBs can contribute readable sections, and small local images can be attached as base64. YouTube/video transcripts must be pasted by the user. External links remain metadata-only when their contents are not accessible.
- **Clean start:** new installs contain no seeded books, sample notes, sample topics, demo paths, or fake garden activity. Existing state is migrated to remove known prototype records while preserving user-created resources, notes, schedules, file references, and stored binary blobs. A backup option appears before cleanup.
- **Connected learning:** notes, topics, connections, reading paths, garden activities, search and library state interact with one another. AI knowledge connections resolve topic IDs or normalized existing names and skip duplicates, self-links, and unresolved pairs.
- **PWA shell:** manifest and service worker cache application assets for faster and more resilient reopening. Imported media is handled separately.
- **Backup:** exports metadata and user state as JSON. Binary file contents and device file handles are not included in the export.

## File and browser limitations

- **Import a copy** stores the selected file in IndexedDB. Browser storage has quotas and may be cleared or evicted by the browser. Use the export/back-up feature for metadata, and keep originals for important files.
- **Original file** uses `showOpenFilePicker()` where supported. The browser still controls access and may ask for permission again. It cannot freely open arbitrary paths such as `/storage/emulated/0/Download/file.pdf`.
- **Cloud cache:** a resource's **Cache 24h** action tries to download a file into IndexedDB with a 24-hour expiry. This works only when the server permits browser fetch/CORS and the resource is actually downloadable. Browsers can evict cached data under storage pressure.
- **YouTube:** Neo World embeds supported videos and counts actual observed playback. It does not download or cache YouTube video streams. Some videos disable embedding.
- **Websites:** cross-origin iframe rules prevent Neo World from reading most third-party page scroll positions, DOM contents or internal navigations. The app labels these signals unavailable instead of inventing percentages. A future browser extension would be needed for broader cross-site tracking.
- **External AI:** no prompt is sent to an AI by this app. You choose what to copy and where to paste it. AI output can be wrong, and links are not automatically verified. Changes are previewed before application.
- **Empty by design:** Neo World starts with your own library, not a pile of seeded sample content. Import authorized PDFs/EPUBs or add real resource URLs to build your own catalog.
- **CDN dependencies:** PDF.js and epub.js are fetched when those readers are opened. YouTube's official player API is fetched when a YouTube resource opens. Those readers require a network connection unless the libraries are later vendored locally. The app shell itself can be cached by the service worker.
- **Supported local types:** PDF, EPUB, common image formats, audio/video formats, plain text and Markdown are handled directly. Generic unsupported files are stored as attachments and offered for download/opening; they do not magically become readable formats.

## Learning Path JSON v1

Schema file: `schemas/learning-path-v1.json`.

Minimal example:

```json
{
  "format": "neo-world.learning-path",
  "schemaVersion": 1,
  "path": {
    "title": "Learn Web Accessibility",
    "description": "A short practical introduction.",
    "difficulty": "beginner",
    "estimatedMinutes": 60,
    "tags": ["frontend", "accessibility"],
    "learningObjectives": ["Understand accessible web fundamentals"],
    "steps": [
      {
        "id": "step-01",
        "title": "Read the fundamentals",
        "description": "Study accessible web design basics.",
        "estimatedMinutes": 25,
        "resource": {
          "type": "website",
          "title": "W3C Web Accessibility Initiative",
          "url": "https://www.w3.org/WAI/fundamentals/"
        },
        "completionRule": "manual"
      }
    ]
  }
}
```

Use **Learning Paths → Copy JSON format prompt** or **AI Task Bridge → Create a learning path** to get a prompt suitable for ChatGPT, Gemini, Claude, or another AI. Paste the returned JSON into **Import JSON**, inspect validation and preview, then approve the import.

## AI Task Bridge result format v1

Schema file: `schemas/task-result-v1.json`.

Most tasks return a wrapper like:

```json
{
  "format": "neo-world.ai-result",
  "schemaVersion": 1,
  "taskId": "resource.summarize",
  "result": {
    "title": "Summary title",
    "summary": "Summary based only on supplied text.",
    "keyPoints": ["Point one"],
    "questions": ["What remains uncertain?"],
    "limitations": "Only the supplied excerpt was available."
  }
}
```

Available tasks include learning-path creation, resource metadata enrichment, summaries, plain-text note capture, flashcards, quizzes, knowledge connections, collection curation, note synthesis, and study schedules. Task result schemas are validated in code before the application handler runs.

## Project structure

```text
neo-world-library/
├── index.html
├── package.json
├── tests/core.test.js
├── manifest.json
├── service-worker.js
├── css/styles.css
├── assets/neo-icon.svg
├── schemas/
│   ├── learning-path-v1.json
│   └── task-result-v1.json
└── js/
    ├── app.js
    ├── data.js
    ├── storage/
    │   ├── app-state.js
    │   ├── database.js
    │   ├── file-store.js
    │   └── cache-manager.js
    ├── resources/detect-type.js
    ├── readers/
    │   ├── pdf-reader.js
    │   ├── epub-reader.js
    │   ├── image-reader.js
    │   ├── youtube-reader.js
    │   ├── website-reader.js
    │   ├── media-reader.js
    │   ├── text-reader.js
    │   └── file-reader.js
    ├── paths/path-format.js
    └── ai/
        ├── task-registry.js
        ├── context-builder.js
        ├── prompt-builder.js
        └── response-parser.js
```

## Deploy

Upload the folder contents to any static host that serves HTML, JavaScript modules, CSS, the web app manifest, and the service worker over HTTPS. Keep the relative file structure. For production use, consider self-hosting pinned reader libraries, adding tested backup import/restore, and adding authenticated cloud sync only when multi-device access is needed.
