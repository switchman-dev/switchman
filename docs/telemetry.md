# Telemetry

Switchman telemetry is optional and off by default.

If you opt in, Switchman sends a few anonymous usage events so the project can learn whether setup works and which workflows people actually use.

## What it sends

Only small product-health events such as:
- `setup_completed`
- `verify_setup_passed`
- `verify_setup_failed`
- `status_watch_used`
- `queue_used`
- `gate_ci_passed`
- `gate_ci_failed`

These events include only lightweight metadata like:
- Switchman version
- operating system
- Node version
- coarse success or failure counts
- an anonymous install ID

## What it does not send

Switchman does not send:
- source code
- file contents
- prompts
- task titles
- repo names or URLs
- usernames or emails
- secrets or environment variables

## How to enable it

First set a telemetry destination:

```bash
export SWITCHMAN_TELEMETRY_API_KEY=your_posthog_project_key
```

Then opt in:

```bash
switchman telemetry enable
switchman telemetry status
```

## How to disable it

```bash
switchman telemetry disable
```

## Where the choice is stored

Telemetry settings are stored locally in:

```text
~/.switchman/config.json
```

That file stores whether telemetry is enabled and an anonymous install ID.
