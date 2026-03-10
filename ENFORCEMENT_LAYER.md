# Switchman Enforcement Layer

## Problem

Switchman works well when agents cooperate:

- acquire a lease
- claim files before editing
- mark tasks done when finished

That is enough for disciplined workflows and for agents with native integration.
It is not enough for broad multi-agent adoption because arbitrary agents can
still ignore Switchman and write to the repository directly.

The result is a trust gap:

- the user cannot easily tell whether every agent is actually coordinated
- status can look healthy while a non-compliant agent edits files outside the system
- conflict prevention is strongest only for agents that voluntarily participate

An enforcement layer closes that gap by moving Switchman from advisory
coordination to write-path governance.

## Goals

An enforcement layer should:

- make it obvious which agents are compliant and which are not
- require an active lease before write operations
- require claimed ownership before editing protected files
- preserve a full audit trail of attempted and completed mutations
- fail fast with clear, machine-readable reasons
- allow gradual rollout without breaking existing repos and tools

## Non-Goals

An enforcement layer should not try to:

- fully replace git in the first phase
- require every editor to become Switchman-native on day one
- block all local experimentation by default
- solve long-term semantic coordination alone

This layer is about reliable enforcement over the current file-and-git world.

## Threat Model

Switchman must assume any of the following can happen:

- an agent never calls Switchman at all
- an agent acquires a task but edits extra files it never claimed
- an agent dies and leaves stale ownership behind
- two different agent runtimes modify the same path through different tools
- a user manually edits files in a worktree being used by an agent
- a commit includes changed files that were never claimed

The enforcement layer must catch these conditions with hard signals, not just
best-effort guidance.

## Core Idea

Switchman should enforce at three levels:

1. `Session level`
   Every active agent must have a lease.

2. `Write level`
   Every file mutation must be associated with a valid lease and an active claim.

3. `Integration level`
   Every commit, merge, or PR must prove that its touched files were written
   under valid Switchman ownership.

This gives defense in depth:

- write-time enforcement prevents many collisions early
- commit-time enforcement catches bypasses
- scan/status/reporting tells the user what is happening

## Architecture

### 1. Lease Authority

The existing lease model becomes the root capability for active work.

Each lease needs:

- `lease_id`
- `task_id`
- `agent_id`
- `worktree`
- `status`
- `heartbeat_at`
- `allowed_paths` or claim references

No compliant write is allowed without a live lease.

### 2. Claim Policy Engine

The claim system becomes a policy check, not just a coordination hint.

For each requested write:

- resolve the active lease
- resolve the target path
- verify the path is claimed by that lease
- verify no policy exception is required
- allow or deny the operation

Denials should return structured reasons such as:

- `no_active_lease`
- `lease_expired`
- `path_not_claimed`
- `path_claimed_by_other_lease`
- `worktree_mismatch`
- `policy_exception_required`

### 3. Write Gateway

This is the most important new layer.

Instead of hoping agents write cooperatively, Switchman should offer a write
gateway that becomes the preferred mutation path.

Examples:

- `switchman write <leaseId> <path>` for content replacement
- `switchman patch <leaseId> <path>` for patch application
- `switchman mkdir/rm/mv` wrappers
- agent-facing MCP tools that write only through Switchman

The gateway performs:

- lease validation
- claim validation
- write serialization
- event logging
- optional pre-write lint/format hooks

This is the first step toward real enforcement.

### 4. Agent Tool Adapters

Different agents need different integration modes.

#### Native mode

For agents with MCP/tool integration:

- do not expose raw filesystem writes directly
- expose Switchman-backed write tools instead
- issue lease and claim checks inside the tool implementation

This gives the cleanest enforcement because the agent literally cannot use the
approved toolchain without going through Switchman.

#### Wrapper mode

For CLI agents without native integration:

- launch them through a Switchman wrapper
- set environment variables such as `SWITCHMAN_LEASE_ID`
- intercept known write operations where possible
- collect an operation log from the wrapper

This is weaker than native mode but much better than prompt-only compliance.

#### Observed mode

For tools that cannot yet be wrapped:

- mark them as unmanaged
- monitor changed files in near-real time
- report non-compliant writes immediately
- block commit/merge if unclaimed writes are detected

This is not full enforcement, but it gives the user visibility and an upgrade path.

### 5. Filesystem Monitor

Switchman should watch each managed worktree for file mutations.

For every change:

- map it to the current lease for that worktree
- verify the path was claimed
- record whether the change was compliant
- raise an alert if it was not

This catches:

- direct editor writes
- generated files
- accidental scope creep
- unmanaged tooling bypasses

The monitor does not need to be perfect to add value. It is the runtime signal
that tells the user whether Switchman is genuinely in control.

### 6. Commit Gate

Commit-time enforcement is mandatory because it is the last reliable checkpoint
before changes spread.

On `git commit`, `git merge`, or PR creation, Switchman should verify:

- every changed file is associated with a lease
- every changed file was claimed before modification
- the lease belonged to the committing worktree or agent
- stale or expired leases are rejected
- required checks for the affected files passed

This can be implemented as:

- a repo-installed git hook
- a CI job
- a Switchman-aware merge command

Even if runtime enforcement is bypassed, the commit gate prevents ungoverned
changes from landing silently.

### 7. Audit Log

Every relevant operation should be stored as an append-only event:

- lease started
- lease heartbeated
- file claimed
- write attempted
- write allowed
- write denied
- commit validated
- commit rejected
- lease expired

This provides:

- debugging
- trust
- compliance evidence
- postmortems
- better UI later

## User Experience

The user needs clear answers to two questions:

1. `Are my agents using Switchman right now?`
2. `If not, where is enforcement being bypassed?`

The UI/CLI should make this visible.

### Status should show

- managed agents
- unmanaged agents
- active leases
- claimed paths
- unclaimed changed paths
- denied writes
- stale sessions
- commit-gate failures

### Worktrees should have a compliance state

For example:

- `managed`
- `observed`
- `non_compliant`
- `stale`

This gives the user a simple answer without forcing them to inspect logs.

## Modes Of Operation

Enforcement should roll out in phases.

### 1. Advisory

Current behavior:

- leases and claims are recommended
- Switchman warns about conflicts
- no hard write blocking

### 2. Observed

New behavior:

- Switchman watches file mutations
- unclaimed writes are flagged
- commits can be blocked if desired

This is the safest first enforcement mode.

### 3. Guarded

Stronger behavior:

- Switchman-provided write tools are required for managed agents
- commit gate blocks non-compliant changes
- worktrees without leases are marked invalid

### 4. Strict

Strongest behavior:

- all writes in managed worktrees must go through Switchman
- unclaimed direct writes are blocked or immediately reverted
- only lease-backed commits are allowed

Strict mode is the end state for high-trust multi-agent environments.

## Minimum Viable Enforcement Roadmap

### Phase 1: Visibility

- add worktree compliance states
- detect and report unclaimed changed files
- add a commit gate that fails if changed files lack valid claims

This already answers the user question: "is this actually working?"

### Phase 2: Managed Agent Paths

- add Switchman-native write tools
- add wrapper-based launch mode for non-native agents
- attach every write operation to a lease and claim

This makes compliant paths easy and observable.

### Phase 3: Strong Commit Enforcement

- require lease-backed provenance for commits
- reject commits with unmanaged file edits
- attach validation metadata to changed paths

This prevents silent bypass at integration time.

### Phase 4: Runtime Hard Blocking

- add live filesystem monitoring
- deny or quarantine unclaimed writes in managed worktrees
- add policy exceptions for allowed generated outputs

This is the first true hard-enforcement layer.

## Open Design Questions

There are a few hard edges that need explicit policy:

- How should manual human edits in agent worktrees be treated?
- Should generated files require explicit claims or allow directory-level claims?
- How should large refactors spanning many files be represented safely?
- What is the right exception model for formatting, codegen, and refactors?
- Should enforcement operate at file level first, then evolve to symbol/region level?

The likely answer is to start with file-level enforcement and move to richer
ownership semantics later.

## Bottom Line

Without enforcement, Switchman depends on prompts and goodwill.

With enforcement, Switchman becomes the coordination control plane for code
mutation in a repository.

The required shift is:

- from `please use Switchman`
- to `writes, commits, and merges are only trusted when Switchman can verify them`

That is the path from a cooperative agent workflow to a real multi-agent
execution system.
