# Switchman Example — taskapi

A real Express REST API used to test Switchman locally.

## What's in here

```
examples/
├── taskapi/                  — A small task management REST API
│   ├── src/
│   │   ├── server.js         — Express entry point
│   │   ├── db.js             — In-memory data store
│   │   ├── middleware/
│   │   │   ├── auth.js       — API key auth (shared by all routes)
│   │   │   └── validate.js   — Request validation
│   │   └── routes/
│   │       ├── tasks.js      — CRUD endpoints for tasks
│   │       └── users.js      — User listing
│   └── tests/
│       └── api.test.js       — Smoke tests (run against live server)
├── setup.sh                  — Creates git repo, 3 worktrees, seeds Switchman tasks
├── walkthrough.sh            — Step-by-step demo of the full agent workflow
└── teardown.sh               — Resets everything so you can start fresh
```

## Quick start

This is the fastest way to understand Switchman as a new user.

If you just want the shortest proof run, start with:

```bash
switchman demo
```

Use the `examples/` scripts when you want a longer walkthrough you can customize or record.

Make sure Switchman is installed globally first:
```bash
npm install -g .   # from the switchman repo root
```

Then from the switchman repo root:
```bash
bash examples/setup.sh
bash examples/demo.sh
bash examples/walkthrough.sh
```

If you want the shortest path:
- `setup.sh` creates the repo, worktrees, and seed tasks
- `demo.sh` is the 45-90 second recordable version
- `walkthrough.sh` shows one complete 3-agent happy path, including a real claim conflict

## Recordable demo

If you want the short “wow” version for recording or showing the product quickly:

```bash
bash examples/setup.sh
bash examples/demo.sh
```

What it shows:
- a clean repo dashboard
- one agent locking files safely
- another agent getting blocked from overlapping work
- both branches landing through the queue
- a clean `switchman gate ci` at the end

## What the walkthrough shows

1. **3 worktrees created** — simulating 3 parallel Claude Code instances each on their own branch
2. **Agent 1 picks up a task** — `switchman lease next` returns the highest-priority item and lease
3. **Agent 1 claims files** — declares which files it will edit before touching them
4. **Agent 2 picks up a task** — takes the next item from the queue
5. **Agent 2 tries to claim a conflicting file** — Switchman blocks it
6. **Agent 2 adapts** — claims only the safe files instead
7. **Agent 1 finishes** — marks task done, releases file claims

Under the hood, Switchman now treats the lease as the execution record. That means reviewer artifacts and audit history can point back to the exact lease that performed the work, not just the task title.
8. **Final status** — queue updated, readable status output, no lingering conflicts

## What a good demo run looks like

At the end of the walkthrough, you want to see:
- tasks moving from `pending` -> `in_progress` -> `done`
- one agent blocked from claiming a file already owned by another
- `switchman scan` showing no unclaimed changes
- `switchman status` giving a clean overview of what happened

## The taskapi project

A minimal but real Express API with:
- API key authentication (`Authorization: Bearer dev-key-alice-123`)
- CRUD endpoints for tasks (`GET/POST/PATCH/DELETE /tasks`)
- User listing (`GET /users`, admin only)
- Input validation middleware
- In-memory data store (no database setup required)

### Running the API

```bash
cd examples/taskapi
npm install
npm start
```

```
taskapi running on http://localhost:3000
  GET  /health
  GET  /tasks   (Bearer dev-key-alice-123)
  GET  /users   (Bearer dev-key-alice-123, admin only)
```

### Running the API tests

With the server running in one terminal:
```bash
cd examples/taskapi
node tests/api.test.js
```

### API keys

| Key | User | Role |
|-----|------|------|
| `dev-key-alice-123` | Alice | admin |
| `dev-key-bob-456` | Bob | member |
| `test-key-789` | Test | member |

### Example requests

```bash
# Health check
curl http://localhost:3000/health

# List tasks
curl -H "Authorization: Bearer dev-key-alice-123" http://localhost:3000/tasks

# Create a task
curl -X POST http://localhost:3000/tasks \
  -H "Authorization: Bearer dev-key-alice-123" \
  -H "Content-Type: application/json" \
  -d '{"title": "My new task", "priority": "high"}'

# Update task status
curl -X PATCH http://localhost:3000/tasks/1 \
  -H "Authorization: Bearer dev-key-alice-123" \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

## Reset

```bash
bash examples/teardown.sh
bash examples/setup.sh
```
