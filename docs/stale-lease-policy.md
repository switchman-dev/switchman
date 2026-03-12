# Stale Lease Policy

Switchman can store a repo-level policy for stale lease recovery.

This is useful when some agents are interactive, some are automated, and you want the repo to enforce one consistent rule for heartbeat cadence and stale-work cleanup.

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
- `heartbeat_interval_seconds`
- `stale_after_minutes`
- `reap_on_status_check`
- `requeue_task_on_reap`

## Typical policy choices

For interactive agents:
- heartbeat more often
- stale after a shorter window
- auto-reap off if you prefer manual review

For unattended automation:
- auto-reap on
- requeue on reap
- use `switchman status` as a lightweight recovery loop
