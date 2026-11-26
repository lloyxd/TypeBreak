# TypeBreak

An adaptive typing tutor that runs **entirely in your browser**. No backend, no
account, no network calls, no telemetry. Your practice history lives in
IndexedDB on your own device and can be exported to a JSON file you control.

The idea is a personal typing coach: instead of a fixed curriculum, TypeBreak
measures how each finger performs and builds each day's practice from a
predefined lesson library, weighted toward whatever is costing you accuracy.

---

## Quick start

Node 22.18+ is needed for the dev tooling only. The app itself ships zero
dependencies, has no build step, and does not need Node to run.

```bash
npm start            # static dev server at http://localhost:4173
npm test             # 249 tests
```

Deploying is a copy of `web/` to any static host (see [Deployment](#deployment)).

---

## Architecture

Everything runs in the browser. The core is a set of pure modules with no DOM, no
storage and no clock of their own; the pages are the only thing that touches the
screen.

```
web/
  index.html               app shell
  app.js                   boot: service init → routes → router
  client.js                the data surface pages call (thin adapter)
  router.js                hash router
  dom.js                   tiny DOM helpers + chart primitives
  pwa.js / sw.js           service worker registration + offline behaviour
  manifest.webmanifest
  staticwebapp.config.json Azure Static Web Apps config
  core/
    keyboard.js            key → finger → movement. Pure data.
    library.js             loads, validates, deep-freezes the lesson library
    engine.js              TypingSession: keystrokes → metrics + attribution
    profiles.js            finger/movement proficiency, streaks, history
    bts.js                 weaknesses → scores → daily plan → explanations
    db.js                  IndexedDB persistence
    backup.js              JSON export / validate / merge / replace
    service.js             wires the above together
    context.js             one service per page load
    words.js               frozen bank for timed free practice
    lesson-flow.js         redo-or-advance after the last exercise
  pages/                   dashboard, lessons, practice, free-practice, progress, settings
  data/lessons.json        the predefined library (generated, read-only)
```

### Why the boundary matters

- **The lesson library is fixed.** Generated once by `tools/build-lessons.js`
  (deterministic, seeded), loaded at runtime, validated and deep-frozen. There is
  no code path that adds a lesson or edits exercise text.
- **The planner can only select.** `planDay()` returns lesson *ids*, and a guard
  (`assertPlanUsesLibraryOnly`) makes it impossible for a plan to reference
  anything that did not come from the file.
- **Scoring lives in one place.** Pages render what the service gives them;
  `requirements.test.js` asserts that no page re-implements WPM or weakness
  detection.
- **BTS is UI-independent and offline.** It is a pure function of
  `(attempts, library, date)` — no network, no storage, no DOM.

---

## Lesson access

Every lesson is available at any time. There is no enforced sequence:

- **Browse and filter** the whole library by finger, movement, category, level or
  free text (`#/lessons`).
- **Start any lesson, any exercise**, including ones you have already passed.
- **See history per lesson** — attempts, best accuracy, best speed, when you last
  practised, and whether you have met the criteria.

The daily plan is a *suggestion*, not a gate.

---

## Local data

All progress is stored in IndexedDB, in a single versioned document:

| Section | Contents |
| --- | --- |
| `attempts` | Every exercise attempt: metrics, per-finger and per-movement tallies, attributed mistakes |
| `plans` / `tasks` | Generated daily plans and task state, keyed by date |
| `profile.settings` | Typing mode, daily goals |

Derived views (finger profiles, weaknesses, overall progress) are recomputed from
`attempts` on demand rather than stored, so an algorithm improvement benefits
existing history instead of requiring a migration.

**Durability**

- Writes are serialised through a queue and awaited on `flush()`, which the
  practice page calls the moment an exercise finishes. A refresh mid-session does
  not lose the attempt.
- The previous document is kept as a rolling backup (last 3) in a second object
  store, so a bad write is recoverable.
- If IndexedDB is unavailable (private browsing, enterprise policy), the app keeps
  working in memory and says so plainly in the sidebar and on the Settings page
  rather than silently discarding practice.

---

## Backup and restore

Progress lives only in this browser, so export is the only durable copy.

**Export** produces one JSON file containing the full attempt history, lesson
progress, daily plans and task state, plus:

```json
{
  "format": "typebreak-progress",
  "exportVersion": 1,
  "schemaVersion": 2,
  "exportedAt": "2026-11-25T17:30:00.000Z",
  "summary": { "attempts": 112, "lessons": 26, "practiceMs": 375300 },
  "data": { "profile": {}, "attempts": [], "plans": {}, "tasks": {} }
}
```

`exportVersion` describes the *file format*; `schemaVersion` describes the *data
document*. They are separate so the format can stay stable while the schema
evolves.

**Import** is deliberately cautious:

1. **Validate** — format marker, both versions, and the shape of every record.
   A file from a newer version is refused with an explanation rather than
   partially applied.
2. **Preview** — shows what is in the file, how many attempts are new, how many
   you already have, and how many of *your* attempts would be lost by replacing.
3. **Choose** — `Merge` (default, additive) or `Replace` (destructive, and the UI
   states exactly what would be lost before asking).

**Safety rules**

- Import never silently overwrites. Merge is the default; replace requires a
  confirmation that names the number of attempts at risk.
- **Duplicate records are de-duplicated** by `(lesson, exercise, startedAt,
  finishedAt)`, normalised so a numeric timestamp from an older build matches the
  ISO string a newer one writes. Re-importing the same file adds nothing.
- Malformed records are skipped with a warning naming how many, rather than
  failing the whole file or poisoning the store.
- Bad individual figures are coerced (a non-numeric `wpm` becomes 0, accuracy is
  clamped to 0–100) because discarding a whole attempt over one bad field would
  quietly shorten someone's history.
- Local **settings** and today's **plan** win on merge, so an import cannot change
  your typing mode or rearrange the session you are in the middle of.
- The BTS reads `attempts`, so imported history feeds recommendations immediately
  — nothing extra needs restoring.

---

## Adaptive learning (BTS)

`web/core/bts.js` is pure and deterministic: same attempts + same date ⇒ same
plan. It runs entirely on local data.

**1. Evaluate.** Per finger and movement:

```
severity = (accuracy gap / target) × 85 + error volume × 15
```

blended 40/60 between lifetime and recent accuracy, so a recovered finger stops
being flagged. A hard cap is deliberately avoided — capping makes every bad
finger score 100 and hides which is actually worst.

**2. Identify.** Findings require multiple attempts *and* enough characters before
anything is called a weakness; one bad run cannot create one (tested). Covers
weak fingers, weak movements, regressions, and lessons that take unusually long.

**3. Score.** Ten independent, individually-explained signals: weakness,
movement-weakness, low-accuracy, new-material, frontier level, level-fit,
staleness, not-passed, regression, difficulty penalty, mastered discount. Every
signal that fires appends a plain-English reason, so any recommendation can be
traced to the numbers.

**4. Plan.** Quotas, not a pure top-N, so weakness work cannot crowd out
development:

```
6 items = 3 weakness + 2 progression + 1 maintenance
```

Weakness slots round-robin across weak fingers (worst first), preferring lessons
that drill that finger *specifically*. Weakness work is capped at 60% of the plan;
when a library genuinely lacks other material the plan reports
`balance.status: "weakness-limited"` rather than mislabelling drills. Plans are
generated once per day and reused.

**5. Explain.** Every item carries its reasons, and the plan has a readable
explanation naming the weaknesses it actually addresses.

`node tools/simulate.js` runs a 4-week learner and prints the whole cycle.

---

## Offline

A service worker precaches the app shell and the lesson library on first visit.

| Resource | Strategy |
| --- | --- |
| Navigation | Network-first, falling back to the cached shell (routing is by hash) |
| App shell (HTML/JS/CSS) | Network-first with cache fallback, so updates land promptly |
| `data/lessons.json` | Cache-first with background refresh — immutable and large |

Progress is in IndexedDB, which the worker does not touch: there is nothing to
sync and no data at risk. Export and import are pure local file operations and
work offline.

Verified by stopping the server and reloading: the library, a full practice
session, plan generation and task tracking all continue to work.

---

## Deployment

Target: **Azure Static Web Apps, Free tier**. No backend, no database, no paid
service.

1. Push the repository.
2. Create a Static Web App in Azure, choosing **Other** as the source (or connect
   GitHub/GitLab and set the app location to `web`).
3. Set the app artifact location to `web`; leave the API location empty.
4. Build: `npm run build` if you want the library and icons regenerated, otherwise
   none — the committed files are ready to serve.

Azure supplies HTTPS, which is required for service workers and reliable
IndexedDB persistence. `web/staticwebapp.config.json` sets:

- long cache for `/icons/*` and `/data/*`, `no-cache` for `/sw.js` so updates are
  picked up,
- a strict Content-Security-Policy with `connect-src 'self'` — the app cannot
  make an off-site network request even if someone later tried to add one,
- `frame-ancestors 'none'`, `nosniff`, and a no-referrer policy,
- a navigation fallback to `index.html` for the hash router.

The Free tier's limits are irrelevant here: with no API there is no function
execution, and only static bandwidth is used.

---

## Tests

```
225 tests, 0 failures
```

| File | Covers |
| --- | --- |
| `keyboard.test.js` | Every key maps to exactly one finger; shifts keep their finger |
| `library.test.js` | Validation, freezing, full finger/movement coverage, filter edge cases |
| `engine.test.js` | WPM/accuracy maths, strict vs flow, error attribution, completion semantics |
| `bts.test.js` | Weakness detection, single-attempt immunity, scoring, determinism, balance |
| `store.test.js` | IndexedDB store against an in-memory stand-in: writes, backups, fallback |
| `backup.test.js` | Export shape, validation rejects junk, merge dedup, replace, timestamp types |
| `service.test.js` | The surface the pages use |
| `requirements.test.js` | One test per requirement, including "no backend exists" |

`tests/memory-store.js` is a synchronous in-memory stand-in used by the service
tests; the real IndexedDB store is tested separately.

---

## Development scripts

```bash
npm start               # static server on :4173
npm test                # run the suite
npm run lessons:build   # regenerate web/data/lessons.json (deterministic)
npm run icons:build     # regenerate PWA icons
npm run build           # both of the above
npm run lint:imports    # scan for dead imports
node tools/simulate.js  # 4-week BTS behaviour trace
```

## Adding lessons

1. Edit `tools/build-lessons.js`.
2. `npm run lessons:build`
3. `npm test` — coverage, id uniqueness and character mappability are asserted.

No change to the BTS algorithm or any page is needed. That is the point of
separating the library from the planner.
