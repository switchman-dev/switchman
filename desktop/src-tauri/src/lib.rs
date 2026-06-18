mod switchman;

use std::{
    sync::Mutex,
    thread,
    time::Duration,
};

use switchman::{get_board_snapshot, OverlapSeverity};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager,
};

struct TrayState {
    tray: tauri::tray::TrayIcon,
    last_active: Mutex<usize>,
    synced: Mutex<bool>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Show Board", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let icon = app
                .default_window_icon()
                .cloned()
                .expect("missing app icon");

            let tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("Switchman — clear")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            app.manage(TrayState {
                tray,
                last_active: Mutex::new(0),
                synced: Mutex::new(false),
            });

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }

            let handle = app.handle().clone();
            thread::spawn(move || {
                loop {
                    thread::sleep(Duration::from_secs(3));
                    update_tray_state(&handle);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            switchman::get_board_snapshot,
            switchman::merge_session,
            switchman::open_overlap_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn update_tray_state(app: &tauri::AppHandle) {
    let snapshot = get_board_snapshot();
    let active = snapshot
        .overlaps
        .iter()
        .filter(|overlap| overlap.severity == OverlapSeverity::Active)
        .count();

    let tooltip = if active > 0 {
        format!(
            "Switchman — {active} live file overlap{}",
            if active == 1 { "" } else { "s" }
        )
    } else {
        "Switchman — clear".to_string()
    };

    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };

    let _ = state.tray.set_tooltip(Some(&tooltip));

    let synced = state
        .synced
        .lock()
        .map(|guard| *guard)
        .unwrap_or(false);
    let previous = state
        .last_active
        .lock()
        .map(|value| *value)
        .unwrap_or(0);

    if !synced {
        if let Ok(mut guard) = state.last_active.lock() {
            *guard = active;
        }
        if let Ok(mut guard) = state.synced.lock() {
            *guard = true;
        }
        return;
    }

    if active > previous {
        show_main_window(app);
    }

    if let Ok(mut guard) = state.last_active.lock() {
        *guard = active;
    };
}
