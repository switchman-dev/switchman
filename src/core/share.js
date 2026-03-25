/**
 * switchman public share module
 * Handles creating and retrieving public read-only review URLs.
 *
 * Public reviews are stored in the `public_reviews` Supabase table.
 * They contain no source code — only session metadata, narrative,
 * confidence score, metrics, and semantic conflict summaries.
 *
 * A public review URL looks like: https://switchman.dev/review/:id
 *
 * Usage:
 *   const { id, url } = await createPublicReview(report);
 */

const SUPABASE_URL = process.env.SWITCHMAN_SUPABASE_URL
  ?? 'https://afilbolhlkiingnsupgr.supabase.co';

const SUPABASE_ANON = process.env.SWITCHMAN_SUPABASE_ANON
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmaWxib2xobGtpaW5nbnN1cGdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTIzOTIsImV4cCI6MjA4OTE2ODM5Mn0.8TBfHfRB0vEyKPMWBd6i1DNwx1nS9UqprIAsJf35n88';

const PUBLIC_REVIEWS_URL = `${SUPABASE_URL}/rest/v1/public_reviews`;
const REVIEW_BASE_URL = 'https://switchman.dev/review';

/**
 * Strips any sensitive fields from a session report before publishing.
 * Only metadata safe to share publicly is included.
 */
function sanitizeReport(report) {
  return {
    generated_at: report.generated_at ?? new Date().toISOString(),
    hours: report.hours ?? 8,
    merge_confidence: report.merge_confidence ?? 'uncertain',
    narrative: report.narrative ?? '',
    metrics: {
      tasks_completed: report.metrics?.tasks_completed ?? 0,
      retries_scheduled: report.metrics?.retries_scheduled ?? 0,
      rogue_writes_blocked: report.metrics?.rogue_writes_blocked ?? 0,
      queue_blocks_avoided: report.metrics?.queue_blocks_avoided ?? 0,
      queue_merges_completed: report.metrics?.queue_merges_completed ?? 0,
      live_semantic_conflicts: report.metrics?.live_semantic_conflicts ?? 0,
    },
    // Semantic conflicts: include type and file paths but not content
    semantic_conflicts: (report.semantic_conflicts ?? []).slice(0, 5).map((c) => ({
      type: c.type ?? 'unknown',
      object_name: c.object_name ?? null,
      worktreeA: c.worktreeA ?? 'agent-1',
      worktreeB: c.worktreeB ?? 'agent-2',
      fileA: c.fileA ?? null,
      fileB: c.fileB ?? null,
    })),
    // Agent summaries: strip task IDs, keep narrative and counts
    agent_summaries: (report.agent_summaries ?? []).slice(0, 6).map((a) => ({
      agent: a.agent ?? 'agent',
      task_count: a.task_count ?? 0,
      narrative: a.narrative ?? '',
    })),
  };
}

/**
 * Creates a public read-only review and returns its id and URL.
 * Returns { ok: true, id, url } or { ok: false, error }
 */
export async function createPublicReview(report) {
  const payload = sanitizeReport(report);

  try {
    const res = await fetch(PUBLIC_REVIEWS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
        'Authorization': `Bearer ${SUPABASE_ANON}`,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        payload,
        created_at: new Date().toISOString(),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Server returned ${res.status}${text ? `: ${text}` : ''}` };
    }

    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : rows;

    if (!row?.id) {
      return { ok: false, error: 'No id returned from server' };
    }

    return {
      ok: true,
      id: row.id,
      url: `${REVIEW_BASE_URL}/${row.id}`,
    };
  } catch (err) {
    return { ok: false, error: err.message ?? 'Network error' };
  }
}

/**
 * Fetches a public review by id.
 * Returns { ok: true, payload } or { ok: false, error }
 */
export async function getPublicReview(id) {
  try {
    const res = await fetch(
      `${PUBLIC_REVIEWS_URL}?id=eq.${encodeURIComponent(id)}&select=id,payload,created_at`,
      {
        headers: {
          'apikey': SUPABASE_ANON,
          'Authorization': `Bearer ${SUPABASE_ANON}`,
        },
      },
    );

    if (!res.ok) return { ok: false, error: `Server returned ${res.status}` };

    const rows = await res.json();
    const row = rows?.[0];

    if (!row) return { ok: false, error: 'Review not found' };

    return { ok: true, id: row.id, payload: row.payload, created_at: row.created_at };
  } catch (err) {
    return { ok: false, error: err.message ?? 'Network error' };
  }
}