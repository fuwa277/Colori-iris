use tauri::{Manager, Emitter}; // 引入 Emitter 以支持后端发送事件 (解决 emit 报错)
use enigo::{Direction, Enigo, Key, Keyboard, Settings, Mouse}; // 引入 Mouse 特征以支持获取坐标 (解决 location 报错)

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

#[tauri::command]
fn get_mouse_pos() -> (i32, i32) {
    unsafe {
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        (point.x, point.y)
    }
}

#[tauri::command]
fn position_window_at_mouse(app: tauri::AppHandle, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        if let Ok((x, y)) = enigo.location() {
            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
        }
    }
}

#[tauri::command]
fn set_window_topmost(window: tauri::Window, topmost: bool) {
    window.set_always_on_top(topmost).unwrap_or(());
}

#[tauri::command]
fn trigger_system_grayscale() {
    // 模拟 Win+Ctrl+C
    std::thread::spawn(|| {
        // Enigo 0.2 初始化需要 Settings 并返回 Result，这里直接 unwrap
        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        
        // 使用 key 方法配合 Direction::Press (按下) / Release (松开) / Click (点击)
        enigo.key(Key::Meta, Direction::Press).unwrap();
        enigo.key(Key::Control, Direction::Press).unwrap();
        
        // Key::Layout 已被移除，使用 Key::Unicode 输入字符
        enigo.key(Key::Unicode('c'), Direction::Click).unwrap();
        
        enigo.key(Key::Control, Direction::Release).unwrap();
        enigo.key(Key::Meta, Direction::Release).unwrap();
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .invoke_handler(tauri::generate_handler![
        set_window_topmost, 
        trigger_system_grayscale, 
        get_mouse_pos,
        position_window_at_mouse
    ])
    .setup(|app| {
      // --- 修复1: 添加系统托盘 ---
      use tauri::tray::{TrayIconBuilder, TrayIconEvent};
      use tauri::menu::{Menu, MenuItem};
      
      let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
      let show_i = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

      let _tray = TrayIconBuilder::with_id("tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon(app.default_window_icon().unwrap().clone())
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show" => {
                // WakePip 解绑：不再直接 show 窗口，而是发送信号让前端主窗口自己决定显隐
                let _ = app.emit("tray-show-main", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                // WakePip 解绑：左键点击托盘也通过信号处理，避免级联唤醒画中画
                let _ = tray.app_handle().emit("tray-show-main", ());
            }
        })
        .build(app)?;
      // --------------------------

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
