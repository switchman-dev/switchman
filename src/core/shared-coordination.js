const DISABLED = Object.freeze({
  enabled: false,
  reason: 'hosted_accounts_removed',
});

function disabledOperation() {
  return {
    ok: false,
    shared: false,
    reason: DISABLED.reason,
  };
}

export async function createSharedTask() {
  return disabledOperation();
}

export async function listSharedTasks() {
  return disabledOperation();
}

export async function listSharedLeases() {
  return disabledOperation();
}

export async function listSharedClaims() {
  return disabledOperation();
}

export async function getSharedStatusSnapshot() {
  return disabledOperation();
}

export async function acquireSharedNextLease() {
  return disabledOperation();
}

export async function acquireSharedTaskLease() {
  return disabledOperation();
}

export async function claimSharedFiles() {
  return disabledOperation();
}

export async function releaseSharedClaims() {
  return disabledOperation();
}

export async function completeSharedTask() {
  return disabledOperation();
}

export async function failSharedTask() {
  return disabledOperation();
}

export async function retrySharedTask() {
  return disabledOperation();
}

export async function recoverSharedAbandonedWork() {
  return disabledOperation();
}

export async function dispatchSharedReadyTasks() {
  return disabledOperation();
}

export async function getSharedCoordinationMode() {
  return { ...DISABLED };
}
