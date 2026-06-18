use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    ClaudeCode,
    Codex,
    Gemini,
    Aider,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Planning,
    InProgress,
    Paused,
    Review,
    Done,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlapSeverity {
    Active,
    Stale,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSession {
    pub id: String,
    pub task_name: String,
    pub agent: AgentKind,
    pub repo_root: String,
    pub base_ref: String,
    pub worktree_path: String,
    pub branch_name: String,
    pub status: SessionStatus,
    pub files_touched: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_pid: Option<u32>,
    pub live: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlap {
    pub id: String,
    pub session_a: String,
    pub session_b: String,
    pub shared_files: Vec<String>,
    pub severity: OverlapSeverity,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSnapshot {
    pub source: String,
    pub registry_path: Option<String>,
    pub load_error: Option<String>,
    pub sessions: Vec<WorktreeSession>,
    pub overlaps: Vec<Overlap>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeBlocker {
    pub session_id: String,
    pub task_name: String,
    pub agent: AgentKind,
    pub shared_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MergeStatus {
    Blocked,
    Merged,
    NotFound,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub status: MergeStatus,
    pub session_id: String,
    pub blockers: Vec<MergeBlocker>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    sessions: Vec<RegistrySession>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrySession {
    id: String,
    #[serde(alias = "task_name")]
    task_name: String,
    agent: String,
    #[serde(default, alias = "repo_root")]
    repo_root: String,
    #[serde(default, alias = "base_ref")]
    base_ref: String,
    #[serde(alias = "worktree_path")]
    worktree_path: String,
    #[serde(default, alias = "branch_name")]
    branch_name: String,
    status: String,
    #[serde(default, alias = "files_touched")]
    files_touched: Vec<String>,
    #[serde(default, alias = "agent_pid")]
    agent_pid: Option<u32>,
    #[serde(default, alias = "registered_by")]
    registered_by: Option<String>,
}

#[derive(Debug)]
struct DiscoveredWorktree {
    repo_root: String,
    worktree_path: String,
    branch_name: String,
    base_ref: String,
}

fn board_roots_path() -> PathBuf {
    if let Ok(path) = env::var("SWITCHMAN_BOARD_ROOTS_FILE") {
        return PathBuf::from(path);
    }

    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".switchman")
        .join("board-roots.json")
}

fn read_board_roots() -> Vec<PathBuf> {
    let path = board_roots_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };

    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };

    let repos = if let Some(array) = value.as_array() {
        array.clone()
    } else {
        value
            .get("repos")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
    };

    repos
        .into_iter()
        .filter_map(|entry| entry.as_str().map(PathBuf::from))
        .collect()
}

fn collect_board_repo_roots(registry_value: &serde_json::Value) -> Vec<PathBuf> {
    let mut repos: HashSet<PathBuf> = read_board_roots().into_iter().collect();

    let sessions = if registry_value.is_array() {
        registry_value.as_array().cloned().unwrap_or_default()
    } else {
        registry_value
            .get("sessions")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
    };

    for session in sessions {
        if let Some(repo_root) = session.get("repoRoot").and_then(serde_json::Value::as_str) {
            if !repo_root.is_empty() {
                repos.insert(PathBuf::from(repo_root));
            }
        }
    }

    repos.into_iter().collect()
}

fn discover_worktrees_for_repo(repo_root: &Path) -> Result<Vec<DiscoveredWorktree>, String> {
    if !repo_root.exists() {
        return Ok(Vec::new());
    }

    let output = Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut discovered = Vec::new();
    let mut main_branch = "main".to_string();

    for block in text.split("\n\n") {
        if block.trim().is_empty() {
            continue;
        }

        let mut worktree_path = None;
        let mut branch_name = None;
        let mut is_bare = false;

        for line in block.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                worktree_path = Some(path.to_string());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                branch_name = Some(branch.replace("refs/heads/", ""));
            } else if line == "bare" {
                is_bare = true;
            }
        }

        let Some(worktree_path) = worktree_path else {
            continue;
        };

        if is_bare {
            continue;
        }

        let normalized_repo = fs::canonicalize(repo_root)
            .unwrap_or_else(|_| repo_root.to_path_buf());
        let normalized_worktree = fs::canonicalize(&worktree_path)
            .unwrap_or_else(|_| PathBuf::from(&worktree_path));

        if normalized_worktree == normalized_repo {
            if let Some(branch) = branch_name.clone() {
                main_branch = branch;
            }
            continue;
        }

        discovered.push(DiscoveredWorktree {
            repo_root: normalized_repo.display().to_string(),
            worktree_path: normalized_worktree.display().to_string(),
            branch_name: branch_name.unwrap_or_else(|| {
                normalized_worktree
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("lane")
                    .to_string()
            }),
            base_ref: main_branch.clone(),
        });
    }

    Ok(discovered)
}

fn slugify_branch(value: &str) -> String {
    let slug: String = value
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        format!("lane-{}", unique_suffix())
    } else {
        trimmed.to_string()
    }
}

fn humanize_branch(branch_name: &str) -> String {
    branch_name
        .trim_start_matches("switchman/")
        .replace(['-', '_', '/'], " ")
        .trim()
        .to_string()
}

fn sync_discovered_worktrees(registry_path: &Path) -> Result<(), String> {
    let _lock = RegistryLock::acquire(registry_path)?;
    let mut registry_value = if registry_path.exists() {
        read_registry_value_unlocked(registry_path).map_err(|error| error.to_string())?
    } else {
        serde_json::json!({ "sessions": [] })
    };

    if registry_value.is_array() {
        registry_value = serde_json::json!({ "sessions": registry_value });
    }

    let repo_roots = collect_board_repo_roots(&registry_value);

    let sessions = registry_value
        .get_mut("sessions")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| "registry must include sessions[]".to_string())?;

    let mut discovered_entries = Vec::new();

    for repo_root in repo_roots {
        discovered_entries.extend(discover_worktrees_for_repo(&repo_root)?);
    }

    let mut changed = false;
    let mut discovered_paths: HashSet<String> = HashSet::new();

    for worktree in discovered_entries {
        discovered_paths.insert(worktree.worktree_path.clone());
        let id = slugify_branch(&worktree.branch_name);
        let task_name = humanize_branch(&worktree.branch_name);
        let files_touched = git_touched_files(&worktree.worktree_path).unwrap_or_default();
        let status = if worktree_recently_active(&worktree.worktree_path, &files_touched) {
            "in-progress"
        } else if files_touched.is_empty() {
            "planning"
        } else {
            "review"
        };

        if let Some(existing) = sessions.iter_mut().find(|session| {
            session.get("worktreePath").and_then(serde_json::Value::as_str)
                == Some(worktree.worktree_path.as_str())
        }) {
            let Some(object) = existing.as_object_mut() else {
                continue;
            };

            let registered_by = object
                .get("registeredBy")
                .or_else(|| object.get("registered_by"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("cli")
                .to_string();

            object.insert("repoRoot".to_string(), serde_json::json!(worktree.repo_root));
            object.insert("baseRef".to_string(), serde_json::json!(worktree.base_ref));
            object.insert("branchName".to_string(), serde_json::json!(worktree.branch_name));
            object.insert("worktreePath".to_string(), serde_json::json!(worktree.worktree_path));
            object.insert("filesTouched".to_string(), serde_json::json!(files_touched));
            object.insert("updatedAt".to_string(), serde_json::json!(chrono_like_timestamp()));

            if registered_by == "discovered" {
                object.insert("taskName".to_string(), serde_json::json!(task_name));
                object.insert("agent".to_string(), serde_json::json!("other"));
                object.insert("status".to_string(), serde_json::json!(status));
                object.insert("registeredBy".to_string(), serde_json::json!("discovered"));
            } else if object.get("status").and_then(serde_json::Value::as_str) == Some("in-progress")
                || object.get("status").and_then(serde_json::Value::as_str) == Some("planning")
            {
                object.insert("status".to_string(), serde_json::json!(status));
            }

            changed = true;
            continue;
        }

        sessions.push(serde_json::json!({
            "id": id,
            "taskName": if task_name.is_empty() { "parallel lane" } else { task_name.as_str() },
            "agent": "other",
            "repoRoot": worktree.repo_root,
            "baseRef": worktree.base_ref,
            "worktreePath": worktree.worktree_path,
            "branchName": worktree.branch_name,
            "status": status,
            "filesTouched": files_touched,
            "registeredBy": "discovered",
            "createdAt": chrono_like_timestamp(),
            "updatedAt": chrono_like_timestamp(),
        }));
        changed = true;
    }

    let before = sessions.len();
    sessions.retain(|session| {
        let registered_by = session
            .get("registeredBy")
            .or_else(|| session.get("registered_by"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("cli");

        if registered_by != "discovered" {
            return true;
        }

        session
            .get("worktreePath")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|path| discovered_paths.contains(path))
    });

    if sessions.len() != before {
        changed = true;
    }

    if changed {
        write_registry_value_unlocked(registry_path, &registry_value)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_board_snapshot() -> BoardSnapshot {
    let registry_path = registry_path();
    let _ = sync_discovered_worktrees(&registry_path);

    match read_registry(&registry_path) {
        Ok(sessions) => {
            let overlaps = compute_overlaps(&sessions);
            BoardSnapshot {
                source: "cli-registry".to_string(),
                registry_path: Some(registry_path.display().to_string()),
                load_error: None,
                sessions,
                overlaps,
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            empty_snapshot(registry_path, None)
        }
        Err(error) => empty_snapshot(registry_path, Some(error.to_string())),
    }
}

#[tauri::command]
pub fn merge_session(session_id: String, override_separation: bool) -> Result<MergeResult, String> {
    let registry_path = registry_path();
    let _lock = RegistryLock::acquire(&registry_path)?;
    let mut registry_value =
        read_registry_value_unlocked(&registry_path).map_err(|error| error.to_string())?;
    let sessions =
        load_sessions_unlocked(&registry_path, &mut registry_value).map_err(|error| error.to_string())?;

    let Some(session) = sessions.iter().find(|session| session.id == session_id) else {
        return Ok(MergeResult {
            status: MergeStatus::NotFound,
            session_id,
            blockers: Vec::new(),
            message: "No registered session matched this merge request.".to_string(),
        });
    };

    let blockers = active_merge_blockers(session, &sessions);

    if !blockers.is_empty() && !override_separation {
        let message = merge_blocked_message(&blockers);

        return Ok(MergeResult {
            status: MergeStatus::Blocked,
            session_id,
            blockers,
            message,
        });
    }

    perform_git_merge(session)?;
    update_registry_status(&mut registry_value, &session_id, "done")?;
    write_registry_value_unlocked(&registry_path, &registry_value)
        .map_err(|error| error.to_string())?;

    Ok(MergeResult {
        status: MergeStatus::Merged,
        session_id,
        blockers,
        message: "Session merged.".to_string(),
    })
}

#[tauri::command]
pub fn open_overlap_diff(session_id: String, file: Option<String>) -> Result<String, String> {
    let registry_path = registry_path();
    let sessions = read_registry(&registry_path).map_err(|error| error.to_string())?;
    let overlaps = compute_overlaps(&sessions);

    let Some(session) = sessions.iter().find(|session| session.id == session_id) else {
        return Err("No registered session matched this diff request.".to_string());
    };

    let Some(overlap) = overlaps
        .iter()
        .find(|overlap| overlap.session_a == session_id || overlap.session_b == session_id)
    else {
        return Err("This session does not share a file with another lane.".to_string());
    };

    let other_id = if overlap.session_a == session_id {
        &overlap.session_b
    } else {
        &overlap.session_a
    };

    let Some(other) = sessions.iter().find(|candidate| candidate.id == *other_id) else {
        return Err("Could not resolve the other lane for this overlap.".to_string());
    };

    let shared_file = file
        .or_else(|| overlap.shared_files.first().cloned())
        .ok_or_else(|| "No shared file was available for diff.".to_string())?;

    let left_path = Path::new(&session.worktree_path).join(&shared_file);
    let right_path = Path::new(&other.worktree_path).join(&shared_file);

    if !left_path.is_file() || !right_path.is_file() {
        return Err(format!(
            "Shared file is not present in both worktrees: {shared_file}"
        ));
    }

    launch_diff_viewer(&left_path, &right_path, &shared_file)
}

fn launch_diff_viewer(left_path: &Path, right_path: &Path, shared_file: &str) -> Result<String, String> {
    let left = left_path.display().to_string();
    let right = right_path.display().to_string();

    if let Ok(template) = env::var("SWITCHMAN_DIFF_CMD") {
        let command = template.replace("{left}", &left).replace("{right}", &right);
        let output = Command::new("sh")
            .args(["-c", &command])
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            return Ok(format!("Opened diff for {shared_file}."));
        }
        return Err(command_error(output));
    }

    for editor in ["cursor", "code"] {
        if !command_available(editor) {
            continue;
        }

        let output = Command::new(editor)
            .arg("--diff")
            .arg(&left)
            .arg(&right)
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            return Ok(format!("Opened diff for {shared_file} in {editor}."));
        }
    }

    let diff = Command::new("git")
        .args(["diff", "--no-index", "--", &left, &right])
        .output()
        .map_err(|error| error.to_string())?;

    let diff_text = if diff.stdout.is_empty() && !diff.stderr.is_empty() {
        String::from_utf8_lossy(&diff.stderr).to_string()
    } else {
        String::from_utf8_lossy(&diff.stdout).to_string()
    };

    let temp_path = env::temp_dir().join(format!(
        "switchman-diff-{}-{}.diff",
        shared_file.replace('/', "-"),
        unique_suffix()
    ));
    fs::write(&temp_path, &diff_text).map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    {
        let opened = Command::new("open")
            .arg(&temp_path)
            .output()
            .map_err(|error| error.to_string())?;
        if !opened.status.success() {
            return Err(command_error(opened));
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        return Ok(format!(
            "Diff written to {}. Set SWITCHMAN_DIFF_CMD or install cursor/code.",
            temp_path.display()
        ));
    }

    Ok(format!(
        "Opened diff for {shared_file}. Set SWITCHMAN_DIFF_CMD to use your editor."
    ))
}

fn command_available(name: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {name}")])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn registry_path() -> PathBuf {
    if let Ok(path) = env::var("SWITCHMAN_SESSION_REGISTRY") {
        return PathBuf::from(path);
    }

    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".switchman")
        .join("sessions.json")
}

fn empty_snapshot(registry_path: PathBuf, load_error: Option<String>) -> BoardSnapshot {
    BoardSnapshot {
        source: "cli-registry".to_string(),
        registry_path: Some(registry_path.display().to_string()),
        load_error,
        sessions: Vec::new(),
        overlaps: Vec::new(),
    }
}

fn load_sessions_unlocked(
    registry_path: &Path,
    registry_value: &mut serde_json::Value,
) -> std::io::Result<Vec<WorktreeSession>> {
    let mut sessions = sessions_from_value(registry_value)?;
    refresh_files_touched(&mut sessions);

    if reconcile_sessions_liveness(&mut sessions) {
        apply_sessions_to_registry(registry_value, &sessions)?;
        write_registry_value_unlocked(registry_path, registry_value)?;
    } else {
        for session in &mut sessions {
            session.live = is_session_live(session);
        }
    }

    Ok(sessions)
}

fn read_registry(path: &Path) -> std::io::Result<Vec<WorktreeSession>> {
    let _lock = RegistryLock::acquire(path).map_err(std::io::Error::other)?;
    let mut value = read_registry_value_unlocked(path)?;
    load_sessions_unlocked(path, &mut value)
}

fn read_registry_value(path: &Path) -> std::io::Result<serde_json::Value> {
    let _lock = RegistryLock::acquire(path).map_err(std::io::Error::other)?;
    read_registry_value_unlocked(path)
}

fn read_registry_value_unlocked(path: &Path) -> std::io::Result<serde_json::Value> {
    let text = fs::read_to_string(path)?;
    serde_json::from_str::<serde_json::Value>(&text).map_err(invalid_data)
}

fn sessions_from_value(value: &serde_json::Value) -> std::io::Result<Vec<WorktreeSession>> {
    let raw_sessions = if value.is_array() {
        serde_json::from_value::<Vec<RegistrySession>>(value.clone()).map_err(invalid_data)?
    } else {
        serde_json::from_value::<RegistryFile>(value.clone())
            .map_err(invalid_data)?
            .sessions
    };

    Ok(raw_sessions
        .into_iter()
        .map(WorktreeSession::from)
        .collect())
}

fn invalid_data(error: serde_json::Error) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, error)
}

fn write_registry_value_unlocked(path: &Path, value: &serde_json::Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let text = serde_json::to_string_pretty(value).map_err(invalid_data)?;
    let tmp_path = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("sessions.json"),
        unique_suffix()
    ));
    fs::write(&tmp_path, format!("{text}\n"))?;
    fs::rename(tmp_path, path)
}

struct RegistryLock {
    path: PathBuf,
}

impl RegistryLock {
    fn acquire(registry_path: &Path) -> Result<Self, String> {
        let lock_path = PathBuf::from(format!("{}.lock", registry_path.display()));
        if let Some(parent) = lock_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        let deadline = Instant::now() + Duration::from_millis(lock_timeout_ms());

        loop {
            match fs::create_dir(&lock_path) {
                Ok(()) => {
                    let owner = serde_json::json!({
                        "pid": std::process::id(),
                        "at": chrono_like_timestamp(),
                    });
                    let _ = fs::write(lock_path.join("owner"), owner.to_string());
                    return Ok(Self { path: lock_path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if Instant::now() >= deadline {
                        return Err(format!(
                            "timed out waiting for registry lock: {}",
                            lock_path.display()
                        ));
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }
}

impl Drop for RegistryLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn lock_timeout_ms() -> u64 {
    env::var("SWITCHMAN_LOCK_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5000)
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}.{}", std::process::id(), nanos)
}

const DEFAULT_ACTIVITY_GRACE_SECS: u64 = 60 * 60;

fn activity_grace_secs() -> u64 {
    env::var("SWITCHMAN_ACTIVITY_GRACE_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_ACTIVITY_GRACE_SECS)
}

fn is_session_live(session: &WorktreeSession) -> bool {
    if session.status != SessionStatus::InProgress {
        return false;
    }

    if let Some(pid) = session.agent_pid {
        if process_exists(pid) {
            return true;
        }

        return false;
    }

    worktree_recently_active(&session.worktree_path, &session.files_touched)
}

fn process_exists(pid: u32) -> bool {
    let pid_arg = pid.to_string();
    Command::new("kill")
        .args(["-0", pid_arg.as_str()])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn worktree_recently_active(worktree_path: &str, files: &[String]) -> bool {
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return false;
    };
    let threshold = now.as_secs().saturating_sub(activity_grace_secs());

    for file in files {
        let path = Path::new(worktree_path).join(file);
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let Ok(modified_secs) = modified.duration_since(UNIX_EPOCH) else {
            continue;
        };
        if modified_secs.as_secs() >= threshold {
            return true;
        }
    }

    false
}

fn reconcile_sessions_liveness(sessions: &mut [WorktreeSession]) -> bool {
    let mut changed = false;

    for session in sessions.iter_mut() {
        let live = is_session_live(session);

        if session.status == SessionStatus::InProgress {
            if let Some(pid) = session.agent_pid {
                if !process_exists(pid) {
                    session.status = SessionStatus::Review;
                    session.agent_pid = None;
                    session.live = false;
                    changed = true;
                    continue;
                }
            }
        }

        session.live = live;
    }

    changed
}

fn apply_sessions_to_registry(
    value: &mut serde_json::Value,
    sessions: &[WorktreeSession],
) -> std::io::Result<()> {
    let entries = if let Some(array) = value.as_array_mut() {
        array
    } else {
        value
            .get_mut("sessions")
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "registry must be an array or object with sessions[]",
                )
            })?
    };

    for session in sessions {
        let Some(entry) = entries.iter_mut().find(|entry| {
            entry.get("id").and_then(serde_json::Value::as_str) == Some(session.id.as_str())
        }) else {
            continue;
        };

        let Some(object) = entry.as_object_mut() else {
            continue;
        };

        object.insert(
            "status".to_string(),
            serde_json::Value::String(status_to_registry_string(&session.status)),
        );

        match session.agent_pid {
            Some(pid) => {
                object.insert("agentPid".to_string(), serde_json::Value::Number(pid.into()));
            }
            None => {
                object.remove("agentPid");
                object.remove("agent_pid");
            }
        }
    }

    Ok(())
}

fn status_to_registry_string(status: &SessionStatus) -> String {
    match status {
        SessionStatus::Planning => "planning".to_string(),
        SessionStatus::InProgress => "in-progress".to_string(),
        SessionStatus::Paused => "paused".to_string(),
        SessionStatus::Review => "review".to_string(),
        SessionStatus::Done => "done".to_string(),
    }
}

fn compute_overlaps(sessions: &[WorktreeSession]) -> Vec<Overlap> {
    let mut overlaps = Vec::new();

    for left_index in 0..sessions.len() {
        for right_index in (left_index + 1)..sessions.len() {
            let left = &sessions[left_index];
            let right = &sessions[right_index];

            if !left.can_overlap() || !right.can_overlap() {
                continue;
            }

            let left_files: HashSet<String> = left
                .files_touched
                .iter()
                .filter_map(|file| normalized_overlap_file(file))
                .collect();
            let mut shared_files: Vec<String> = right
                .files_touched
                .iter()
                .filter_map(|file| normalized_overlap_file(file))
                .filter(|file| left_files.contains(file))
                .collect();

            if shared_files.is_empty() {
                continue;
            }

            shared_files.sort();
            shared_files.dedup();

            let severity = if is_session_live(left) || is_session_live(right) {
                OverlapSeverity::Active
            } else {
                OverlapSeverity::Stale
            };

            overlaps.push(Overlap {
                id: format!("{}__{}", left.id, right.id),
                session_a: left.id.clone(),
                session_b: right.id.clone(),
                shared_files,
                severity,
            });
        }
    }

    overlaps
}

fn active_merge_blockers(
    session: &WorktreeSession,
    sessions: &[WorktreeSession],
) -> Vec<MergeBlocker> {
    compute_overlaps(sessions)
        .into_iter()
        .filter(|overlap| overlap.severity == OverlapSeverity::Active)
        .filter_map(|overlap| {
            let other_id = if overlap.session_a == session.id {
                Some(overlap.session_b)
            } else if overlap.session_b == session.id {
                Some(overlap.session_a)
            } else {
                None
            }?;

            let other = sessions.iter().find(|candidate| candidate.id == other_id)?;

            if !is_session_live(other) {
                return None;
            }

            Some(MergeBlocker {
                session_id: other.id.clone(),
                task_name: other.task_name.clone(),
                agent: other.agent.clone(),
                shared_files: overlap.shared_files,
            })
        })
        .collect()
}

fn merge_blocked_message(blockers: &[MergeBlocker]) -> String {
    let Some(blocker) = blockers.first() else {
        return "Merging is blocked because another task is still editing the same file."
            .to_string();
    };

    let file = blocker
        .shared_files
        .first()
        .map(String::as_str)
        .unwrap_or("the same file");

    format!(
        "{} is still editing {} for {}.",
        agent_label(&blocker.agent),
        file,
        blocker.task_name
    )
}

fn agent_label(agent: &AgentKind) -> &'static str {
    match agent {
        AgentKind::ClaudeCode => "Claude Code",
        AgentKind::Codex => "Codex",
        AgentKind::Gemini => "Gemini",
        AgentKind::Aider => "Aider",
        AgentKind::Other => "Another agent",
    }
}

fn perform_git_merge(session: &WorktreeSession) -> Result<(), String> {
    if session.repo_root.is_empty() {
        return Err(format!(
            "session {} is missing repoRoot; cannot perform git merge",
            session.id
        ));
    }
    if session.worktree_path.is_empty() {
        return Err(format!(
            "session {} is missing worktreePath; cannot perform git merge",
            session.id
        ));
    }
    if session.branch_name.is_empty() {
        return Err(format!(
            "session {} is missing branchName; cannot perform git merge",
            session.id
        ));
    }

    let base_ref = if session.base_ref.is_empty() {
        "main"
    } else {
        &session.base_ref
    };

    ensure_clean(&session.repo_root, "target repository")?;
    commit_worktree_changes(session)?;
    ensure_clean(&session.repo_root, "target repository")?;
    git_checked(&session.repo_root, ["checkout", base_ref])?;
    ensure_clean(&session.repo_root, "target repository")?;
    git_checked(
        &session.repo_root,
        [
            "merge",
            "--no-ff",
            &session.branch_name,
            "-m",
            &format!("Switchman merge: {}", session.task_name),
        ],
    )
}

fn commit_worktree_changes(session: &WorktreeSession) -> Result<(), String> {
    let files = git_touched_files(&session.worktree_path).unwrap_or_default();
    if files.is_empty() {
        return Ok(());
    }

    git_checked(&session.worktree_path, ["add", "-A"])?;

    let staged = Command::new("git")
        .arg("-C")
        .arg(&session.worktree_path)
        .args(["diff", "--cached", "--quiet"])
        .output()
        .map_err(|error| error.to_string())?;

    if staged.status.success() {
        return Ok(());
    }

    if staged.status.code() != Some(1) {
        return Err(command_error(staged));
    }

    git_checked(
        &session.worktree_path,
        ["commit", "-m", &format!("Switchman: {}", session.task_name)],
    )
}

fn ensure_clean(cwd: &str, label: &str) -> Result<(), String> {
    let status = git_output(cwd, ["status", "--porcelain"])?;
    if !status.trim().is_empty() {
        return Err(format!(
            "{label} has uncommitted changes; refusing to merge"
        ));
    }

    Ok(())
}

fn update_registry_status(
    value: &mut serde_json::Value,
    session_id: &str,
    status: &str,
) -> Result<(), String> {
    let sessions = if let Some(array) = value.as_array_mut() {
        array
    } else {
        value
            .get_mut("sessions")
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(|| "registry must be an array or object with sessions[]".to_string())?
    };

    let now = chrono_like_timestamp();

    for session in sessions {
        if session.get("id").and_then(serde_json::Value::as_str) == Some(session_id) {
            let object = session
                .as_object_mut()
                .ok_or_else(|| "registry session must be an object".to_string())?;
            object.insert(
                "status".to_string(),
                serde_json::Value::String(status.to_string()),
            );
            object.insert("updatedAt".to_string(), serde_json::Value::String(now));
            return Ok(());
        }
    }

    Err(format!("session not found: {session_id}"))
}

fn chrono_like_timestamp() -> String {
    Command::new("date")
        .arg("-u")
        .arg("+%Y-%m-%dT%H:%M:%SZ")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

fn refresh_files_touched(sessions: &mut [WorktreeSession]) {
    for session in sessions {
        if matches!(
            session.status,
            SessionStatus::Planning | SessionStatus::Done
        ) {
            continue;
        }

        if let Some(files) = git_touched_files(&session.worktree_path) {
            session.files_touched = files;
        }
    }
}

fn git_touched_files(worktree_path: &str) -> Option<Vec<String>> {
    let mut files = Vec::new();

    files.extend(git_lines(worktree_path, ["diff", "--name-only", "HEAD"])?);
    files.extend(git_lines(
        worktree_path,
        ["ls-files", "--others", "--exclude-standard"],
    )?);

    files.sort();
    files.dedup();

    Some(files)
}

fn git_lines<const N: usize>(worktree_path: &str, args: [&str; N]) -> Option<Vec<String>> {
    git_output(worktree_path, args).ok().map(|output| {
        output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .collect()
    })
}

fn git_output<const N: usize>(worktree_path: &str, args: [&str; N]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(worktree_path)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        return Err(command_error(output));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_checked<const N: usize>(worktree_path: &str, args: [&str; N]) -> Result<(), String> {
    git_output(worktree_path, args).map(|_| ())
}

fn command_error(output: std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }

    format!("command failed with status {}", output.status)
}

impl WorktreeSession {
    fn can_overlap(&self) -> bool {
        !matches!(self.status, SessionStatus::Planning | SessionStatus::Done)
            && self
                .files_touched
                .iter()
                .any(|file| normalized_overlap_file(file).is_some())
    }
}

fn normalized_overlap_file(file: &str) -> Option<String> {
    let normalized = file.trim().replace('\\', "/");

    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains("/../")
        || normalized == ".."
        || normalized.starts_with("../")
        || is_ignored_overlap_file(&normalized)
    {
        return None;
    }

    Some(normalized)
}

fn is_ignored_overlap_file(file: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(lower.as_str());

    matches!(
        name,
        ".ds_store"
            | "thumbs.db"
            | "package-lock.json"
            | "pnpm-lock.yaml"
            | "yarn.lock"
            | "cargo.lock"
    ) || lower.starts_with("node_modules/")
        || lower.starts_with("dist/")
        || lower.starts_with("build/")
        || lower.starts_with("target/")
        || lower.starts_with(".git/")
        || lower.ends_with(".log")
        || lower.ends_with(".tmp")
        || lower.ends_with(".map")
        || lower.ends_with(".lock")
}

impl From<RegistrySession> for WorktreeSession {
    fn from(value: RegistrySession) -> Self {
        Self {
            id: value.id,
            task_name: value.task_name,
            agent: AgentKind::from(value.agent),
            repo_root: value.repo_root,
            base_ref: value.base_ref,
            worktree_path: value.worktree_path,
            branch_name: value.branch_name,
            status: SessionStatus::from(value.status),
            files_touched: value.files_touched,
            agent_pid: value.agent_pid,
            live: false,
        }
    }
}

impl From<String> for AgentKind {
    fn from(value: String) -> Self {
        match normalize(&value).as_str() {
            "claudecode" | "claude" | "claudecodecli" => Self::ClaudeCode,
            "codex" => Self::Codex,
            "gemini" => Self::Gemini,
            "aider" => Self::Aider,
            _ => Self::Other,
        }
    }
}

impl From<String> for SessionStatus {
    fn from(value: String) -> Self {
        match normalize(&value).as_str() {
            "planning" | "queued" => Self::Planning,
            "inprogress" | "progress" | "running" | "active" | "in-progress" => Self::InProgress,
            "paused" => Self::Paused,
            "review" => Self::Review,
            "done" | "merged" | "complete" | "completed" => Self::Done,
            _ => Self::InProgress,
        }
    }
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn reads_registry_and_computes_file_overlaps() {
        let path = env::temp_dir().join(format!(
            "switchman-sessions-{}.json",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ));

        fs::write(
            &path,
            format!(
                r#"{{
              "sessions": [
                {{
                  "id": "cart",
                  "taskName": "refactor cart total",
                  "agent": "claude-code",
                  "worktreePath": "/repo/.worktrees/cart",
                  "branchName": "switchman/cart",
                  "status": "in-progress",
                  "agentPid": {pid},
                  "filesTouched": ["src/cart/total.ts", "src/cart/taxes.ts"]
                }},
                {{
                  "id": "tax",
                  "task_name": "patch cart tax display",
                  "agent": "codex",
                  "worktree_path": "/repo/.worktrees/tax",
                  "branch_name": "switchman/tax",
                  "status": "review",
                  "files_touched": ["src/cart/taxes.ts"]
                }}
              ]
            }}"#,
                pid = std::process::id()
            ),
        )
        .expect("registry fixture should write");

        let sessions = read_registry(&path).expect("registry should parse");
        let overlaps = compute_overlaps(&sessions);

        fs::remove_file(path).expect("registry fixture should be removable");

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].agent, AgentKind::ClaudeCode);
        assert_eq!(sessions[1].task_name, "patch cart tax display");
        assert_eq!(overlaps.len(), 1);
        assert_eq!(overlaps[0].shared_files, vec!["src/cart/taxes.ts"]);
        assert_eq!(overlaps[0].severity, OverlapSeverity::Active);
    }

    #[test]
    fn refreshes_files_touched_from_worktree_diff() {
        let root = temp_path("switchman-git-refresh");
        let repo = root.join("repo");

        fs::create_dir_all(&repo).expect("repo dir should be created");
        git(&root, &["init", "-b", "main", repo.to_str().unwrap()]);
        git(&repo, &["config", "user.email", "switchman@example.test"]);
        git(&repo, &["config", "user.name", "Switchman Test"]);
        fs::write(repo.join("cart.ts"), "export const total = 1;\n").expect("fixture should write");
        git(&repo, &["add", "cart.ts"]);
        git(&repo, &["commit", "-m", "Initial commit"]);

        fs::write(repo.join("cart.ts"), "export const total = 2;\n")
            .expect("fixture should update");
        fs::write(repo.join("tax.ts"), "export const tax = 0;\n").expect("fixture should write");

        let mut sessions = vec![WorktreeSession {
            id: "cart".to_string(),
            task_name: "refactor cart total".to_string(),
            agent: AgentKind::Codex,
            repo_root: repo.display().to_string(),
            base_ref: "main".to_string(),
            worktree_path: repo.display().to_string(),
            branch_name: "switchman/cart".to_string(),
            status: SessionStatus::InProgress,
            files_touched: Vec::new(),
            agent_pid: None,
            live: false,
        }];

        refresh_files_touched(&mut sessions);
        fs::remove_dir_all(root).expect("fixture should be removable");

        assert_eq!(sessions[0].files_touched, vec!["cart.ts", "tax.ts"]);
    }

    #[test]
    fn detects_merge_blockers_and_updates_registry_status() {
        let sessions = vec![
            WorktreeSession {
                id: "cart".to_string(),
                task_name: "refactor cart total".to_string(),
                agent: AgentKind::Codex,
                repo_root: "/tmp/repo".to_string(),
                base_ref: "main".to_string(),
                worktree_path: "/tmp/cart".to_string(),
                branch_name: "switchman/cart".to_string(),
                status: SessionStatus::Review,
                files_touched: vec!["src/cart/total.ts".to_string()],
                agent_pid: None,
                live: false,
            },
            WorktreeSession {
                id: "tax".to_string(),
                task_name: "patch cart tax".to_string(),
                agent: AgentKind::ClaudeCode,
                repo_root: "/tmp/repo".to_string(),
                base_ref: "main".to_string(),
                worktree_path: "/tmp/tax".to_string(),
                branch_name: "switchman/tax".to_string(),
                status: SessionStatus::InProgress,
                files_touched: vec!["src/cart/total.ts".to_string()],
                agent_pid: Some(std::process::id()),
                live: true,
            },
        ];

        let blockers = active_merge_blockers(&sessions[0], &sessions);
        assert_eq!(blockers.len(), 1);
        assert_eq!(blockers[0].session_id, "tax");

        let mut registry = serde_json::json!({
            "sessions": [
                {
                    "id": "cart",
                    "taskName": "refactor cart total",
                    "agent": "codex",
                    "worktreePath": "/tmp/cart",
                    "branchName": "switchman/cart",
                    "status": "review",
                    "filesTouched": ["src/cart/total.ts"]
                }
            ]
        });

        update_registry_status(&mut registry, "cart", "done")
            .expect("registry status should update");

        assert_eq!(registry["sessions"][0]["status"], "done");
    }

    #[test]
    fn ignores_noisy_files_when_computing_overlaps() {
        let sessions = vec![
            WorktreeSession {
                id: "cart".to_string(),
                task_name: "refactor cart total".to_string(),
                agent: AgentKind::Codex,
                repo_root: "/tmp/repo".to_string(),
                base_ref: "main".to_string(),
                worktree_path: "/tmp/cart".to_string(),
                branch_name: "switchman/cart".to_string(),
                status: SessionStatus::InProgress,
                files_touched: vec![
                    "package-lock.json".to_string(),
                    "dist/index.js".to_string(),
                    "src/cart/total.ts".to_string(),
                ],
                agent_pid: Some(std::process::id()),
                live: true,
            },
            WorktreeSession {
                id: "tax".to_string(),
                task_name: "patch cart tax".to_string(),
                agent: AgentKind::ClaudeCode,
                repo_root: "/tmp/repo".to_string(),
                base_ref: "main".to_string(),
                worktree_path: "/tmp/tax".to_string(),
                branch_name: "switchman/tax".to_string(),
                status: SessionStatus::InProgress,
                files_touched: vec![
                    "package-lock.json".to_string(),
                    "dist/index.js".to_string(),
                    "src/cart/tax.ts".to_string(),
                ],
                agent_pid: Some(std::process::id()),
                live: true,
            },
        ];

        assert!(compute_overlaps(&sessions).is_empty());
    }

    #[test]
    fn writes_registry_atomically_and_keeps_valid_json() {
        let root = temp_path("switchman-registry-write");
        let path = root.join("sessions.json");
        let value = serde_json::json!({
            "sessions": [
                {
                    "id": "cart",
                    "taskName": "refactor cart total",
                    "agent": "codex",
                    "repoRoot": "/tmp/repo",
                    "baseRef": "main",
                    "worktreePath": "/tmp/cart",
                    "branchName": "switchman/cart",
                    "status": "review",
                    "filesTouched": ["cart.ts"]
                }
            ]
        });

        write_registry_value_unlocked(&path, &value).expect("registry should write");
        let parsed = read_registry_value_unlocked(&path).expect("registry should read");
        let leftovers = fs::read_dir(&root)
            .expect("registry dir should list")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        fs::remove_dir_all(root).expect("fixture should be removable");

        assert_eq!(parsed["sessions"][0]["id"], "cart");
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn registry_lock_times_out_when_held() {
        let root = temp_path("switchman-registry-lock");
        let path = root.join("sessions.json");
        let lock_path = PathBuf::from(format!("{}.lock", path.display()));

        fs::create_dir_all(&lock_path).expect("lock dir should be created");
        std::env::set_var("SWITCHMAN_LOCK_TIMEOUT_MS", "50");
        let result = RegistryLock::acquire(&path);
        std::env::remove_var("SWITCHMAN_LOCK_TIMEOUT_MS");
        fs::remove_dir_all(root).expect("fixture should be removable");

        assert!(result.is_err());
    }

    #[test]
    fn performs_git_merge_from_registered_worktree() {
        let root = temp_path("switchman-merge");
        let repo = root.join("repo");
        let worktree = root.join("worktree");

        fs::create_dir_all(&repo).expect("repo dir should be created");
        git(&root, &["init", "-b", "main", repo.to_str().unwrap()]);
        git(&repo, &["config", "user.email", "switchman@example.test"]);
        git(&repo, &["config", "user.name", "Switchman Test"]);
        fs::write(repo.join("cart.ts"), "export const total = 1;\n").expect("fixture should write");
        git(&repo, &["add", "cart.ts"]);
        git(&repo, &["commit", "-m", "Initial commit"]);
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "switchman/cart",
                worktree.to_str().unwrap(),
                "main",
            ],
        );
        fs::write(worktree.join("cart.ts"), "export const total = 2;\n")
            .expect("fixture should update");

        let session = WorktreeSession {
            id: "cart".to_string(),
            task_name: "refactor cart total".to_string(),
            agent: AgentKind::Codex,
            repo_root: repo.display().to_string(),
            base_ref: "main".to_string(),
            worktree_path: worktree.display().to_string(),
            branch_name: "switchman/cart".to_string(),
            status: SessionStatus::Review,
            files_touched: vec!["cart.ts".to_string()],
            agent_pid: None,
            live: false,
        };

        perform_git_merge(&session).expect("merge should complete");

        let subject = git_output_for_test(&repo, &["log", "-1", "--pretty=%s"]);
        let merged_text =
            fs::read_to_string(repo.join("cart.ts")).expect("merged file should read");
        fs::remove_dir_all(root).expect("fixture should be removable");

        assert_eq!(subject, "Switchman merge: refactor cart total");
        assert_eq!(merged_text, "export const total = 2;\n");
    }

    #[test]
    fn keeps_no_pid_session_in_progress_when_idle() {
        let mut sessions = vec![WorktreeSession {
            id: "cart".to_string(),
            task_name: "refactor cart total".to_string(),
            agent: AgentKind::Codex,
            repo_root: "/tmp/repo".to_string(),
            base_ref: "main".to_string(),
            worktree_path: "/tmp/missing-worktree".to_string(),
            branch_name: "switchman/cart".to_string(),
            status: SessionStatus::InProgress,
            files_touched: vec!["src/cart/total.ts".to_string()],
            agent_pid: None,
            live: false,
        }];

        assert!(!reconcile_sessions_liveness(&mut sessions));
        assert_eq!(sessions[0].status, SessionStatus::InProgress);
        assert!(!sessions[0].live);
    }

    #[test]
    fn reconciles_only_when_agent_process_has_exited() {
        let mut sessions = vec![WorktreeSession {
            id: "cart".to_string(),
            task_name: "refactor cart total".to_string(),
            agent: AgentKind::Codex,
            repo_root: "/tmp/repo".to_string(),
            base_ref: "main".to_string(),
            worktree_path: "/tmp/cart".to_string(),
            branch_name: "switchman/cart".to_string(),
            status: SessionStatus::InProgress,
            files_touched: vec!["src/cart/total.ts".to_string()],
            agent_pid: Some(4_000_000),
            live: true,
        }];

        assert!(reconcile_sessions_liveness(&mut sessions));
        assert_eq!(sessions[0].status, SessionStatus::Review);
        assert_eq!(sessions[0].agent_pid, None);
    }

    fn temp_path(prefix: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "{}-{}",
            prefix,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ))
    }

    fn git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .expect("git should run");

        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output_for_test(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .expect("git should run");

        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
}
