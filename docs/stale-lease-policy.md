# Stale Lease Policy

Switchman can store repo rules for recovering stuck or abandoned agent work.

This is useful when some agents are interactive, some are automated, and you want the repo to enforce one consistent rule for heartbeat timing and stuck-work cleanup.

## Inspect the active policy

```bash
switchman lease policy
switchman lease policy --json
```

Default policy:

```json
{
  "heartbeat_interval_seconds": 60,
  "stale_after_minutes": 15,
  "reap_on_status_check": false,
  "requeue_task_on_reap": true
}
```

## Update the policy

```bash
switchman lease policy set --heartbeat-interval-seconds 60
switchman lease policy set --stale-after-minutes 15
switchman lease policy set --reap-on-status-check true
switchman lease policy set --requeue-task-on-reap false
```

What these settings do:
- `heartbeat_interval_seconds` — how often long-running work should check in
- `stale_after_minutes` — when Switchman considers work abandoned
- `reap_on_status_check` — whether `switchman status` should clean up stale work automatically
- `requeue_task_on_reap` — whether cleaned-up work goes back to pending instead of failing

## Typical policy choices

For interactive agents:
- heartbeat more often
- stale after a shorter window
- auto-reap off if you prefer manual review

For unattended automation:
- auto-reap on
- requeue on reap
- use `switchman status` as a lightweight recovery loop
