# Switchman Design Summary

## What Switchman Solves Today

Switchman is a coordination layer for the current software delivery model:

- code lives on the filesystem
- git branches and worktrees are the execution substrate
- agents edit files directly
- conflicts are detected at file and branch boundaries

In that environment, Switchman provides:

- task routing
- leases/sessions for active work
- file claims before editing
- heartbeats and stale-session recovery
- worktree visibility
- conflict scans before merge

This is useful now because most teams still operate on files, branches, pull requests, and merges.

## What Survives Beyond Files

The most important primitive in Switchman is not the file claim. It is the lease.

Leases generalize across systems:

- who is actively working
- what unit of work they own
- whether they are still alive
- when work can be safely reassigned
- how claims and validation attach to a live execution session

Those ideas remain necessary whether the backing store is:

- a filesystem
- git worktrees
- a database
- a structured code graph

File claims do not generalize as well. They are specific to the current file-based world.

## Relation To A DB-Native Codebase

A database-backed codebase is directionally better than raw filesystem coordination, but it is not enough by itself.

Storing files in Postgres would help with:

- atomic writes
- stronger shared state
- subscriptions
- observability

But it would not solve the harder scaling problems for very large agent fleets:

- hot contention on shared code regions
- invalidation storms
- dependency fanout
- authority boundaries
- review bottlenecks
- automated governance

If code is only moved from files to rows, the system mostly recreates filesystem problems in a different storage engine.

## What A Larger System Would Need

At large scale, the real shift is from file editing to transactional mutation of structured code units.

That system likely needs:

- hierarchical ownership
- session and lease management
- structured code objects instead of raw file-only primitives
- incremental validation on each accepted mutation
- dependency-aware subscriptions
- automated policy and review gates
- deterministic materialization back to files where needed

In that world, many existing files become derived artifacts rather than primary authoring surfaces.

Most likely to become generated or secondary:

- repetitive config
- glue code
- generated docs
- repetitive tests
- scaffolding

More likely to remain high-signal canonical surfaces:

- public interfaces
- core product logic
- policy and compliance rules
- architecture and ownership boundaries

## How This Relates To Switchman

Switchman is a bridge system.

It improves coordination for the current file-first era while surfacing the primitives that matter in the next one.

What would likely carry forward into a future Switchman-like system:

- leases
- heartbeats
- stale-session recovery
- task routing
- execution visibility
- conflict prediction
- validation-aware coordination

What would likely be replaced:

- file claims as the primary lock unit
- worktree-centric workflow
- branch conflict scans as the main integration model

## Bottom Line

Switchman is not the final architecture for 10k or 100k agents.

It is useful because the industry still runs on files and git, and because it validates the operational primitives that a larger system will still need.

The project should be understood as:

1. a practical coordination tool for current workflows
2. a proving ground for leases, ownership, and session recovery
3. a stepping stone toward semantic, validation-aware, non-file-first coordination
