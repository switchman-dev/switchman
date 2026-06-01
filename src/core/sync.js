const EMPTY_SYNC_STATE = Object.freeze({
  pending: 0,
  oldest_queued_at: null,
  next_retry_at: null,
  last_error: null,
});

export async function pushSyncEvent() {
  return { ok: false, queued: false, reason: 'hosted_accounts_removed' };
}

export async function pullTeamState() {
  return [];
}

export async function pullActiveTeamMembers() {
  return [];
}

export async function pullTeamReviewShares() {
  return [];
}

export async function cleanupOldSyncEvents() {
  return null;
}

export function getPendingQueueCount() {
  return 0;
}

export function getPendingQueueStatus() {
  return { ...EMPTY_SYNC_STATE };
}

export async function flushPendingSyncEvents() {
  return {
    ok: false,
    reason: 'hosted_accounts_removed',
    attempted: 0,
    flushed: 0,
    remaining: 0,
  };
}
