const agents = {
  cc: { name: "Claude Code", tag: "CC", color: "#c08457" },
  cx: { name: "Codex", tag: "CX", color: "#7f93a8" },
  gm: { name: "Gemini", tag: "GM", color: "#6f8fd6" },
  ad: { name: "Aider", tag: "AD", color: "#8a9a5b" },
  ot: { name: "Other", tag: "OT", color: "#697586" },
};

const regions = {};

const columnDefs = [
  { key: "planning", title: "Planning", dot: "#3f4a59" },
  { key: "progress", title: "In progress", dot: "#5aa9bd" },
  { key: "review", title: "Review", dot: "#c0a04e" },
  { key: "done", title: "Done", dot: "#3f5947" },
];

const state = {
  selectedId: null,
  mergeOpen: false,
  confirmOverride: false,
  startCheckId: null,
  usesRegistry: true,
  registryPath: null,
  loadError: null,
  mergeError: null,
  cards: [],
};

const app = document.querySelector("#app");

function getCard(id) {
  return state.cards.find((card) => card.id === id);
}

function fmt(seconds) {
  if (seconds <= 0) return "0:00";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const minuteLabel = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${minuteLabel}:${String(secs).padStart(2, "0")}`;
}

function base(file) {
  return file ? file.split("/").at(-1) : "";
}

function regionMeta(file) {
  return regions[file] ?? { region: "", lines: "" };
}

function hasRegionData(file) {
  const meta = regionMeta(file);
  return Boolean(meta.region || meta.lines);
}

function activeOverlapSentence(agentName, file, taskName, { basenameOnly = false } = {}) {
  const path = basenameOnly ? base(file) : file;
  return `${agentName} is still editing ${path} for ${taskName}`;
}

function staleOverlapSentence(agentName, file, taskName, { basenameOnly = false } = {}) {
  const path = basenameOnly ? base(file) : file;
  return `${agentName} edited ${path} earlier for ${taskName}`;
}

function colLabel(col) {
  return columnDefs.find((column) => column.key === col)?.title ?? col;
}

function cssName(drift) {
  return drift === "active" || drift === "stale" || drift === "done" ? drift : "";
}

function laneVM(card, role) {
  if (!card) return null;
  const agent = agents[card.agent] ?? agents.ot;
  const live = card.running;
  const parked = card.elapsed > 0 && !live;
  return {
    role,
    title: card.title,
    agent,
    status: live ? "editing now" : parked ? "not running now" : "not started",
    statusClass: live ? "live" : "idle",
    time: card.elapsed > 0 ? fmt(card.elapsed) : card.col === "done" ? "merged" : "not started",
    col: colLabel(card.col),
  };
}

function cardTime(card) {
  if (card.drift === "done") return { label: "merged", cls: "idle" };
  if (card.elapsed <= 0) return { label: "not started", cls: "queued" };
  return { label: fmt(card.elapsed), cls: card.running ? "" : "idle" };
}

function renderAgent(agent) {
  return `
    <span class="agent-mark" style="background:${agent.color}">${agent.tag}</span>
    <span>${agent.name}</span>
  `;
}

function flagText(card) {
  const other = getCard(card.withId);
  const otherAgent = agents[other?.agent] ?? agents.ot;
  const otherTitle = other?.title ?? "another task";

  if (card.drift === "active") {
    return activeOverlapSentence(otherAgent.name, card.file, otherTitle, { basenameOnly: true });
  }

  return staleOverlapSentence(otherAgent.name, card.file, otherTitle, { basenameOnly: true });
}

function renderCard(card) {
  const agent = agents[card.agent] ?? agents.ot;
  const time = cardTime(card);
  const drift = cssName(card.drift);
  const selected = state.selectedId === card.id ? "selected" : "";
  const showActiveBadge = card.drift === "active";
  const showMerge = card.col === "review" && state.usesRegistry;

  return `
    <article class="lane-card ${drift} ${selected}" data-card-id="${card.id}">
      ${showActiveBadge ? `<div class="rail active calm"></div>` : ""}
      <div class="card-title">${card.title}</div>
      <div class="card-repo">${card.repo}</div>
      ${
        showActiveBadge
          ? `
            <div class="badge active">
              <span class="dot badge-dot-active"></span>
              <span>${flagText(card)}</span>
            </div>
          `
          : ""
      }
      ${
        card.drift === "stale"
          ? `<div class="stale-footnote">${flagText(card)}</div>`
          : ""
      }
      <div class="card-footer">
        <div class="agent">${renderAgent(agent)}</div>
        <div class="time ${time.cls}">${time.label}</div>
      </div>
      ${
        card.col === "planning" && !state.usesRegistry
          ? `<button class="start-btn" data-start-id="${card.id}" type="button">▷&nbsp; Start task</button>`
          : ""
      }
      ${
        showMerge
          ? `<button class="merge-btn" data-merge-id="${card.id}" type="button">Merge →</button>`
          : ""
      }
    </article>
  `;
}

function renderHeader() {
  const active = state.cards.filter((card) => card.drift === "active").length;
  const running = state.cards.filter((card) => card.running).length;
  const lanes = state.cards.filter((card) => card.drift !== "done").length;

  return `
    <header class="topbar">
      <div class="brand">
        <div class="repo-name">${state.usesRegistry ? "local tasks" : "payments-api"}</div>
        <div class="branch-chip mono">main</div>
      </div>
      <div class="stats">
        <div class="chip">TASKS <strong>${String(lanes).padStart(2, "0")}</strong></div>
        <div class="chip"><span class="dot dot-live"></span> RUNNING <strong>${String(running).padStart(2, "0")}</strong></div>
        ${
          active > 0
            ? `<div class="chip chip-active"><span class="dot dot-active"></span> EDITING SAME FILE <strong>${String(active).padStart(2, "0")}</strong></div>`
            : ""
        }
      </div>
    </header>
  `;
}

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
}

async function loadBoardSnapshot() {
  const invoke = tauriInvoke();
  if (!invoke) {
    state.cards = [];
    state.usesRegistry = false;
    return;
  }

  try {
    const snapshot = await invoke("get_board_snapshot");
    state.registryPath = snapshot.registryPath ?? null;
    state.loadError = snapshot.loadError ?? null;

    const selectedId = state.selectedId;
    state.cards = snapshot.sessions?.length ? cardsFromSnapshot(snapshot) : [];
    state.usesRegistry = true;
    state.selectedId = state.cards.some((card) => card.id === selectedId) ? selectedId : null;
    state.startCheckId = null;

    if (!state.selectedId) {
      state.mergeOpen = false;
      state.confirmOverride = false;
    }
  } catch (error) {
    state.loadError = String(error);
    state.cards = [];
  }
}

function cardsFromSnapshot(snapshot) {
  const overlapsBySession = new Map();
  const previousCards = new Map(state.cards.map((card) => [card.id, card]));

  for (const overlap of snapshot.overlaps ?? []) {
    addOverlap(overlapsBySession, overlap.sessionA, overlap.sessionB, overlap);
    addOverlap(overlapsBySession, overlap.sessionB, overlap.sessionA, overlap);
  }

  return snapshot.sessions.map((session) => {
    const overlap = overlapsBySession.get(session.id);
    const status = statusToCardState(session.status);
    const sharedFile = overlap?.sharedFiles?.[0] ?? session.filesTouched?.[0];
    const repo = repoLabel(session);
    const previous = previousCards.get(session.id);

    return {
      id: session.id,
      col: status.col,
      title: session.taskName,
      agent: agentKey(session.agent),
      repo,
      elapsed: status.running ? Math.max(previous?.elapsed ?? 0, 1) : previous?.elapsed ?? 0,
      running: session.live ?? status.running,
      drift: status.done ? "done" : overlap?.severity ?? "clear",
      file: sharedFile,
      withId: overlap?.otherId,
      branchName: session.branchName,
      worktreePath: session.worktreePath,
    };
  });
}

function addOverlap(overlapsBySession, sessionId, otherId, overlap) {
  const current = overlapsBySession.get(sessionId);
  if (current?.severity === "active") return;

  overlapsBySession.set(sessionId, {
    otherId,
    severity: overlap.severity,
    sharedFiles: overlap.sharedFiles,
  });
}

function statusToCardState(status) {
  switch (status) {
    case "planning":
      return { col: "planning", running: false, done: false };
    case "review":
      return { col: "review", running: false, done: false };
    case "paused":
      return { col: "progress", running: false, done: false };
    case "done":
      return { col: "done", running: false, done: true };
    case "in-progress":
    default:
      return { col: "progress", running: true, done: false };
  }
}

function agentKey(agent) {
  switch (agent) {
    case "claude-code":
      return "cc";
    case "codex":
      return "cx";
    case "gemini":
      return "gm";
    case "aider":
      return "ad";
    default:
      return "ot";
  }
}

function repoLabel(session) {
  if (session.branchName) return session.branchName;
  if (!session.worktreePath) return "local folder";

  return session.worktreePath
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join("/");
}

function renderBoard() {
  return `
    <div class="board-scroll">
      <div class="board">
        ${columnDefs
          .map((column) => {
            const cards = state.cards.filter((card) => card.col === column.key);
            return `
              <section class="column">
                <div class="column-header">
                  <div class="column-heading">
                    <span class="column-dot" style="background:${column.dot}"></span>
                    <span class="column-title">${column.title}</span>
                  </div>
                  <span class="column-count">${String(cards.length).padStart(2, "0")}</span>
                </div>
                <div class="column-body">${cards.map(renderCard).join("")}</div>
              </section>
            `;
          })
          .join("")}
      </div>
      ${renderEmptyState()}
    </div>
  `;
}

function renderEmptyState() {
  if (state.cards.length) return "";

  const detail = state.loadError
    ? `Could not read saved tasks: ${state.loadError}`
    : state.registryPath
      ? `Reading tasks from ${state.registryPath}`
      : "Waiting for tasks started with Switchman";

  return `
    <div class="empty-state">
      <div class="empty-title">No active tasks</div>
      <div class="empty-copy">${detail}</div>
      <div class="empty-command">Create git worktrees as usual — lanes appear here automatically.</div>
      <div class="empty-command subtle">switchman board</div>
    </div>
  `;
}

function renderMiniLane(lane, conflictClass = "") {
  return `
    <div class="mini-lane ${conflictClass}">
      <div class="mini-role">${lane.role} · ${lane.col}</div>
      <div class="mini-title">${lane.title}</div>
      <div class="mini-meta">
        <div class="agent">
          <span class="agent-mark" style="background:${lane.agent.color}">${lane.agent.tag}</span>
          <span class="lane-status"><span class="status-dot ${lane.statusClass}"></span>${lane.status}</span>
        </div>
        <span class="time">${lane.time}</span>
      </div>
    </div>
  `;
}

function renderPanel() {
  const selected = getCard(state.selectedId);
  if (!selected?.withId || selected.drift !== "active") return "";
  const other = getCard(selected.withId);
  const active = selected.drift === "active";
  const conflict = active ? "active" : "stale";
  const accent = active ? "#f47a44" : "#b0863f";
  const region = regionMeta(selected.file);
  const otherAgent = agents[other.agent] ?? agents.ot;
  const blockerLine = active
    ? `${activeOverlapSentence(otherAgent.name, selected.file, other.title)}.`
    : `${staleOverlapSentence(otherAgent.name, selected.file, other.title)}.`;
  const note = active
    ? `Merging ${selected.title} now can leave two versions of ${selected.file} to reconcile.`
    : `Review or rebase before merging ${selected.title}.`;

  return `
    <aside class="side-panel">
      <div class="panel-head">
        <div class="state-pill ${conflict}">
          <span class="dot ${active ? "dot-active" : "dot-stale"}"></span>
          ${active ? "BEING EDITED NOW" : "EDITED EARLIER"}
        </div>
        <button class="icon-btn" data-close-panel type="button">✕</button>
      </div>
      <div class="panel-body">
        <section>
          <div class="eyebrow">SHARED FILE</div>
          <div class="shared-file">${selected.file}</div>
          ${
            hasRegionData(selected.file)
              ? `
            <div class="inline-chips">
              <span class="small-chip">${region.region}</span>
              <span class="small-chip">${region.lines}</span>
            </div>
          `
              : ""
          }
        </section>
        ${
          hasRegionData(selected.file)
            ? `
        <section>
          <div class="map-head"><span>TOUCHED AREA</span><span>${region.lines}</span></div>
          <div class="track"><div class="range range-a"></div><div class="contested ${conflict}"></div></div>
          <div class="track"><div class="range range-b"></div><div class="contested ${conflict}"></div></div>
          <div class="map-legend"><span>this task</span><span class="${conflict}">shared lines</span><span>other task</span></div>
        </section>
        `
            : ""
        }
        <section class="lane-stack">
          ${renderMiniLane(laneVM(selected, "THIS TASK"))}
          <div class="contends"><span style="color:${accent}">also touches</span><div></div></div>
          ${renderMiniLane(laneVM(other, "OTHER TASK"), `conflict ${conflict}`)}
        </section>
        <div class="panel-note">${blockerLine} ${note}</div>
      </div>
      <div class="panel-actions">
        <div class="action-row">
          <button class="secondary-btn" data-open-diff type="button">Open diff</button>
        </div>
        <button class="primary-btn" data-open-merge type="button">Merge this task →</button>
        <div class="merge-note" style="color:${active ? "#ff9a6b" : "#cda05a"}">
          ${blockerLine}
        </div>
      </div>
    </aside>
  `;
}

function renderStartModal() {
  const card = getCard(state.startCheckId);
  if (!card?.pWith) return "";
  const other = getCard(card.pWith);
  const high = Boolean(other?.running);
  const accent = high ? "#f47a44" : "#b0863f";
  const region = regionMeta(card.pFile);
  const otherAgent = agents[other.agent] ?? agents.ot;
  const sentence = `Starting ${card.title} may touch the same file as ${other.title} (${otherAgent.name}) on ${card.pFile}. ${other.title} is ${
    high ? "editing this file now" : "not running now, but edited this file earlier"
  }.`;
  const note = high
    ? `${other.title} (${otherAgent.name}) is already editing ${card.pFile}. Starting ${card.title} may put two agents in the same file.`
    : `${other.title} (${otherAgent.name}) edited ${card.pFile} earlier but is not running now.`;

  return `
    <div class="modal-veil" style="--modal-accent:${accent}">
      <section class="modal">
        <div class="dashed-strip"></div>
        <div class="modal-body">
          <div class="predicted-pill"><span class="ring-dot"></span>MAY TOUCH THE SAME FILE</div>
          <div class="modal-title">This task may touch the same file</div>
          <div class="modal-copy">${sentence}</div>
          <div class="file-inset">
            <div class="inset-top">
              <span class="file-name">${card.pFile}</span>
              <span class="likelihood"><span class="ring-dot"></span>${high ? "High" : "Moderate"} likelihood</span>
            </div>
            ${hasRegionData(card.pFile) ? `<div class="inset-sub">${region.region} · ${region.lines}</div>` : ""}
          </div>
          ${renderMiniLane(laneVM(other, `${otherAgent.name.toUpperCase()} TASK`))}
          <div class="modal-note" style="margin:16px 0 18px">${note}</div>
          <div class="modal-actions">
            <button class="primary-btn" data-start-anyway type="button">Start anyway →</button>
            <button class="outline-btn" data-reassign type="button">Reassign</button>
            <button class="outline-btn muted" data-close-start type="button">Not now</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderMergeModal() {
  const selected = getCard(state.selectedId);
  if (!state.mergeOpen || !selected) return "";
  const other = selected.withId ? getCard(selected.withId) : null;
  const region = regionMeta(selected.file);
  const selectedLane = laneVM(selected, "MERGE TARGET");
  const otherLane = other ? laneVM(other, "EDITING NOW") : null;
  const blockerAgent = other ? agents[other.agent] ?? agents.ot : agents.ot;
  const blockerLine =
    state.mergeError ??
    (other && selected.file
      ? `${activeOverlapSentence(blockerAgent.name, selected.file, other.title)}.`
      : "Another lane is still editing a shared file.");

  return `
    <div class="modal-veil heavy">
      <section class="modal merge">
        <div class="sweep-strip"><div></div></div>
        <div class="modal-body">
          <div class="conflict-pill"><span class="dot dot-active"></span>SAME FILE STILL OPEN</div>
          <div class="modal-title">Hold — ${blockerLine.replace(/\.$/, "")}</div>
          <div class="modal-copy">
            You're merging <span style="color:#dbe2ea">${selected.title}</span> into <span class="mono" style="color:#dbe2ea">main</span>.
            Wait until that task finishes, or override knowing you'll reconcile <span class="mono" style="color:#dbe2ea">${selected.file}</span> by hand.
          </div>
          <div class="merge-lanes">
            <div class="merge-side">
              <div class="merge-role">${selectedLane.role}</div>
              <div class="merge-title">${selectedLane.title}</div>
              <div class="merge-agent">${renderAgent(selectedLane.agent)}</div>
            </div>
            ${
              otherLane
                ? `
            <div class="merge-cell">⇄</div>
            <div class="merge-side blocker">
              <div class="merge-role"><span class="dot dot-live"></span>${otherLane.role}</div>
              <div class="merge-title">${otherLane.title}</div>
              <div class="mini-meta">
                <div class="merge-agent">${renderAgent(otherLane.agent)}</div>
                <span class="time" style="color:#ff9a6b">${otherLane.time}</span>
              </div>
            </div>
            `
                : ""
            }
          </div>
          ${
            selected.file
              ? `
          <div class="merge-file">
            <span class="file-name">${selected.file}</span>
            ${
              hasRegionData(selected.file)
                ? `<span class="small-chip">${region.region}</span><span class="line">${region.lines}</span>`
                : ""
            }
          </div>
          `
              : ""
          }
          <div class="merge-actions">
            <button class="primary-btn" data-close-merge type="button">Wait for that task</button>
            ${
              state.confirmOverride
                ? `<button class="danger-btn" data-do-merge type="button">Merge anyway →</button>`
                : `<button class="outline-btn muted" data-toggle-override type="button">I understand, merge anyway</button>`
            }
          </div>
          ${
            state.confirmOverride && other
              ? `<div class="warning-line">Merging now will include ${selected.title} while ${activeOverlapSentence(blockerAgent.name, selected.file, other.title)}.</div>`
              : ""
          }
          ${
            state.mergeError && state.mergeError !== blockerLine
              ? `<div class="warning-line">${state.mergeError}</div>`
              : ""
          }
          <div class="scope-line">Flags exact file overlaps between lanes. It will not catch related changes in different files.</div>
        </div>
      </section>
    </div>
  `;
}

function render() {
  app.innerHTML = `
    ${renderHeader()}
    <main class="main">
      ${renderBoard()}
      ${renderPanel()}
    </main>
    ${renderStartModal()}
    ${renderMergeModal()}
  `;
}

function startLane(id) {
  const card = getCard(id);
  if (!card) return;
  if (card.pStart && card.pWith) {
    state.startCheckId = id;
  } else {
    doStart(id);
  }
  render();
}

function doStart(id) {
  const card = getCard(id);
  if (!card) return;
  const other = getCard(card.pWith);
  card.col = "progress";
  card.running = true;
  card.elapsed = 1;
  if (card.pWith) {
    card.file = card.pFile;
    card.withId = card.pWith;
    card.drift = other?.running ? "active" : "stale";
  }
  card.pStart = false;
  state.startCheckId = null;
  state.selectedId = id;
}

function reassignLane() {
  const card = getCard(state.startCheckId);
  if (!card) return;
  const order = ["cc", "cx", "gm", "ad"];
  card.agent = order[(order.indexOf(card.agent) + 1) % order.length];
  state.startCheckId = null;
}

async function beginMerge(id) {
  state.selectedId = id;
  state.mergeOpen = false;
  state.confirmOverride = false;
  state.mergeError = null;
  await doMerge();
}

async function openDiff() {
  const selected = getCard(state.selectedId);
  if (!selected) return;

  const invoke = tauriInvoke();
  if (!invoke) return;

  try {
    await invoke("open_overlap_diff", {
      sessionId: selected.id,
      file: selected.file ?? null,
    });
  } catch (error) {
    state.mergeError = String(error);
    render();
  }
}

async function doMerge() {
  const selected = getCard(state.selectedId);
  if (!selected) return;

  if (state.usesRegistry) {
    const invoke = tauriInvoke();
    if (!invoke) return;

    try {
      const result = await invoke("merge_session", {
        sessionId: selected.id,
        overrideSeparation: state.confirmOverride,
      });

      if (result.status === "blocked") {
        state.mergeOpen = true;
        state.confirmOverride = false;
        state.mergeError = result.message;
        render();
        return;
      }

      if (result.status === "merged") {
        state.mergeOpen = false;
        state.confirmOverride = false;
        state.mergeError = null;
        state.selectedId = null;
        await loadBoardSnapshot();
        render();
        return;
      }

      state.mergeError = result.message;
      render();
    } catch (error) {
      state.mergeError = String(error);
      render();
    }
    return;
  }

  const other = getCard(selected.withId);
  selected.col = "done";
  selected.drift = "done";
  selected.running = false;
  selected.withId = undefined;
  if (other?.withId === selected.id) {
    other.drift = "clear";
    other.withId = undefined;
    other.file = undefined;
  }
  state.mergeOpen = false;
  state.confirmOverride = false;
  state.mergeError = null;
  state.selectedId = null;
}

app.addEventListener("click", (event) => {
  const merge = event.target.closest("[data-merge-id]");
  if (merge) {
    event.stopPropagation();
    void beginMerge(merge.dataset.mergeId);
    return;
  }

  const start = event.target.closest("[data-start-id]");
  if (start) {
    event.stopPropagation();
    startLane(start.dataset.startId);
    return;
  }

  const card = event.target.closest("[data-card-id]");
  if (card) {
    const clicked = card.dataset.cardId;
    const lane = getCard(clicked);
    const opensPanel = lane?.withId && lane.drift === "active";
    state.selectedId =
      state.selectedId === clicked || !opensPanel ? null : clicked;
    state.mergeOpen = false;
    state.confirmOverride = false;
    render();
    return;
  }

  if (event.target.closest("[data-close-panel]")) {
    state.selectedId = null;
    state.mergeOpen = false;
    render();
    return;
  }

  if (event.target.closest("[data-open-merge]")) {
    void beginMerge(state.selectedId);
    return;
  }

  if (event.target.closest("[data-open-diff]")) {
    void openDiff();
    return;
  }

  if (event.target.closest("[data-close-merge]")) {
    state.mergeOpen = false;
    state.confirmOverride = false;
    state.mergeError = null;
    render();
    return;
  }

  if (event.target.closest("[data-toggle-override]")) {
    state.confirmOverride = true;
    render();
    return;
  }

  if (event.target.closest("[data-do-merge]")) {
    void doMerge();
    return;
  }

  if (event.target.closest("[data-close-start]")) {
    state.startCheckId = null;
    render();
    return;
  }

  if (event.target.closest("[data-start-anyway]")) {
    doStart(state.startCheckId);
    render();
    return;
  }

  if (event.target.closest("[data-reassign]")) {
    reassignLane();
    render();
  }
});

setInterval(() => {
  state.cards.forEach((card) => {
    if (card.running) card.elapsed += 1;
  });
  render();
}, 1000);

setInterval(() => {
  void loadBoardSnapshot().then(render);
}, 2500);

await loadBoardSnapshot();
render();
