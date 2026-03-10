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

Make sure Switchman is installed globally first:
```bash
npm install -g .   # from the switchman repo root
```

Then from the switchman repo root:
```bash
bash examples/setup.sh
bash examples/walkthrough.sh
```

## What the walkthrough shows

1. **3 worktrees created** — simulating 3 parallel Claude Code instances each on their own branch
2. **Agent 1 picks up a task** — `switchman task next` returns the highest-priority item
3. **Agent 1 claims files** — declares which files it will edit before touching them
4. **Agent 2 picks up a task** — takes the next item from the queue
5. **Agent 2 tries to claim a conflicting file** — Switchman blocks it
6. **Agent 2 adapts** — claims only the safe files instead
7. **Agent 1 finishes** — marks task done, releases file claims
8. **Final status** — queue updated, no lingering conflicts

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
