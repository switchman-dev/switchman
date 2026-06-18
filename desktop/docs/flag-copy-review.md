# Flag Copy For Review

These are review candidates, not final doctrine. Pick the tone and wording
before Phase 1 dogfooding.

## Predictive Check

Variant A:
> Starting "{new_task}" is likely to overlap with "{other_task}" ({other_agent}) on {file}. That lane is editing this file now.

Variant B:
> "{new_task}" touches {file}, which "{other_task}" ({other_agent}) is already working in. Start anyway only if you expect to reconcile those edits.

Variant C:
> Heads up: {file} is already in play. "{other_task}" ({other_agent}) has live edits there, so "{new_task}" may collide before it starts.

## Live Conflict Detail

Variant A:
> "{this_task}" conflicts with "{other_task}" ({other_agent}) on {file}. That lane is active, so merging now can leave two versions of the same file to reconcile.

Variant B:
> Both lanes have touched {file}: "{this_task}" and "{other_task}" ({other_agent}). Review the shared file before merging either side.

Variant C:
> Shared file: {file}. "{other_task}" ({other_agent}) is the lane to check before "{this_task}" moves forward.

## Merge-Time Interrupt

Variant A:
> Hold - {other_agent} is still in {file}. "{this_task}" conflicts with "{other_task}" on that file.

Variant B:
> Don't merge "{this_task}" yet. "{other_task}" ({other_agent}) is actively editing {file}.

Variant C:
> Separation conflict: "{this_task}" and "{other_task}" ({other_agent}) both touch {file}. Wait, or override knowing you'll reconcile by hand.

## Override Warning

Variant A:
> Overriding now merges "{this_task}" while "{other_task}" still has live edits touching {file}.

Variant B:
> If you override, Switchman will merge "{this_task}" and leave any live edits from "{other_task}" ({other_agent}) for manual reconciliation.

Variant C:
> Override only if you are ready to own the follow-up conflict in {file}.
