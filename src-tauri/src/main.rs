#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Emitter};
use std::sync::Mutex;
// use std::fs; // Unused
// use std::path::PathBuf; // Unused
use std::process::Command;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use std::fs::OpenOptions;
use std::io::Write;
use std::fs; // 新增
use std::path::Path; // 新增
use winreg::enums::*;
use winreg::RegKey;
use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
use windows::Win32::Foundation::{POINT, HWND, LPARAM, BOOL};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};
// [修复] 引入 GetSystemMetrics 和 SM_SWAPBUTTON
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON}; 
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON, VK_CONTROL, VK_SHIFT, VK_MENU, VK_XBUTTON1, VK_XBUTTON2};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_TRANSPARENT, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    CreateWindowExW, SetWindowPos, 
    WS_CHILD, WS_VISIBLE, HWND_BOTTOM, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOZORDER,
    HMENU,
    SWP_NOMOVE, SWP_NOSIZE, SWP_FRAMECHANGED
};
// 引入托盘相关模块
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};
use windows::Win32::UI::Magnification::{
    MagInitialize, MagSetFullscreenColorEffect, MAGCOLOREFFECT,
    MagSetWindowSource
};
// 引入 KEYBDINPUT, KEYEVENTF_KEYUP 等
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, SendInput, MOUSEINPUT, 
    KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, KEYBD_EVENT_FLAGS,
    KEYEVENTF_SCANCODE, MapVirtualKeyW, MAP_VIRTUAL_KEY_TYPE // [修复] 引入扫描码支持及类型
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow, GetWindowThreadProcessId, EnumWindows, IsWindowVisible, GetWindowTextLengthW, IsIconic};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;
use windows::Win32::Foundation::{RECT, HINSTANCE, GetLastError, ERROR_ALREADY_EXISTS}; // [修复] 添加 GetLastError
use windows::Win32::System::Threading::CreateMutexW; // [修复] 添加 CreateMutexW
use windows::core::{w, PCWSTR}; 
use std::sync::atomic::{AtomicI32, AtomicBool, Ordering};
use std::time::Duration;
use std::thread;
use std::collections::HashSet;
use std::io::Cursor;
use image::ImageFormat;
use xcap::{Monitor, Window}; // 确保引入 Window
use image::imageops::crop_imm;
use base64::engine::{general_purpose, Engine};

mod d3d11_renderer; // 注册新渲染器
mod wgc; // 引入 WGC 模块

// 存储“颜色同步点”的屏幕坐标 (X, Y)
static SYNC_POS_X: AtomicI32 = AtomicI32::new(0);
static SYNC_POS_Y: AtomicI32 = AtomicI32::new(0);
// 存储用户设置的同步热键 
static SYNC_HOTKEY: AtomicI32 = AtomicI32::new(0); // 主键 Code
static SYNC_MODS: AtomicI32 = AtomicI32::new(0);   // 修饰键掩码 (1=Ctrl, 2=Shift, 4=Alt)
static SYNC_PICK_KEY: Mutex<String> = Mutex::new(String::new()); // 目标软件取色键 (如 B, I)
// 是否启用同步
static SYNC_ENABLED: AtomicBool = AtomicBool::new(false);
// [新增] 是否正在录制热键 (防止录制时误触)
static IS_RECORDING_HOTKEY: AtomicBool = AtomicBool::new(false);
// 防止监听器重复启动
static LISTENER_RUNNING: AtomicBool = AtomicBool::new(false);

// 额外全局快捷键 (Code + Mods)
static HK_GRAY_CODE: AtomicI32 = AtomicI32::new(0);
static HK_GRAY_MODS: AtomicI32 = AtomicI32::new(0);
static HK_PICK_CODE: AtomicI32 = AtomicI32::new(0);
static HK_PICK_MODS: AtomicI32 = AtomicI32::new(0);
static HK_MONI_CODE: AtomicI32 = AtomicI32::new(0);
static HK_MONI_MODS: AtomicI32 = AtomicI32::new(0);
// 额外快捷键的全局开关
static HK_GLOBAL_FLAGS: AtomicI32 = AtomicI32::new(0); // 位掩码: 1=Gray, 2=Pick, 4=Moni
// 目标进程名称 (None 代表不限制)
static TARGET_PROCESS_NAME: Mutex<Option<String>> = Mutex::new(None);

#[tauri::command]
fn set_hotkey_recording_status(is_recording: bool) {
    IS_RECORDING_HOTKEY.store(is_recording, Ordering::Relaxed);
    // 先注释：打印日志方便调试
    // log_to_file(format!("Hotkey Recording Status: {}", is_recording));
}

#[tauri::command]
async fn capture_region(x: i32, y: i32, w: u32, h: u32) -> Result<String, String> {
    // 1. 寻找包含选区起点的屏幕
    let screens = Monitor::all().map_err(|e| e.to_string())?;
    
    // 找到包含区域起点的屏幕，或者默认第一个
    let monitor = screens.iter().find(|m| {
        x >= m.x() && x < m.x() + m.width() as i32 &&
        y >= m.y() && y < m.y() + m.height() as i32
    }).unwrap_or_else(|| screens.first().ok_or("No monitor found").unwrap());

    // 2. 截取该屏幕图像数据 (物理像素)
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    
    // 3. 计算裁剪区域相对于该屏幕的坐标
    // start_x/y 必须是 u32
    let start_x = (x - monitor.x()) as u32;
    let start_y = (y - monitor.y()) as u32;

    // 4. 裁剪图像 (修复：严格边界检查防止 Panic)
    let img_w = image.width();
    let img_h = image.height();
    
    // 确保起点在图像内
    if start_x >= img_w || start_y >= img_h {
        return Err("Crop region is outside monitor bounds".to_string());
    }

    // 确保宽高不越界
    let safe_w = w.min(img_w - start_x);
    let safe_h = h.min(img_h - start_y);

    let sub_image = crop_imm(&image, start_x, start_y, safe_w, safe_h);

    // 5. 编码为 PNG 和 Base64
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    sub_image.to_image().write_to(&mut cursor, ImageFormat::Png).map_err(|e| e.to_string())?;
    
    let base64_str = general_purpose::STANDARD.encode(buf);
    Ok(format!("data:image/png;base64,{}", base64_str))
}

#[tauri::command]
async fn capture_window_thumbnail(app_name: String) -> Result<String, String> {
    let windows = Window::all().map_err(|e| e.to_string())?;
    
    // 修复: 预处理搜索词，转小写并去除 .exe 后缀
    let needle = app_name.to_lowercase().replace(".exe", "");
    
    // 模糊匹配：同时检查 app_name 和 title，忽略大小写
    let target = windows.into_iter().find(|w| {
        let w_app = w.app_name().to_lowercase();
        let w_title = w.title().to_lowercase();
        w_app.contains(&needle) || w_title.contains(&needle)
    }).ok_or_else(|| format!("Window not found: {}", needle))?;

    // 截图 (Window 模式通常不受遮挡影响)
    let image = target.capture_image().map_err(|e| e.to_string())?;
    
    // 转换为 Base64
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    image.write_to(&mut cursor, ImageFormat::Png).map_err(|e| e.to_string())?;
    
    let base64_str = general_purpose::STANDARD.encode(buf);
    Ok(format!("data:image/png;base64,{}", base64_str))
}

// 存储窗口状态的结构体
pub struct WindowState {
  pub is_topmost: Mutex<bool>,
}

#[tauri::command]
fn set_window_topmost(app_handle: tauri::AppHandle, label: Option<String>, topmost: bool) -> Result<(), String> {
  // 优先使用传入的 label，如果没传则默认 main (兼容旧代码)
  let target_label = label.unwrap_or_else(|| "main".to_string());
  
  let window = app_handle.get_webview_window(&target_label)
                        .ok_or_else(|| format!("Window {} not found", target_label))?;
  
  if let Err(e) = window.set_always_on_top(topmost) {
    return Err(format!("Failed to set always on top: {}", e));
  }
  Ok(())
}

// 获取指定窗口名称的 RECT (过滤小窗口)
#[tauri::command]
fn get_window_rect(name: String) -> Option<(i32, i32, i32, i32)> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    
    static TARGET_SEARCH_NAME: Mutex<String> = Mutex::new(String::new());
    static FOUND_RECT: Mutex<Option<(i32, i32, i32, i32)>> = Mutex::new(None);

    *TARGET_SEARCH_NAME.lock().unwrap() = name;
    *FOUND_RECT.lock().unwrap() = None;

    unsafe extern "system" fn enum_proc(hwnd: HWND, _: LPARAM) -> BOOL {
        // [修复] 移除 GetWindowTextLengthW 检查，有些主窗口可能没标题
        if IsWindowVisible(hwnd).as_bool() {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if let Ok(process) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) {
                let mut buffer = [0u16; 1024];
                if GetModuleBaseNameW(process, None, &mut buffer) > 0 {
                    let proc_name = String::from_utf16_lossy(&buffer).trim_matches('\0').to_string();
                    let target = TARGET_SEARCH_NAME.lock().unwrap();
                    if proc_name == *target {
                        let mut rect = RECT::default();
                        if GetWindowRect(hwnd, &mut rect).is_ok() {
                            let w = rect.right - rect.left;
                            let h = rect.bottom - rect.top;
                            // [修复 Issue 5] 过滤掉小于 10x10 的窗口 (如优动漫的 1x1 后台窗口)
                            if w > 10 && h > 10 {
                                *FOUND_RECT.lock().unwrap() = Some((rect.left, rect.top, w, h));
                                return BOOL(0); // 找到并停止
                            }
                        }
                    }
                }
                let _ = windows::Win32::Foundation::CloseHandle(process);
            }
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(0));
    }

    *FOUND_RECT.lock().unwrap()
}

// 获取窗口句柄 (WGC 需要) - 同样增加尺寸过滤
#[tauri::command]
fn get_window_hwnd(name: String) -> Option<isize> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    static TARGET_NAME: Mutex<String> = Mutex::new(String::new());
    static FOUND_HWND: Mutex<Option<isize>> = Mutex::new(None);

    *TARGET_NAME.lock().unwrap() = name;
    *FOUND_HWND.lock().unwrap() = None;

    unsafe extern "system" fn enum_proc(hwnd: HWND, _: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd).as_bool() {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if let Ok(process) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) {
                let mut buffer = [0u16; 1024];
                if GetModuleBaseNameW(process, None, &mut buffer) > 0 {
                    let proc_name = String::from_utf16_lossy(&buffer).trim_matches('\0').to_string();
                    if proc_name == *TARGET_NAME.lock().unwrap() {
                        // [修复 Issue 5] 必须检查尺寸，防止获取到 1x1 的 Dummy Window
                        let mut rect = RECT::default();
                        if GetWindowRect(hwnd, &mut rect).is_ok() {
                            let w = rect.right - rect.left;
                            let h = rect.bottom - rect.top;
                            if w > 10 && h > 10 {
                                *FOUND_HWND.lock().unwrap() = Some(hwnd.0 as isize);
                                return BOOL(0);
                            }
                        }
                    }
                }
                let _ = windows::Win32::Foundation::CloseHandle(process);
            }
        }
        BOOL(1)
    }
    unsafe { let _ = EnumWindows(Some(enum_proc), LPARAM(0)); }
    *FOUND_HWND.lock().unwrap()
}


#[tauri::command]
fn open_color_filter_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(&["/C", "start", "ms-settings:easeofaccess-colorfilter"])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_os_build_version() -> u32 {
    {
        // 获取系统版本号，低版本 (<18362) 不支持 WGC
        let mut version = windows::Win32::System::SystemInformation::OSVERSIONINFOW::default();
        version.dwOSVersionInfoSize = std::mem::size_of::<windows::Win32::System::SystemInformation::OSVERSIONINFOW>() as u32;
        // GetVersion 被废弃，但在兼容模式下可能返回旧值。
        // 推荐直接读取注册表或使用 RtlGetVersion，但简单起见，这里假设 Win10+ 环境。
        // 为了稳健性，使用 winreg 读取 CurrentBuild
        let hk_lm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(current_version) = hk_lm.open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion") {
            if let Ok(build_str) = current_version.get_value::<String, _>("CurrentBuild") {
                if let Ok(build) = build_str.parse::<u32>() {
                    return build;
                }
            }
        }
        0 // Fallback
    }
}

#[tauri::command]
fn is_window_minimized(name: String) -> bool {
    // 复用 get_window_hwnd 的逻辑查找窗口并检查 IsIconic
    if let Some(hwnd_val) = get_window_hwnd(name) {
        unsafe {
            return IsIconic(HWND(hwnd_val as _)).as_bool();
        }
    }
    false
}

// [新增] 窗口诊断命令
#[tauri::command]
fn diagnose_window(name: String) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, GWL_STYLE, GWL_EXSTYLE, GetWindowDisplayAffinity, GetWindowRect};
    
    if let Some(hwnd_val) = get_window_hwnd(name.clone()) {
        let hwnd = HWND(hwnd_val as _);
        unsafe {
            let style = GetWindowLongW(hwnd, GWL_STYLE);
            let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
            let mut rect = RECT::default();
            let _ = GetWindowRect(hwnd, &mut rect);
            
            // 检查显示亲和性 (是否防截屏)
            let mut affinity: u32 = 0;
            let _ = GetWindowDisplayAffinity(hwnd, &mut affinity);
            
            return format!(
                "Window '{}' Found:\nHWND: {:?}\nRect: {:?}\nStyle: {:X}\nExStyle: {:X}\nAffinity: {}\n(Affinity!=0 means capture protected)", 
                name, hwnd, rect, style, ex_style, affinity
            );
        }
    }
    format!("Window '{}' not found via EnumWindows.", name)
}

#[tauri::command]
fn log_to_file(msg: String) {
    let timestamp = chrono::Local::now().format("%H:%M:%S%.3f");
    let log_msg = format!("[{}] {}", timestamp, msg);
    println!("{}", log_msg);
    
    let log_path = "colori_debug.log";
    
    // 检查文件大小，超过 1MB 则清空重写
    if let Ok(metadata) = std::fs::metadata(log_path) {
        if metadata.len() > 1024 * 1024 {
            let _ = std::fs::write(log_path, ""); 
        }
    }

    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path) 
    {
        let _ = writeln!(file, "{}", log_msg);
    }
}

// --- 图片临时文件管理 ---
#[tauri::command]
fn save_temp_image(data_url: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("colori_temp");
    if !temp_dir.exists() {
        std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    }

    // 解析 Base64 (data:image/png;base64,....)
    let parts: Vec<&str> = data_url.split(',').collect();
    if parts.len() != 2 { return Err("Invalid Data URL".to_string()); }
    
    let base64_data = parts[1];
    let bytes = general_purpose::STANDARD.decode(base64_data).map_err(|e| e.to_string())?;
    
    let file_name = format!("ref_{}.png", chrono::Local::now().timestamp_millis());
    let file_path = temp_dir.join(&file_name);
    
    std::fs::write(&file_path, bytes).map_err(|e| e.to_string())?;
    
    // 返回绝对路径
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn clean_temp_images() {
    let temp_dir = std::env::temp_dir().join("colori_temp");
    if temp_dir.exists() {
        let _ = std::fs::remove_dir_all(temp_dir);
    }
}

// [修复 Issue 1 & 4] 后端直接读取图片为 Base64，绕过 asset 协议问题
#[tauri::command]
fn read_image_as_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    // 简单判断图片类型，默认 png
    let b64 = general_purpose::STANDARD.encode(bytes);
    // 这里为了通用性，直接返回带 Data URI 前缀的字符串
    // 你可以根据文件扩展名优化 mime type，这里简化处理
    Ok(format!("data:image/png;base64,{}", b64))
}

// [修复 Issue 2] 后端读取剪贴板并保存为临时文件，解决前端插件调用失败
#[tauri::command]
fn save_clipboard_to_temp(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    
    // 1. 读取剪贴板图像
    let clipboard_image = app.clipboard().read_image().map_err(|e| format!("Clipboard error: {}", e))?;
    
    // 2. 转换为 image crate 的 DynamicImage
    // ClipboardImage 通常是 RGBA8
    let width = clipboard_image.width() as u32;
    let height = clipboard_image.height() as u32;
    let rgba_data = clipboard_image.rgba();
    
    let buffer = image::ImageBuffer::<image::Rgba<u8>, Vec<u8>>::from_raw(width, height, rgba_data.to_vec())
        .ok_or("Failed to create image buffer")?;
    
    // 3. 保存到临时目录 (复用 save_temp_image 的路径逻辑)
    let temp_dir = std::env::temp_dir().join("colori_temp");
    if !temp_dir.exists() {
        std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    }
    let file_name = format!("clip_{}.png", chrono::Local::now().timestamp_millis());
    let file_path = temp_dir.join(&file_name);
    
    buffer.save(&file_path).map_err(|e| format!("Failed to save image: {}", e))?;
    
    Ok(file_path.to_string_lossy().to_string())
}

// --- 新增：模拟按键 (用于跨应用吸色) ---
#[tauri::command]
fn simulate_key_sequence(keys: String) {
    std::thread::spawn(move || {
        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        // 简单的解析逻辑，例如 "B" 或 "I"
        for char in keys.chars() {
            let _ = enigo.key(Key::Unicode(char), Direction::Click);
            thread::sleep(Duration::from_millis(50));
        }
    });
}

#[tauri::command]
fn trigger_system_grayscale() {
    std::thread::spawn(|| {
        if let Ok(mut enigo) = Enigo::new(&Settings::default()) {
            let _ = enigo.key(Key::Meta, Direction::Press);
            let _ = enigo.key(Key::Control, Direction::Press);
            let _ = enigo.key(Key::Unicode('c'), Direction::Click);
            let _ = enigo.key(Key::Control, Direction::Release);
            let _ = enigo.key(Key::Meta, Direction::Release);
        }
    });
}

#[tauri::command]
fn get_config_path() -> Option<std::path::PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.join("colori_data.json")))
}

#[tauri::command]
fn save_config_file(data: String) -> Result<(), String> {
    if let Some(path) = get_config_path() {
        fs::write(path, data).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn load_config_file() -> Result<String, String> {
    if let Some(path) = get_config_path() {
        if path.exists() {
            return fs::read_to_string(path).map_err(|e| e.to_string());
        }
    }
    Ok("{}".to_string()) // 如果文件不存在返回空JSON
}

// 获取当前运行的应用程序列表 (用于前端下拉框)
#[tauri::command]
fn get_running_apps() -> Vec<String> {
    let mut apps = HashSet::new();
    unsafe {
        // 修正：将指针包装为 LPARAM 结构体
        let param = LPARAM(&mut apps as *mut _ as isize);
        let _ = EnumWindows(Some(enum_window_proc), param);
    }
    let mut sorted_apps: Vec<String> = apps.into_iter().collect();
    sorted_apps.sort();
    sorted_apps
}

// 修正：回调函数参数必须是 LPARAM 类型
unsafe extern "system" fn enum_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // Fix Point 19: 宽松过滤，不仅检查 Visible，还检查是否有标题，避免漏掉一些应用
    // 有些应用主窗口可能暂时隐藏，但我们希望列出它？不，通常只列出可见的。
    // 问题可能是 IsWindowVisible 过滤掉了 UWP 应用的 Frame。
    // 增加逻辑：如果有标题且长度 > 0，即使是其他状态也尝试获取。
    
    let length = GetWindowTextLengthW(hwnd);
    if length > 0 && IsWindowVisible(hwnd).as_bool() {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        // 尝试打开进程
        if let Ok(process) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) {
            let mut buffer = [0u16; 1024];
            if GetModuleBaseNameW(process, None, &mut buffer) > 0 {
                let name = String::from_utf16_lossy(&buffer).trim_matches('\0').to_string();
                // 排除系统进程
                let ignore = ["svchost.exe", "SearchHost.exe", "StartMenuExperienceHost.exe", "TextInputHost.exe"];
                if !name.is_empty() && !ignore.contains(&name.as_str()) {
                    let apps = &mut *(lparam.0 as *mut HashSet<String>);
                    apps.insert(name);
                }
            }
            let _ = windows::Win32::Foundation::CloseHandle(process);
        }
    }
    BOOL(1)
}

#[tauri::command]
fn set_target_process_name(name: String) {
    let mut target = TARGET_PROCESS_NAME.lock().unwrap();
    if name.is_empty() {
        *target = None;
    } else {
        *target = Some(name);
    }
}

#[tauri::command]
fn set_sync_enabled(enabled: bool) {
    SYNC_ENABLED.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn check_system_grayscale_status() -> bool {
    #[cfg(target_os = "windows")]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey("Software\\Microsoft\\ColorFiltering") {
            let active: u32 = key.get_value("Active").unwrap_or(0);
            return active == 1;
        }
    }
    false
}

// --- 新增：窗口样式诊断与强制修复 ---



// 设置窗口鼠标穿透 (Click-through) - 支持传入 Label 查找窗口，如果没传则作用于当前
#[tauri::command]
fn set_ignore_cursor_events(app_handle: tauri::AppHandle, label: Option<String>, ignore: bool) -> Result<(), String> {
    let window = if let Some(l) = label {
        app_handle.get_webview_window(&l).ok_or("Window not found")?
    } else {
        // 如果没有 label，尝试获取当前上下文的窗口不太容易，建议前端必传 label
        return Err("Label is required".to_string());
    };

    #[cfg(target_os = "windows")]
    unsafe {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let hwnd_val = HWND(hwnd as _);
        let mut style = GetWindowLongW(hwnd_val, GWL_EXSTYLE);
        // 必须确保存在这个样式才能设置透明
        let layered = WS_EX_LAYERED.0 as i32;
        let transparent = WS_EX_TRANSPARENT.0 as i32;
        
        // 确保窗口是 Layered (Tauri 默认通常是，但为了保险)
        if (style & layered) == 0 {
             SetWindowLongW(hwnd_val, GWL_EXSTYLE, style | layered);
             style |= layered;
        }

        if ignore {
            style |= transparent;
        } else {
            style &= !transparent;
        }
        SetWindowLongW(hwnd_val, GWL_EXSTYLE, style);
    }
    Ok(())
}

#[tauri::command]
fn toggle_overlay(app_handle: tauri::AppHandle, show: bool) -> Result<(), String> {
    let window = app_handle.get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;
    
    if show {
        window.show().map_err(|e| e.to_string())?;
        // 开启穿透 - 修复：正确转换句柄类型
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        set_ignore_cursor_events_for_hwnd(hwnd, true)?;
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 新增：专门处理窗口句柄的穿透设置函数
#[tauri::command]
fn set_ignore_cursor_events_for_hwnd(hwnd_value: isize, ignore: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let hwnd = HWND(hwnd_value as _);
        let mut style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if ignore {
            style |= (WS_EX_TRANSPARENT | WS_EX_LAYERED).0 as i32;
        } else {
            style &= !(WS_EX_TRANSPARENT | WS_EX_LAYERED).0 as i32;
        }
        SetWindowLongW(hwnd, GWL_EXSTYLE, style);
    }
    Ok(())
}

#[tauri::command]
fn get_mouse_pos() -> (i32, i32) {
    unsafe {
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        (point.x, point.y)
    }
}

// 新增：检测鼠标左键是否按下 (用于前端轮询实现"点击选点")
#[tauri::command]
fn is_mouse_down() -> bool {
    unsafe {
        // [交互优化] 检测是否交换了左右键 (左撇子模式)
        let swapped = GetSystemMetrics(SM_SWAPBUTTON) != 0;
        let target_key = if swapped { VK_RBUTTON } else { VK_LBUTTON };
        
        let state = GetAsyncKeyState(target_key.0 as i32);
        (state as u16 & 0x8000) != 0
    }
}



// --- Mag API PiP 核心逻辑 ---

// 1. 初始化 Mag API (只需一次)
#[tauri::command]
fn init_mag_api() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        // 确保只初始化一次，且不反初始化，保持上下文常驻
        let _ = MagInitialize();
    }
    Ok(())
}

// 2. 启动或更新放大镜子窗口
#[tauri::command]
fn start_magnifier(app_handle: tauri::AppHandle, label: String, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    let window = app_handle.get_webview_window(&label).ok_or("Window not found")?;
    
    // 增加探针日志
    log_to_file(format!("CMD: start_magnifier for {}, Source: {},{} {}x{}", label, x, y, w, h));

    #[cfg(target_os = "windows")]
    unsafe {
        let parent_hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0 as _);
        
        // 确保 Mag API 已初始化
        let _ = MagInitialize();
        
        // 获取父窗口客户区大小
        let mut client_rect = RECT::default();
        if windows::Win32::UI::WindowsAndMessaging::GetClientRect(parent_hwnd, &mut client_rect).is_err() {
             return Err("Failed to get client rect".to_string());
        }
        let dest_w = client_rect.right - client_rect.left;
        let dest_h = client_rect.bottom - client_rect.top;

        // 如果窗口处于最小化或隐藏状态，尺寸可能为0，此时不应创建 Mag
        if dest_w <= 0 || dest_h <= 0 {
            log_to_file("Window size is 0, skipping Mag creation".to_string());
            return Ok(());
        }

        // 1. 查找是否已存在 Mag 子窗口
        let mag_hwnd = windows::Win32::UI::WindowsAndMessaging::FindWindowExW(
            parent_hwnd, HWND(std::ptr::null_mut()), w!("Magnifier"), PCWSTR::null()
        );

        let final_mag_hwnd = if let Ok(hwnd) = mag_hwnd {
            if hwnd.0 != std::ptr::null_mut() {
                log_to_file("Found existing Mag window".to_string());
                hwnd
            } else {
                log_to_file("Creating NEW Mag window".to_string());
                let h_instance = HINSTANCE::default();
                CreateWindowExW(
                    windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE(0),
                    w!("Magnifier"), w!("MagView"),
                    WS_CHILD | WS_VISIBLE,
                    0, 0, dest_w, dest_h,
                    parent_hwnd, HMENU::default(), h_instance, None
                ).map_err(|e| format!("Failed create: {}", e))?
            }
        } else {
             return Err("FindWindowExW error".into());
        };

        // 2. 设置源区域
        let rect = RECT { left: x, top: y, right: x + w, bottom: y + h };
        if !MagSetWindowSource(final_mag_hwnd, rect).as_bool() {
             log_to_file("Warning: MagSetWindowSource failed".to_string());
        }

        // 3. 设置目标窗口位置 (填满父窗口)
        // 注意：HWND_BOTTOM 将其置于父窗口 Z 序的最底层
        // 必须配合前端透明背景才能看到
        let _ = SetWindowPos(
            final_mag_hwnd, 
            HWND_BOTTOM, 
            0, 0, dest_w, dest_h, 
            SWP_NOACTIVATE | SWP_NOZORDER 
        );
        
        // 4. 强制刷新
        let _ = windows::Win32::Graphics::Gdi::InvalidateRect(final_mag_hwnd, None, BOOL(1));
    }
    Ok(())
}

#[tauri::command]
fn toggle_pip_window(app_handle: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window(&label) {
        let is_visible = window.is_visible().unwrap_or(false);
        
        if is_visible {
            let _ = window.set_skip_taskbar(true);
            let _ = window.hide();
        } else {
            let _ = window.set_skip_taskbar(false);
            if window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
            }
            let _ = window.show();
            let _ = window.set_focus();
            
            // 修复: 唤醒时通知前端重置 Mag，解决“画中画不出现”的问题
            // 因为隐藏期间窗口尺寸可能被系统优化，需要前端重新计算 Source Rect
            let _ = window.emit("pip-wake", ());
        }
        Ok(())
    } else {
        Err("Window not found".to_string())
    }
}

#[tauri::command]
fn debug_window_state(_label: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // use windows::Win32::UI::WindowsAndMessaging::{IsWindowVisible, GetWindowRect};
        // 占位逻辑
    }
    Ok("Debug info".to_string())
}

// 仅更新放大镜窗口大小 (响应父窗口 Resize)
#[tauri::command]
fn update_magnifier_size(app_handle: tauri::AppHandle, label: String, w: i32, h: i32) -> Result<(), String> {
    let window = app_handle.get_webview_window(&label).ok_or("Window not found")?;
    #[cfg(target_os = "windows")]
    unsafe {
        let parent_hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0 as _);
        let mag_hwnd = windows::Win32::UI::WindowsAndMessaging::FindWindowExW(
            parent_hwnd, HWND(std::ptr::null_mut()), w!("Magnifier"), PCWSTR::null()
        );
        if let Ok(hwnd) = mag_hwnd {
             if hwnd.0 != std::ptr::null_mut() {
                let _ = SetWindowPos(
                    hwnd, HWND(std::ptr::null_mut()), 
                    0, 0, w, h, 
                    SWP_NOACTIVATE | SWP_NOZORDER 
                );
             }
        }
    }
    Ok(())
}

// 仅更新放大镜源区域 (响应 Zoom/Pan)
#[tauri::command]
fn update_magnifier_source(app_handle: tauri::AppHandle, label: String, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    let window = app_handle.get_webview_window(&label).ok_or("Window not found")?;
    #[cfg(target_os = "windows")]
    unsafe {
        let parent_hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0 as _);
        let mag_hwnd = windows::Win32::UI::WindowsAndMessaging::FindWindowExW(
            parent_hwnd, HWND(std::ptr::null_mut()), w!("Magnifier"), PCWSTR::null()
        );
        if let Ok(hwnd) = mag_hwnd {
             if hwnd.0 != std::ptr::null_mut() {
                let rect = RECT { left: x, top: y, right: x + w, bottom: y + h };
                MagSetWindowSource(hwnd, rect);
                // 强制刷新以立即显示变化
                windows::Win32::Graphics::Gdi::InvalidateRect(hwnd, None, BOOL(1));
             }
        }
    }
    Ok(())
}


// 系统级全屏灰度 (原有功能保持)
#[tauri::command]
fn set_fullscreen_grayscale(enable: bool, matrix_values: Option<Vec<f32>>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    unsafe {
        let _ = MagInitialize(); // 总是确保已初始化

        if enable {
            // Rec.601 Luma (R=0.299, G=0.587, B=0.114) 默认值
            let mut arr = [
                0.299, 0.587, 0.114, 0.0, 0.0,
                0.299, 0.587, 0.114, 0.0, 0.0,
                0.299, 0.587, 0.114, 0.0, 0.0,
                0.0,   0.0,   0.0,   1.0, 0.0,
                0.0,   0.0,   0.0,   0.0, 1.0,
            ];

            if let Some(vals) = matrix_values {
                if vals.len() == 25 {
                    arr.copy_from_slice(&vals);
                }
            }

            let matrix = MAGCOLOREFFECT { transform: arr };
            if !MagSetFullscreenColorEffect(&matrix).as_bool() {
                return Err("Failed to set color effect".to_string());
            }
        } else {
            // 修复: 不调用 MagUninitialize，而是设置恒等矩阵(无效果)
            // 这样可以避免第二次开启时上下文失效导致的"应用内灰度"bug
            let identity = MAGCOLOREFFECT {
                transform: [
                    1.0, 0.0, 0.0, 0.0, 0.0,
                    0.0, 1.0, 0.0, 0.0, 0.0,
                    0.0, 0.0, 1.0, 0.0, 0.0,
                    0.0, 0.0, 0.0, 1.0, 0.0,
                    0.0, 0.0, 0.0, 0.0, 1.0,
                ]
            };
            let _ = MagSetFullscreenColorEffect(&identity);
        }
    }
    Ok(())
}

#[tauri::command]
fn get_pixel_color(x: i32, y: i32) -> (u8, u8, u8) {
    unsafe {
        // 修复：使用 std::ptr::null_mut() 创建空指针 HWND
        let hdc = GetDC(HWND(std::ptr::null_mut())); 
        let color = GetPixel(hdc, x, y);
        ReleaseDC(HWND(std::ptr::null_mut()), hdc);
        
        let r = (color.0 & 0xFF) as u8;
        let g = ((color.0 >> 8) & 0xFF) as u8;
        let b = ((color.0 >> 16) & 0xFF) as u8;
        (r, g, b)
    }
}

#[tauri::command]
fn update_sync_coords(x: i32, y: i32) {
    SYNC_POS_X.store(x, Ordering::Relaxed);
    SYNC_POS_Y.store(y, Ordering::Relaxed);
}

#[tauri::command]
fn set_sync_hotkey(key_combo: String) {
    let parts: Vec<&str> = key_combo.split('+').collect();
    let mut mods = 0;
    let mut code = 0;

    for part in parts {
        match part.to_uppercase().as_str() {
            "CTRL" | "CONTROL" => mods |= 1,
            "SHIFT" => mods |= 2,
            "ALT" | "OPTION" => mods |= 4,
            "SPACE" => code = 0x20, // 修复: 添加空格键支持
            "XBUTTON1" | "MOUSE4" => code = VK_XBUTTON1.0 as i32,
            "XBUTTON2" | "MOUSE5" => code = VK_XBUTTON2.0 as i32,
            s if s.starts_with('F') && s.len() > 1 => {
                if let Ok(n) = s[1..].parse::<i32>() {
                    if n >= 1 && n <= 12 { code = 0x6F + n; }
                }
            },
            s => {
                // 处理普通字符 A-Z, 0-9
                if let Some(ch) = s.chars().next() {
                    // 对于数字键，ASCII '0' 是 48 (0x30)
                    // 对于字母，ASCII 'A' 是 65 (0x41)
                    // 这些正好对应 Windows VK Code
                    code = ch.to_ascii_uppercase() as i32;
                }
            }
        }
    }
    
    // 如果没有识别到主键(比如只按了Ctrl)，则不设置
    if code != 0 {
        SYNC_HOTKEY.store(code, Ordering::Relaxed);
        SYNC_MODS.store(mods, Ordering::Relaxed);
        log_to_file(format!("Hotkey Updated: VK={} Mods={}", code, mods));
    }
}

#[tauri::command]
fn set_sync_pick_key(key_char: String) {
    // 设置目标软件的取色键 (模拟按下)
    let mut pick = SYNC_PICK_KEY.lock().unwrap();
    *pick = key_char;
}

fn parse_hotkey(combo: &str) -> (i32, i32) {
    let parts: Vec<&str> = combo.split('+').collect();
    let mut mods = 0;
    let mut code = 0;
    for part in parts {
        match part.to_uppercase().as_str() {
            "CTRL" | "CONTROL" => mods |= 1,
            "SHIFT" => mods |= 2,
            "ALT" | "OPTION" => mods |= 4,
            "WIN" | "META" | "CMD" | "COMMAND" => mods |= 8, // 增加 Win 键支持
            "SPACE" => code = 0x20,
            s if s.starts_with('F') && s.len() > 1 => {
                if let Ok(n) = s[1..].parse::<i32>() { if n >= 1 && n <= 12 { code = 0x6F + n; } }
            },
            s => { if let Some(ch) = s.chars().next() { code = ch.to_ascii_uppercase() as i32; } }
        }
    }
    (code, mods)
}

#[tauri::command]
fn update_extra_hotkeys(gray: String, pick: String, moni: String, flags: i32) {
    let (gc, gm) = parse_hotkey(&gray);
    let (pc, pm) = parse_hotkey(&pick);
    let (mc, mm) = parse_hotkey(&moni);
    
    // 添加日志，确认前端传过来的值解析成了什么
    log_to_file(format!("Global Hotkeys Updated: Gray={:?}({}), Pick={:?}({}), Moni={:?}({}), Flags={}", 
        &gray, gc, &pick, pc, &moni, mc, flags));

    HK_GRAY_CODE.store(gc, Ordering::Relaxed);
    HK_GRAY_MODS.store(gm, Ordering::Relaxed);
    HK_PICK_CODE.store(pc, Ordering::Relaxed);
    HK_PICK_MODS.store(pm, Ordering::Relaxed);
    HK_MONI_CODE.store(mc, Ordering::Relaxed);
    HK_MONI_MODS.store(mm, Ordering::Relaxed);
    
    HK_GLOBAL_FLAGS.store(flags, Ordering::Relaxed);
}

#[tauri::command]
fn ensure_window_clickable(app_handle: tauri::AppHandle, label: String) -> Result<(), String> {
    let window = app_handle.get_webview_window(&label).ok_or("Window not found")?;
    
    #[cfg(target_os = "windows")]
    unsafe {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let hwnd_val = HWND(hwnd as _);
        
        // 修复 E0308: 使用 std::ptr::null_mut() 代替 0
        // SWP_FRAMECHANGED 强制系统重新计算窗口样式，有助于解决点击穿透卡死的问题
        // [修复] 添加 SWP_NOACTIVATE 防止抢焦点
        let _ = SetWindowPos(
            hwnd_val, 
            HWND(std::ptr::null_mut()), 
            0, 0, 0, 0, 
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED | windows::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE
        );
    }
    Ok(())
}

#[tauri::command]
fn force_window_clickable(app_handle: tauri::AppHandle, label: String) -> Result<(), String> {
    let window = app_handle.get_webview_window(&label).ok_or("Window not found")?;
    
    #[cfg(target_os = "windows")]
    unsafe {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let hwnd_val = HWND(hwnd as _);
        
        // 强制移除所有可能影响点击的样式
        let mut style = GetWindowLongW(hwnd_val, GWL_EXSTYLE);
        let transparent = WS_EX_TRANSPARENT.0 as i32;
        let layered = WS_EX_LAYERED.0 as i32;
        
        // 移除透明和穿透属性
        style &= !transparent;
        style &= !layered;
        
        SetWindowLongW(hwnd_val, GWL_EXSTYLE, style);
        
        // 强制刷新窗口
        let _ = SetWindowPos(
            hwnd_val, 
            HWND(std::ptr::null_mut()), 
            0, 0, 0, 0, 
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED
        );
        
        log_to_file(format!("ForceWindowClickable: Style changed to {:X} for {}", style, label));
    }
    Ok(())
}

#[tauri::command]
fn log_window_style(app_handle: tauri::AppHandle, label: String) {
    if let Some(window) = app_handle.get_webview_window(&label) {
         #[cfg(target_os = "windows")]
         unsafe {
             if let Ok(hwnd_ptr) = window.hwnd() {
                 let hwnd = HWND(hwnd_ptr.0 as _);
                 let _style = GetWindowLongW(hwnd, GWL_EXSTYLE);
                 // println!("[Style Debug] Window '{}' ExStyle: {:X}", label, style); // Issue 5: Removed
             }
         }
    }
}

// [Issue 3] 新增：获取详细的窗口树形结构
#[derive(serde::Serialize)]
struct WindowInfo {
    title: String,
    width: i32,
    height: i32,
    hwnd: isize,
}

#[derive(serde::Serialize)]
struct AppGroup {
    app_name: String,
    windows: Vec<WindowInfo>,
}

#[tauri::command]
fn get_app_windows_tree() -> Vec<AppGroup> {
    use std::collections::HashMap;
    let mut groups: HashMap<String, Vec<WindowInfo>> = HashMap::new();

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if IsWindowVisible(hwnd).as_bool() {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if let Ok(process) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) {
                let mut buffer = [0u16; 1024];
                if GetModuleBaseNameW(process, None, &mut buffer) > 0 {
                    let app_name = String::from_utf16_lossy(&buffer).trim_matches('\0').to_string();
                    let ignore = ["svchost.exe", "SearchHost.exe", "StartMenuExperienceHost.exe", "TextInputHost.exe"];
                    
                    if !app_name.is_empty() && !ignore.contains(&app_name.as_str()) {
                        let length = GetWindowTextLengthW(hwnd);
                        let mut title = String::new();
                        if length > 0 {
                            let mut buf = vec![0u16; (length + 1) as usize];
                            windows::Win32::UI::WindowsAndMessaging::GetWindowTextW(hwnd, &mut buf);
                            title = String::from_utf16_lossy(&buf).trim_matches('\0').to_string();
                        }

                        // 获取尺寸
                        use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
                        let mut rect = RECT::default();
                        let mut width = 0;
                        let mut height = 0;
                        if GetWindowRect(hwnd, &mut rect).is_ok() {
                            width = rect.right - rect.left;
                            height = rect.bottom - rect.top;
                        }

                        // 仅收集有尺寸的窗口，解决 1x1 问题，但保留主窗口可能没标题的情况
                        if width > 10 && height > 10 {
                            let groups_ptr = lparam.0 as *mut HashMap<String, Vec<WindowInfo>>;
                            let entry = (*groups_ptr).entry(app_name).or_insert(Vec::new());
                            entry.push(WindowInfo {
                                title: if title.is_empty() { "Untitled Window".to_string() } else { title },
                                width,
                                height,
                                hwnd: hwnd.0 as isize,
                            });
                        }
                    }
                }
                let _ = windows::Win32::Foundation::CloseHandle(process);
            }
        }
        BOOL(1)
    }

    unsafe {
        let param = LPARAM(&mut groups as *mut _ as isize);
        let _ = EnumWindows(Some(enum_proc), param);
    }

    // 转换为 Vec 并排序
    let mut result: Vec<AppGroup> = groups.into_iter()
        .map(|(k, mut v)| {
            // 按面积从大到小排序窗口，方便用户找主窗口
            v.sort_by(|a, b| (b.width * b.height).cmp(&(a.width * a.height)));
            AppGroup { app_name: k, windows: v }
        })
        .collect();
    
    result.sort_by(|a, b| a.app_name.cmp(&b.app_name));
    result
}

#[tauri::command]
fn start_global_hotkey_listener(app_handle: tauri::AppHandle) {
    // 关键修复：防止 React 重复挂载导致开启多个监听线程
    if LISTENER_RUNNING.swap(true, Ordering::Relaxed) {
        log_to_file("Listener already running, skipping...".to_string());
        return;
    }

    thread::spawn(move || {
        log_to_file("Global Hotkey Listener Started".to_string());
        // 简单的防抖状态记录
        let mut last_sync = false;
        let mut last_gray = false;
        let mut last_pick = false;
        let mut last_moni = false;

        loop {
            thread::sleep(Duration::from_millis(10));

            unsafe {
                // 获取当前修饰键状态
                let mut mods = 0;
                if (GetAsyncKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0 { mods |= 1; }
                if (GetAsyncKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000) != 0 { mods |= 2; }
                if (GetAsyncKeyState(VK_MENU.0 as i32) as u16 & 0x8000) != 0 { mods |= 4; }
                if (GetAsyncKeyState(0x5B) as u16 & 0x8000) != 0 { mods |= 8; } // VK_LWIN

                // 1. Sync Macro Check
                if SYNC_ENABLED.load(Ordering::Relaxed) {
                    // [新增] 关键检查：如果在录制热键，则跳过触发检查
                    if IS_RECORDING_HOTKEY.load(Ordering::Relaxed) {
                        continue; 
                    }
                    let code = SYNC_HOTKEY.load(Ordering::Relaxed);
                    let target_mods = SYNC_MODS.load(Ordering::Relaxed);
                    if code != 0 {
                        let pressed = (GetAsyncKeyState(code) as u16 & 0x8000) != 0;
                        if pressed && !last_sync && mods == target_mods {
                            log_to_file(format!("Listener: Sync Key Detected (VK={}). Checking Process...", code));
                            // 进程检查逻辑...
                            let should_trigger = {
                                // [修复] 处理锁中毒 (PoisonError)，防止因其他线程 Panic 导致监听器崩溃
                                let target_lock = match TARGET_PROCESS_NAME.lock() {
                                    Ok(guard) => guard,
                                    Err(poisoned) => poisoned.into_inner(),
                                };
                                if let Some(target_name) = &*target_lock {
                                    if target_name.is_empty() { true } else {
                                        let hwnd = GetForegroundWindow();
                                        let mut pid = 0;
                                        GetWindowThreadProcessId(hwnd, Some(&mut pid));
                                        let mut match_found = false;
                                        if let Ok(process) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) {
                                            let mut buffer = [0u16; 1024];
                                            if GetModuleBaseNameW(process, None, &mut buffer) > 0 {
                                                let name = String::from_utf16_lossy(&buffer).trim_matches('\0').to_string();
                                                if name.eq_ignore_ascii_case(target_name) { match_found = true; }
                                            }
                                            let _ = windows::Win32::Foundation::CloseHandle(process);
                                        }
                                        match_found
                                    }
                                } else { true }
                            };
                            if should_trigger { 
                                // 修复：放入新线程执行，防止阻塞监听循环导致无法检测松开或其他按键
                                let app_handle = app_handle.clone();
                                thread::spawn(move || {
                                    perform_color_sync_macro(&app_handle);
                                });
                            }
                        }
                        last_sync = pressed;
                    }
                }

                // 2. Extra Hotkeys Check
                let flags = HK_GLOBAL_FLAGS.load(Ordering::Relaxed);
                
                // Gray (Flag 1)
                if (flags & 1) != 0 {
                    let code = HK_GRAY_CODE.load(Ordering::Relaxed);
                    if code != 0 {
                        let pressed = (GetAsyncKeyState(code) as u16 & 0x8000) != 0;
                        if pressed && !last_gray {
                            // 增加日志：只要按下了键，不管修饰符对不对，都记录，方便排查
                            // 注意：这可能会刷屏，仅在 pressed 变为 true 时记录一次
                            log_to_file(format!("Global Key Detected: Gray(VK={}), CurrentMods={}, TargetMods={}", 
                                code, mods, HK_GRAY_MODS.load(Ordering::Relaxed)));
                            
                            if mods == HK_GRAY_MODS.load(Ordering::Relaxed) {
                                log_to_file("-> Triggering Gray Event".to_string());
                                let _ = app_handle.emit("global-hotkey", "gray");
                            }
                        }
                        last_gray = pressed;
                    }
                }

                // Pick (Flag 2)
                if (flags & 2) != 0 {
                    let code = HK_PICK_CODE.load(Ordering::Relaxed);
                    if code != 0 {
                        let pressed = (GetAsyncKeyState(code) as u16 & 0x8000) != 0;
                        if pressed && !last_pick && mods == HK_PICK_MODS.load(Ordering::Relaxed) {
                            let _ = app_handle.emit("global-hotkey", "pick");
                        }
                        last_pick = pressed;
                    }
                }

                // Monitor (Flag 4)
                if (flags & 4) != 0 {
                    let code = HK_MONI_CODE.load(Ordering::Relaxed);
                    if code != 0 {
                        let pressed = (GetAsyncKeyState(code) as u16 & 0x8000) != 0;
                        if pressed && !last_moni && mods == HK_MONI_MODS.load(Ordering::Relaxed) {
                            let _ = app_handle.emit("global-hotkey", "monitor");
                        }
                        last_moni = pressed;
                    }
                }
            }
        }
    });
}


// --- 调试辅助：按空格键继续 ---
fn wait_for_debug_step(app: &tauri::AppHandle, step_name: &str) {
    let msg = format!("DEBUG [PAUSE]: Press SPACE to execute -> {}", step_name);
    log_to_file(msg.clone());
    // 通知前端显示调试步骤
    let _ = app.emit("macro-debug-step", step_name);

    // 等待按下空格
    loop {
        unsafe {
            if (GetAsyncKeyState(0x20) as u16 & 0x8000) != 0 { break; }
        }
        thread::sleep(Duration::from_millis(10));
    }
    // 等待松开空格 (防止一次按键跳过多步)
    loop {
        unsafe {
            if (GetAsyncKeyState(0x20) as u16 & 0x8000) == 0 { break; }
        }
        thread::sleep(Duration::from_millis(10));
    }
    log_to_file(format!("DEBUG [RESUME]: Executing -> {}", step_name));
}

// 增强版吸色宏 (带调试步进)
fn perform_color_sync_macro(app: &tauri::AppHandle) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE, SW_HIDE};
    
    // 1. 获取目标窗口和按键配置
    let target_app_hwnd = unsafe { GetForegroundWindow() };
    let target_hwnd_val = target_app_hwnd.0 as usize;
    
    // [优化] 使用 unwrap_or_default 防止锁中毒，并克隆字符串
    let pick_key_str = SYNC_PICK_KEY.lock().map(|k| k.clone()).unwrap_or_default();
    if pick_key_str.is_empty() { return; }
    
    // [优化] 安全解包：如果 sync_spot 窗口意外丢失，静默失败而不是崩溃
    let spot_window = match app.get_webview_window("sync_spot") {
        Some(w) => w,
        None => {
            log_to_file("Error: Sync spot window not found, macro aborted.".to_string());
            return;
        }
    };
    
    thread::spawn(move || {
        // --- 内部函数：发送按键 (使用扫描码绕过输入法) ---
        unsafe fn send_key(vk: u16, up: bool) {
            // [修复] 获取硬件扫描码 (0 = MAPVK_VK_TO_VSC)
            let scan_code = MapVirtualKeyW(vk as u32, MAP_VIRTUAL_KEY_TYPE(0)) as u16;
            
            // 组合标志位：添加 KEYEVENTF_SCANCODE
            let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
            flags |= KEYEVENTF_SCANCODE;

            let input = INPUT {
                r#type: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_KEYBOARD,
                Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    ki: KEYBDINPUT { 
                        wVk: VIRTUAL_KEY(vk), // 仍保留 VK 以兼容部分应用
                        wScan: scan_code,     // [重点] 物理扫描码
                        dwFlags: flags,       // [重点] 标记为使用扫描码
                        time: 0, 
                        dwExtraInfo: 0 
                    }
                }
            };
            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }

        // --- 内部函数：解析按键 ---
        fn get_vk_code(key: &str) -> Option<u16> {
            match key.to_uppercase().as_str() {
                "SHIFT" => Some(0x10), "CTRL" | "CONTROL" => Some(0x11), "ALT" | "OPTION" => Some(0x12), "SPACE" => Some(0x20),
                s if s.len() == 1 => {
                    let c = s.chars().next().unwrap();
                    if c >= 'A' && c <= 'Z' { Some(c as u16) } else if c >= '0' && c <= '9' { Some(c as u16) } else { None }
                },
                s if s.starts_with('F') => if let Ok(n) = s[1..].parse::<u16>() { if n >= 1 && n <= 12 { Some(0x6F + n) } else { None } } else { None },
                _ => None
            }
        }

        unsafe {
            // [修复] 安全获取句柄，防止窗口销毁时崩溃
            let hwnd_val = match spot_window.hwnd() {
                Ok(h) => h.0 as isize,
                Err(_) => return, // 窗口已失效，静默终止
            };
            let spot_hwnd = HWND(hwnd_val as _);

            // 2. 获取鼠标位置
            let mut original_pos = POINT::default();
            let _ = GetCursorPos(&mut original_pos);
            
            // --- 步骤 1: 显示色块 (立即执行) ---
            // 放大尺寸到 20x20，并居中于鼠标
            let current_style = GetWindowLongW(spot_hwnd, GWL_EXSTYLE);
            let target_style = current_style | WS_EX_TOOLWINDOW.0 as i32 | WS_EX_NOACTIVATE.0 as i32 | WS_EX_LAYERED.0 as i32 | WS_EX_TRANSPARENT.0 as i32;
            SetWindowLongW(spot_hwnd, GWL_EXSTYLE, target_style);

            let _ = SetWindowPos(
                spot_hwnd, HWND_TOPMOST, 
                original_pos.x - 10, original_pos.y - 10, 20, 20, 
                SWP_NOACTIVATE | windows::Win32::UI::WindowsAndMessaging::SWP_SHOWWINDOW
            );
            let _ = ShowWindow(spot_hwnd, SW_SHOWNOACTIVATE);
            
            // [优化] 等待渲染：增加到 50ms，适应低刷新率屏幕或高负载 CPU
            thread::sleep(Duration::from_millis(50));

            // --- 步骤 2: 触发取色 (按键) ---
            let parts: Vec<&str> = pick_key_str.split('+').collect();
            let mut keys_to_release = Vec::new();

            for part in &parts {
                if let Some(vk) = get_vk_code(part) {
                    send_key(vk, false); // Press
                    keys_to_release.push(vk);
                }
            }
            
            // [优化] 等待软件响应：增加到 60ms，某些重型软件(如PS)切换工具较慢
            thread::sleep(Duration::from_millis(60));

            // --- 步骤 3: 模拟点击 ---
            // 再次校准鼠标位置
            let _ = SetCursorPos(original_pos.x, original_pos.y);
            
            let input_down = INPUT {
                r#type: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_MOUSE,
                Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    mi: MOUSEINPUT { dwFlags: MOUSEEVENTF_LEFTDOWN, ..Default::default() }
                }
            };
            SendInput(&[input_down], std::mem::size_of::<INPUT>() as i32);
            
            // [调整] 点击保持时间 (增加到 30ms，防止过快被忽略)
            thread::sleep(Duration::from_millis(30));
            
            let input_up = INPUT {
                r#type: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_MOUSE,
                Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    mi: MOUSEINPUT { dwFlags: MOUSEEVENTF_LEFTUP, ..Default::default() }
                }
            };
            SendInput(&[input_up], std::mem::size_of::<INPUT>() as i32);

            // --- 步骤 4: 释放按键 ---
            thread::sleep(Duration::from_millis(20));
            for vk in keys_to_release.iter().rev() {
                send_key(*vk, true); // Release
            }

            // [关键修复] 延长色块存活时间
            // 在点击和释放按键全部完成后，再额外多留 150ms，确保软件完成取色采样
            thread::sleep(Duration::from_millis(150));

            // --- 步骤 5: 隐藏色块 ---
            let _ = ShowWindow(spot_hwnd, SW_HIDE);
            
            // 归还焦点
            let safe_target_hwnd = HWND(target_hwnd_val as *mut _);
            if safe_target_hwnd.0 != std::ptr::null_mut() {
                let _ = SetForegroundWindow(safe_target_hwnd);
            }
            
            log_to_file("Macro [Robust]: Done.".to_string());
        }
    });
}


  fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    // [新增] 单实例插件：检测到重复启动时，唤醒已存在的窗口
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(win) = app.get_webview_window("main") {
            // 执行与托盘双击完全一致的“强制显示”逻辑
            let _ = win.emit("pip-wake", ());
            let _ = win.set_skip_taskbar(false);
            if win.is_minimized().unwrap_or(false) {
                let _ = win.unminimize();
            }
            let _ = win.show();
            let _ = win.set_focus();
        }
    }))
    .manage(WindowState {
      is_topmost: Mutex::new(false),
    })
    .on_window_event(|window, event| {
        if let tauri::WindowEvent::Destroyed = event {
            let label = window.label().to_string();
            if label.starts_with("monitor-") {
                // 自动清理对应的 WGC 会话
                wgc::stop_wgc_session(label);
            }
        }
    })
    .setup(|app| {
        // --- 托盘初始化逻辑 ---
        clean_temp_images();

        let show_i = MenuItem::with_id(app, "show", "显示界面 (Show)", true, None::<&str>)?;
        let reset_i = MenuItem::with_id(app, "reset", "重置位置 (Reset Pos)", true, None::<&str>)?;
        let quit_i = MenuItem::with_id(app, "quit", "退出 (Exit)", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show_i, &reset_i, &quit_i])?;

        let _tray = TrayIconBuilder::with_id("tray")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .icon(app.default_window_icon().unwrap().clone())
            .on_menu_event(|app, event| match event.id.as_ref() {
                "quit" => app.exit(0),
                "show" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                        if win.is_minimized().unwrap_or(false) { let _ = win.unminimize(); }
                    }
                },
                "reset" => {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.unminimize();
                        let _ = win.center(); // 重置到屏幕中心
                        let _ = win.set_focus();
                    }
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    match event {
                        // 左键单击 OR 双击：统一执行“强制显示”逻辑
                        TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } 
                        | TrayIconEvent::DoubleClick { button: tauri::tray::MouseButton::Left, .. } => {
                            let _ = win.emit("pip-wake", ());
                            let _ = win.set_skip_taskbar(false);
                            if win.is_minimized().unwrap_or(false) {
                                let _ = win.unminimize();
                            }
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                        _ => {}
                    }
                }
            })
            .build(app)?;
        // --------------------
        Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        set_window_topmost, 
        capture_region,
        capture_window_thumbnail,
        open_color_filter_settings, 
        trigger_system_grayscale,
        set_fullscreen_grayscale,
        check_system_grayscale_status, 
        get_mouse_pos,
        get_pixel_color,
        is_mouse_down,
        set_ignore_cursor_events,
        init_mag_api,
        start_magnifier,
        update_magnifier_size,
        update_magnifier_source,
        toggle_pip_window,
        toggle_overlay,
        update_sync_coords,
        set_sync_hotkey,
        set_sync_pick_key, 
        log_to_file,
        simulate_key_sequence,
        start_global_hotkey_listener,
        get_running_apps,
        set_target_process_name,
        set_sync_enabled,
        update_extra_hotkeys,
        get_window_rect,
        get_window_hwnd,
        get_os_build_version,
        is_window_minimized,
        diagnose_window,
        wgc::start_wgc_session,
        wgc::stop_wgc_session,
        wgc::update_wgc_resize,
        wgc::pause_wgc_session,
        wgc::resume_wgc_session,
        wgc::update_wgc_filter,
        wgc::update_wgc_mirror,
        ensure_window_clickable,
        log_window_style,
        force_window_clickable,
        get_app_windows_tree,
        save_temp_image,
        clean_temp_images,
        read_image_as_base64,
        save_clipboard_to_temp,
        set_hotkey_recording_status,
        save_config_file, // 本地保存
        load_config_file  // 本地读取
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}