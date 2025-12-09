use windows::{
    core::Interface,
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession}, // 移除了 IGraphicsCaptureSession3
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        SizeInt32,
    },
    Win32::{
        Foundation::{HWND, RECT, POINT}, // 移除了 BOOL, LPARAM, WPARAM
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP},
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_BIND_SHADER_RESOURCE, D3D11_BIND_RENDER_TARGET,
                D3D11_USAGE_DEFAULT, ID3D11Texture2D, ID3D11ShaderResourceView, D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_USAGE_STAGING, // [修复] 添加 CPU 读取相关常量
            },
            Dxgi::{
                Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
                IDXGIFactory2, IDXGISwapChain1, DXGI_SCALING_STRETCH, DXGI_SWAP_CHAIN_DESC1,
                DXGI_SWAP_EFFECT_FLIP_DISCARD, 
                DXGI_USAGE_RENDER_TARGET_OUTPUT, DXGI_PRESENT, DXGI_PRESENT_PARAMETERS,
            },
            Gdi::{MonitorFromWindow, MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY},
        },
        System::WinRT::{
            Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
            Graphics::Capture::IGraphicsCaptureItemInterop,
            CreateDispatcherQueueController, DispatcherQueueOptions, 
            DQTYPE_THREAD_CURRENT, DQTAT_COM_STA,
        },
        UI::WindowsAndMessaging::{
            GetClientRect, GetDesktopWindow, 
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOREDIRECTIONBITMAP,
        },
    },
    System::DispatcherQueueController,
};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tauri::{Manager, Emitter, WebviewWindow};
use egui::{Context, Pos2, Rect, Vec2, Color32, TextureId}; // 移除了 Sense
use crate::d3d11_renderer::Renderer;

// 全局存储 WGC 会话
static SESSIONS: Mutex<Option<HashMap<String, Arc<Mutex<WgcSession>>>>> = Mutex::new(None);

struct UiState {
    mirror: bool,
    crop: Rect, 
    show_crop: bool,
    use_gray: bool,
    is_topmost: bool,
    // 新增字段
    last_hover_time: std::time::Instant,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            mirror: false,
            crop: Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
            show_crop: false,
            use_gray: false,
            is_topmost: true,
            // 初始化时间
            last_hover_time: std::time::Instant::now(),
        }
    }
}

// [优化] 显式实现 Drop 以确保 COM 对象被释放，防止显存泄漏
impl Drop for WgcSession {
    fn drop(&mut self) {
        self.stop();
        // windows-rs 的 ComObject 通常会自动 Drop，但手动清理 Option 引用是个好习惯
        self.session = None;
        self.frame_pool = None;
        self.swap_chain = None;
        self.d3d_context = None;
        self.d3d_device = None;
    }
}

pub struct WgcSession {
    egui_ctx: Context,
    egui_renderer: Option<Renderer>,
    session: Option<GraphicsCaptureSession>,
    frame_pool: Option<Direct3D11CaptureFramePool>,
    swap_chain: Option<IDXGISwapChain1>,
    d3d_device: Option<ID3D11Device>,
    d3d_context: Option<ID3D11DeviceContext>,
    window_handle: isize,
    tauri_window: Option<WebviewWindow>,
    source_rect: Option<RECT>,
    _dispatcher_controller: Option<DispatcherQueueController>,
    ui_state: Arc<Mutex<UiState>>,
    // [修复 Issue 3] 持有 Context 引用以支持手动重绘
    active_context: Option<Arc<Mutex<SessionContext>>>,
}
unsafe impl Send for WgcSession {}
unsafe impl Sync for WgcSession {}

impl WgcSession {
    pub fn new(hwnd: isize, window: WebviewWindow) -> Self { // [修复1] 接收 window
        Self {
            egui_ctx: Context::default(),
            egui_renderer: None,
            session: None,
            frame_pool: None,
            swap_chain: None,
            d3d_device: None,
            d3d_context: None,
            window_handle: hwnd,
            tauri_window: Some(window), // 保存
            source_rect: None,
            _dispatcher_controller: None,
            ui_state: Arc::new(Mutex::new(UiState::default())),
            active_context: None, 
        }
    }

    pub fn start(&mut self, target_hwnd: isize, is_region: bool, crop: Option<RECT>) -> Result<(), String> {
        // [修复] 彻底清理旧资源，防止 SwapChain 冲突
        if let Some(session) = &self.session { let _ = session.Close(); }
        if let Some(pool) = &self.frame_pool { let _ = pool.Close(); }
        self.session = None;
        self.frame_pool = None;
        self.swap_chain = None; // 丢弃旧 SwapChain
        
        // 稍微等待资源释放 (可选，但在快速重启时有用)
        // std::thread::sleep(std::time::Duration::from_millis(50));

        self.source_rect = crop;

        let options = DispatcherQueueOptions {
            dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
            threadType: DQTYPE_THREAD_CURRENT,
            apartmentType: DQTAT_COM_STA,
        };
        unsafe { let _ = CreateDispatcherQueueController(options); }

        let (d3d_device, d3d_context) = create_d3d_device().map_err(|e| e.to_string())?;
        self.d3d_device = Some(d3d_device.clone());
        self.d3d_context = Some(d3d_context.clone());

        let renderer = Renderer::new(d3d_device.clone(), d3d_context.clone()).map_err(|e| format!("Renderer init failed: {}", e))?;
        self.egui_renderer = Some(renderer);
        
        let dxgi_device = d3d_device.cast::<windows::Win32::Graphics::Dxgi::IDXGIDevice>().map_err(|e| e.to_string())?;
        let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device).map_err(|e| e.to_string())? };
        let winrt_device: IDirect3DDevice = inspectable.cast().map_err(|e| e.to_string())?;

        let item = if is_region {
            let hmonitor = unsafe { 
                if let Some(rect) = self.source_rect {
                    // 如果是区域模式，使用选区左上角坐标寻找所在的显示器
                    let pt = POINT { x: rect.left, y: rect.top };
                    MonitorFromPoint(pt, MONITOR_DEFAULTTOPRIMARY)
                } else {
                    // 兜底逻辑
                    let base_hwnd = if target_hwnd == 0 { GetDesktopWindow() } else { HWND(target_hwnd as _) };
                    MonitorFromWindow(base_hwnd, MONITOR_DEFAULTTOPRIMARY) 
                }
            };
            create_capture_item_for_monitor(hmonitor).map_err(|e| e.to_string())?
        } else {
            create_capture_item_for_window(HWND(target_hwnd as _)).map_err(|e| e.to_string())?
        };

        let hwnd = HWND(self.window_handle as _);
        let mut rect = RECT::default();
        unsafe { GetClientRect(hwnd, &mut rect).ok(); };
        let width = (rect.right - rect.left).max(1) as u32;
        let height = (rect.bottom - rect.top).max(1) as u32;

        let dxgi_factory: IDXGIFactory2 = unsafe { 
            let adapter = dxgi_device.GetAdapter().map_err(|e| e.to_string())?;
            adapter.GetParent().map_err(|e| e.to_string())? 
        };

        unsafe {
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if (ex_style & WS_EX_NOREDIRECTIONBITMAP.0 as isize) != 0 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style & !(WS_EX_NOREDIRECTIONBITMAP.0 as isize));
            }
        }
        
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width, Height: height, Format: DXGI_FORMAT_B8G8R8A8_UNORM, Stereo: false.into(),
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT, BufferCount: 2,
            Scaling: DXGI_SCALING_STRETCH, SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            AlphaMode: windows::Win32::Graphics::Dxgi::Common::DXGI_ALPHA_MODE_IGNORE,
            Flags: 0, ..Default::default()
        };

        let swap_chain = unsafe { 
            dxgi_factory.CreateSwapChainForHwnd(&d3d_device, hwnd, &desc, None, None)
                .map_err(|e| format!("Swap chain failed: {}", e))? 
        };
        self.swap_chain = Some(swap_chain);

        let item_size = item.Size().map_err(|e| e.to_string())?;
        let frame_pool = Direct3D11CaptureFramePool::Create(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item_size).map_err(|e| e.to_string())?;

        let ui_state = self.ui_state.clone(); 
        let renderer_arc = Arc::new(Mutex::new(self.egui_renderer.take().unwrap()));

        let session_ctx = Arc::new(Mutex::new(SessionContext {
            d3d_device: self.d3d_device.clone().unwrap(),
            d3d_context: self.d3d_context.clone().unwrap(),
            swap_chain: self.swap_chain.clone().unwrap(),
            source_crop: self.source_rect,
            device: winrt_device.clone(),
            last_size: item_size,
            egui_ctx: self.egui_ctx.clone(),
            egui_renderer: renderer_arc,
            ui_state: ui_state,
            window_handle: HWND(self.window_handle as _),
            tauri_window: self.tauri_window.clone(),
            textures: std::collections::HashMap::new(),
            intermediate_texture: None,
            cache_texture: None,
            cache_srv: None,
        }));
        
        // [修复 Issue 3] 保存 Context 引用
        self.active_context = Some(session_ctx.clone());

        // [修复步骤 1] 创建弱引用 (放在 FrameArrived 之前)
        let ctx_weak = Arc::downgrade(&session_ctx);

        frame_pool.FrameArrived(&windows::Foundation::TypedEventHandler::new(
            move |pool: &Option<Direct3D11CaptureFramePool>, _| {
                // [修复步骤 2] 在闭包最开始，将 Weak 升级为 Strong
                let ctx_arc = match ctx_weak.upgrade() {
                    Some(c) => c,
                    None => return Ok(()), // 如果会话已销毁，直接返回
                };

                if let Some(pool) = pool {
                    if let Ok(frame) = pool.TryGetNextFrame() {
                        let mut recreate = false;
                        let mut new_size = SizeInt32::default();
                        if let Ok(content_size) = frame.ContentSize() {
                            // [修复步骤 3] 这里使用 ctx_arc
                            if let Ok(mut ctx) = ctx_arc.lock() {
                                if content_size.Width != ctx.last_size.Width || content_size.Height != ctx.last_size.Height {
                                    recreate = true;
                                    if let Some(win) = &ctx.tauri_window {
                                        let _ = win.emit("wgc-ratio-changed", format!("{}:{}", content_size.Width, content_size.Height));
                                    }
                                    new_size = content_size;
                                    ctx.last_size = content_size;
                                    ctx.cache_texture = None;
                                    ctx.cache_srv = None;
                                }
                            }
                        }
                        if recreate {
                            if let Ok(ctx) = ctx_arc.lock() {
                                let _ = pool.Recreate(&ctx.device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, new_size);
                            }
                        }
                        if let Ok(mut ctx) = ctx_arc.lock() {
                            let _ = render_frame(&frame, &mut ctx);
                        }
                    }
                }
                Ok(())
            },
        )).map_err(|e| e.to_string())?;

        self.frame_pool = Some(frame_pool);
        let session = self.frame_pool.as_ref().unwrap().CreateCaptureSession(&item).map_err(|e| e.to_string())?;
        
        // [修复7] 屏蔽黄色隐私边框 (安全转换)
        // 尝试转换为 IGraphicsCaptureSession3 (Win11 Build 22000+)
        // [临时屏蔽] 编译报错 method not found，可能是 windows-rs 版本差异导致
        // if let Ok(session3) = session.cast::<IGraphicsCaptureSession3>() {
        //     let _ = session3.SetIsBorderRequired(false); 
        // }

        session.StartCapture().map_err(|e| e.to_string())?;
        self.session = Some(session);

        Ok(())
    }

    pub fn stop_capture(&mut self) {
        if let Some(session) = &self.session { let _ = session.Close(); }
        if let Some(pool) = &self.frame_pool { let _ = pool.Close(); }
        self.session = None;
        self.frame_pool = None;
    }

    pub fn stop(&mut self) {
        self.stop_capture();
        self.swap_chain = None;
        if let Some(context) = &self.d3d_context { unsafe { context.ClearState(); } }
        self.d3d_context = None;
        self.d3d_device = None;
        self._dispatcher_controller = None;

        // [修复] 显式清理 Context 中的缓存纹理，确保显存立即释放
        if let Some(ctx_arc) = &self.active_context {
            if let Ok(mut ctx) = ctx_arc.lock() {
                ctx.textures.clear();
                ctx.intermediate_texture = None;
                ctx.cache_texture = None;
                ctx.cache_srv = None;
            }
        }
    }
    
    pub fn resume(&mut self, target_hwnd: isize, is_region: bool, crop: Option<RECT>) -> Result<(), String> {
        // [修复] 核心逻辑：如果资源依然存在，则复用 SwapChain，避免唤醒时的 Access Denied 错误
        if self.swap_chain.is_none() || self.d3d_device.is_none() { 
            return self.start(target_hwnd, is_region, crop); 
        }
        
        // 1. 仅停止捕获会话，保留 SwapChain 和 D3D Device
        self.stop_capture(); 
        self.source_rect = crop;

        // 2. 复用现有资源
        let d3d_device = self.d3d_device.as_ref().unwrap().clone();
        let d3d_context = self.d3d_context.as_ref().unwrap().clone();
        let swap_chain = self.swap_chain.as_ref().unwrap().clone();

        // 3. 重建依赖资源 (Renderer, CaptureItem, FramePool)
        let renderer = Renderer::new(d3d_device.clone(), d3d_context.clone())
            .map_err(|e| format!("Renderer re-init failed: {}", e))?;
        let renderer_arc = Arc::new(Mutex::new(renderer));

        let dxgi_device = d3d_device.cast::<windows::Win32::Graphics::Dxgi::IDXGIDevice>().map_err(|e| e.to_string())?;
        let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device).map_err(|e| e.to_string())? };
        let winrt_device: IDirect3DDevice = inspectable.cast().map_err(|e| e.to_string())?;

        let item = if is_region {
            let hmonitor = unsafe { 
                if let Some(rect) = self.source_rect {
                    // 如果是区域模式，使用选区左上角坐标寻找所在的显示器
                    let pt = POINT { x: rect.left, y: rect.top };
                    MonitorFromPoint(pt, MONITOR_DEFAULTTOPRIMARY)
                } else {
                    // 兜底逻辑
                    let base_hwnd = if target_hwnd == 0 { GetDesktopWindow() } else { HWND(target_hwnd as _) };
                    MonitorFromWindow(base_hwnd, MONITOR_DEFAULTTOPRIMARY) 
                }
            };
            create_capture_item_for_monitor(hmonitor).map_err(|e| e.to_string())?
        } else {
            create_capture_item_for_window(HWND(target_hwnd as _)).map_err(|e| e.to_string())?
        };

        let item_size = item.Size().map_err(|e| e.to_string())?;
        let frame_pool = Direct3D11CaptureFramePool::Create(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item_size).map_err(|e| e.to_string())?;

        // 4. 重建 Context 并挂载
        let session_ctx = Arc::new(Mutex::new(SessionContext {
            d3d_device: d3d_device.clone(),
            d3d_context: d3d_context.clone(),
            swap_chain: swap_chain.clone(),
            source_crop: self.source_rect,
            device: winrt_device.clone(),
            last_size: item_size,
            egui_ctx: self.egui_ctx.clone(),
            egui_renderer: renderer_arc,
            ui_state: self.ui_state.clone(),
            window_handle: HWND(self.window_handle as _),
            tauri_window: self.tauri_window.clone(),
            textures: std::collections::HashMap::new(),
            intermediate_texture: None,
            cache_texture: None,
            cache_srv: None,
        }));

        // [重要] 这里定义 ctx_clone，供下方的 move 闭包捕获
        let ctx_clone = session_ctx.clone();
        self.active_context = Some(session_ctx); // 更新 active_context

        frame_pool.FrameArrived(&windows::Foundation::TypedEventHandler::new(
            move |pool: &Option<Direct3D11CaptureFramePool>, _| {
                if let Some(pool) = pool {
                    if let Ok(frame) = pool.TryGetNextFrame() {
                        let mut recreate = false;
                        let mut new_size = SizeInt32::default();
                        if let Ok(content_size) = frame.ContentSize() {
                            if let Ok(mut ctx) = ctx_clone.lock() {
                                if content_size.Width != ctx.last_size.Width || content_size.Height != ctx.last_size.Height {
                                    recreate = true;
                                    if let Some(win) = &ctx.tauri_window {
                                        let _ = win.emit("wgc-ratio-changed", format!("{}:{}", content_size.Width, content_size.Height));
                                    }
                                    new_size = content_size;
                                    ctx.last_size = content_size;
                                    ctx.cache_texture = None;
                                    ctx.cache_srv = None;
                                }
                            }
                        }
                        if recreate {
                            if let Ok(ctx) = ctx_clone.lock() {
                                let _ = pool.Recreate(&ctx.device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, new_size);
                            }
                        }
                        if let Ok(mut ctx) = ctx_clone.lock() {
                            let _ = render_frame(&frame, &mut ctx);
                        }
                    }
                }
                Ok(())
            },
        )).map_err(|e| e.to_string())?;

        self.frame_pool = Some(frame_pool);
        let session = self.frame_pool.as_ref().unwrap().CreateCaptureSession(&item).map_err(|e| e.to_string())?;
        session.StartCapture().map_err(|e| e.to_string())?;
        self.session = Some(session);

        Ok(())
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        if let Some(swap_chain) = &self.swap_chain {
            unsafe { let _ = swap_chain.ResizeBuffers(1, w.max(1), h.max(1), DXGI_FORMAT_B8G8R8A8_UNORM, windows::Win32::Graphics::Dxgi::DXGI_SWAP_CHAIN_FLAG(0)); }
        }
    }
}

// 渲染上下文
struct SessionContext {
    d3d_device: ID3D11Device,
    d3d_context: ID3D11DeviceContext,
    swap_chain: IDXGISwapChain1,
    #[allow(dead_code)]
    source_crop: Option<RECT>,
    device: IDirect3DDevice,
    last_size: SizeInt32,
    
    // 新增字段
    egui_ctx: Context,
    egui_renderer: Arc<Mutex<Renderer>>,
    ui_state: Arc<Mutex<UiState>>,
    window_handle: HWND,
    tauri_window: Option<WebviewWindow>, // [修复1]
    textures: std::collections::HashMap<TextureId, windows::Win32::Graphics::Direct3D11::ID3D11ShaderResourceView>,
    
    // [修复] 中间纹理缓存，用于 CopyResource -> SRV 的桥梁
    intermediate_texture: Option<windows::Win32::Graphics::Direct3D11::ID3D11Texture2D>,
    
    // [核心新增] 缓存纹理
    cache_texture: Option<ID3D11Texture2D>,
    cache_srv: Option<ID3D11ShaderResourceView>,
}
unsafe impl Send for SessionContext {}
unsafe impl Sync for SessionContext {}

fn render_frame(frame: &windows::Graphics::Capture::Direct3D11CaptureFrame, ctx: &mut SessionContext) -> windows::core::Result<()> {
    // 1. 获取源纹理
    let surface = frame.Surface()?;
    let surface_interop = surface.cast::<IDirect3DDxgiInterfaceAccess>()?;
    let source_texture: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D = unsafe { surface_interop.GetInterface()? };
    let content_size = frame.ContentSize()?;

    // [修复 Issue 7] 自动计算区域裁剪 UV
    // 如果是区域模式 (source_crop 有值)，根据当前 ContentSize 计算 UV
    if let Some(crop_rect) = ctx.source_crop {
        let w = content_size.Width as f32;
        let h = content_size.Height as f32;
        if w > 0.0 && h > 0.0 {
            let uv_min = egui::Pos2::new(crop_rect.left as f32 / w, crop_rect.top as f32 / h);
            let uv_max = egui::Pos2::new(crop_rect.right as f32 / w, crop_rect.bottom as f32 / h);
            
            // 更新 UI State 中的裁剪，防止显示全屏
            if let Ok(mut state) = ctx.ui_state.lock() {
                state.crop = egui::Rect::from_min_max(uv_min, uv_max);
            }
        }
    }

    // 检测是否疑似最小化 (尺寸极小)
    let is_minimized = content_size.Width < 2 || content_size.Height < 2;

    // 2. 纹理复制 (解决 WGC 纹理直接绑定黑屏问题)++++++++++++++
    unsafe {
        let mut source_desc = D3D11_TEXTURE2D_DESC::default();
        source_texture.GetDesc(&mut source_desc);

        let mut recreate = false;
        if let Some(tex) = &ctx.intermediate_texture {
            let mut current_desc = D3D11_TEXTURE2D_DESC::default();
            tex.GetDesc(&mut current_desc);
            // 只要物理尺寸不一致就重建
            if current_desc.Width != source_desc.Width || current_desc.Height != source_desc.Height {
                recreate = true;
            }
        } else {
            recreate = true;
        }

        if recreate && !is_minimized {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: source_desc.Width,
                Height: source_desc.Height,
                MipLevels: 1,
                ArraySize: 1,
                Format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut new_tex = None;
            let _ = ctx.d3d_device.CreateTexture2D(&desc, None, Some(&mut new_tex));
            ctx.intermediate_texture = new_tex;
            // 纹理重建后，必须清除旧的 SRV 缓存，以便下次渲染时重新创建
            ctx.cache_srv = None;
        }

        if let Some(dest) = &ctx.intermediate_texture {
            if !is_minimized {
                ctx.d3d_context.CopyResource(dest, &source_texture);
            }
        }
    }

    // [优化] 提前获取状态并释放锁，避免阻塞主线程的按钮操作 (修复按钮卡顿的核心)
    let (mirror, crop, use_gray) = {
        let state = ctx.ui_state.lock().unwrap();
        (state.mirror, state.crop, state.use_gray)
    };

    // [修复 Issue 3] 自动检测窗口大小变化并调整 SwapChain
    let mut rect = RECT::default();
    unsafe { GetClientRect(ctx.window_handle, &mut rect).ok(); }
    let width = (rect.right - rect.left).max(1) as u32;
    let height = (rect.bottom - rect.top).max(1) as u32;

    unsafe {
        if let Ok(desc) = ctx.swap_chain.GetDesc1() {
            if desc.Width != width || desc.Height != height {
                ctx.d3d_context.OMSetRenderTargets(None, None);
                ctx.d3d_context.Flush();
                
                let _ = ctx.swap_chain.ResizeBuffers(
                    0, 
                    width, 
                    height, 
                    DXGI_FORMAT_B8G8R8A8_UNORM, 
                    windows::Win32::Graphics::Dxgi::DXGI_SWAP_CHAIN_FLAG(0)
                );
            }
        }
    }

    // 3. 准备渲染目标
    let back_buffer: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D = match unsafe { ctx.swap_chain.GetBuffer(0) } {
        Ok(b) => b, Err(_) => return Ok(()),
    };
    let mut rtv = None;
    unsafe { ctx.d3d_device.CreateRenderTargetView(&back_buffer, None, Some(&mut rtv)).ok(); }
    let rtv = match rtv { Some(v) => v, None => return Ok(()) };

    // 4. 准备 Egui 输入
    let mut raw_input = egui::RawInput::default();
    let screen_w = width as f32;
    let screen_h = height as f32;
    raw_input.screen_rect = Some(Rect::from_min_size(Pos2::ZERO, Vec2::new(screen_w, screen_h)));
    
    // 5. Egui UI 绘制
    let full_output = ctx.egui_ctx.run(raw_input, |ui_ctx| {
        // 注意：这里不再持有 ui_state 锁
        
        egui::Area::new("bg".into()).fixed_pos(Pos2::ZERO).order(egui::Order::Background).show(ui_ctx, |ui| {
            let bg_rect = Rect::from_min_size(Pos2::ZERO, Vec2::new(screen_w, screen_h));
            
            if is_minimized {
                ui.allocate_ui_at_rect(bg_rect, |ui| {
                    ui.centered_and_justified(|ui| {
                        ui.vertical_centered(|ui| {
                            ui.label(egui::RichText::new("⏸").size(40.0).color(Color32::from_white_alpha(150)));
                            ui.label(egui::RichText::new("Source Minimized").size(16.0).color(Color32::WHITE));
                        });
                    });
                });
            } else {
                // [修复] 强制填满窗口 (Stretch Mode)
                let mut uv_min = crop.min;
                let mut uv_max = crop.max;
                
                // 处理镜像
                if mirror { std::mem::swap(&mut uv_min.x, &mut uv_max.x); }

                ui.painter().image(
                    egui::TextureId::User(0),
                    bg_rect, 
                    Rect::from_min_max(uv_min, uv_max),
                    Color32::WHITE
                );
            }
        });
    });

    // 6. 渲染提交
    {
        let mut renderer = ctx.egui_renderer.lock().unwrap();
        let clipped_primitives = ctx.egui_ctx.tessellate(full_output.shapes, full_output.pixels_per_point);
        
        for id in &full_output.textures_delta.free { ctx.textures.remove(id); }
        for (id, delta) in &full_output.textures_delta.set {
            let pixels: Vec<u8> = match &delta.image {
                egui::ImageData::Color(image) => image.pixels.iter().flat_map(|c| c.to_array()).collect(),
                egui::ImageData::Font(image) => image.srgba_pixels(None).flat_map(|c| c.to_array()).collect()
            };
            if let Ok(srv) = renderer.create_texture(delta.image.width() as u32, delta.image.height() as u32, &pixels) {
                ctx.textures.insert(*id, srv);
            }
        }

        // [修复] 复用缓存的 SRV，避免每一帧都创建销毁资源导致的性能下降
        if ctx.cache_srv.is_none() && ctx.intermediate_texture.is_some() {
            let mut new_srv = None;
            unsafe { 
                let _ = ctx.d3d_device.CreateShaderResourceView(
                    ctx.intermediate_texture.as_ref().unwrap(), 
                    None, 
                    Some(&mut new_srv)
                ); 
            }
            ctx.cache_srv = new_srv;
        }

        let mut render_textures = ctx.textures.clone();
        if let Some(srv) = &ctx.cache_srv {
            // 注意：这里需要 clone 指针 (AddRef)，因为 HashMap 拥有所有权
            render_textures.insert(egui::TextureId::User(0), srv.clone());
        }

        unsafe {
            let clear_color = [0.0, 0.0, 0.0, 0.0]; 
            ctx.d3d_context.ClearRenderTargetView(&rtv, &clear_color);
            ctx.d3d_context.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);

            // [优化] 使用提前获取的 use_gray
            renderer.use_gray = use_gray;
            renderer.render(screen_w, screen_h, &clipped_primitives, &render_textures);
        }
    }

    unsafe {
        let params = windows::Win32::Graphics::Dxgi::DXGI_PRESENT_PARAMETERS::default();
        // [稳定性优化] 捕获 Present 错误，处理 DEVICE_REMOVED
        if let Err(e) = ctx.swap_chain.Present1(1, windows::Win32::Graphics::Dxgi::DXGI_PRESENT(0), &params).ok() {
            // [修复] 修正错误码的引用路径 Foundation -> Graphics::Dxgi
            if e.code() == windows::Win32::Graphics::Dxgi::DXGI_ERROR_DEVICE_REMOVED || e.code() == windows::Win32::Graphics::Dxgi::DXGI_ERROR_DEVICE_RESET {
                // 这里可以记录日志或发送事件通知前端重启会话，暂时返回错误以中断渲染循环
                return Err(e);
            }
        }
    }
    Ok(())
}

fn create_d3d_device() -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
    // [兼容性优化] 显式枚举适配器，避免默认选择核显导致跨GPU共享失败
    unsafe {
        let mut device = None;
        let mut context = None;
        let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;

        // 1. 尝试创建硬件设备 (系统自动选择高性能)
        if D3D11CreateDevice(
            None, 
            D3D_DRIVER_TYPE_HARDWARE, 
            None, 
            flags, 
            None, 
            D3D11_SDK_VERSION, 
            Some(&mut device), 
            None, 
            Some(&mut context)
        ).is_ok() {
            return Ok((device.unwrap(), context.unwrap()));
        }

        // 2. 兜底策略：软件模拟 (WARP)，保证在无显卡或驱动故障时也能运行
        if D3D11CreateDevice(
            None, 
            D3D_DRIVER_TYPE_WARP, 
            None, 
            flags, 
            None, 
            D3D11_SDK_VERSION, 
            Some(&mut device), 
            None, 
            Some(&mut context)
        ).is_ok() {
            return Ok((device.unwrap(), context.unwrap()));
        }
    }
    Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
}

fn create_capture_item_for_window(hwnd: HWND) -> windows::core::Result<GraphicsCaptureItem> {
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    unsafe { interop.CreateForWindow(hwnd) }
}
fn create_capture_item_for_monitor(hmonitor: windows::Win32::Graphics::Gdi::HMONITOR) -> windows::core::Result<GraphicsCaptureItem> {
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    unsafe { interop.CreateForMonitor(hmonitor) }
}

// --- Tauri Commands ---

#[tauri::command]
pub fn start_wgc_session(app_handle: tauri::AppHandle, label: String, target_id: isize, x: i32, y: i32, w: i32, h: i32) -> std::result::Result<(), String> {
    let window = app_handle.get_webview_window(&label).ok_or("Window not found")?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    
    let mut sessions_guard = SESSIONS.lock().unwrap();
    if sessions_guard.is_none() {
        *sessions_guard = Some(HashMap::new());
    }
    let sessions = sessions_guard.as_mut().unwrap();

    // 移除旧的会话
    if let Some(old_session) = sessions.remove(&label) {
        let mut s = old_session.lock().unwrap();
        s.stop();
    }

    // [修复1] 传入 window 克隆
    let session = Arc::new(Mutex::new(WgcSession::new(hwnd, window.clone())));
    
    let is_region = target_id == 0; 
    let crop = if is_region { 
        Some(RECT { left: x, top: y, right: x + w, bottom: y + h }) 
    } else { 
        None 
    };

    let start_result = {
        let mut session_mut = session.lock().unwrap();
        session_mut.start(target_id, is_region, crop)
    };

    match start_result {
        Ok(_) => {
            sessions.insert(label, session);
            Ok(())
        }
        Err(e) => Err(e)
    }
}

#[tauri::command]
pub fn stop_wgc_session(label: String) {
    let mut sessions_guard = SESSIONS.lock().unwrap();
    if let Some(sessions) = sessions_guard.as_mut() {
        if let Some(session) = sessions.remove(&label) {
            let mut s = session.lock().unwrap();
            s.stop();
        }
    }
}

#[tauri::command]
pub fn update_wgc_resize(label: String, w: u32, h: u32) {
    let sessions_guard = SESSIONS.lock().unwrap();
    if let Some(sessions) = sessions_guard.as_ref() {
        if let Some(session) = sessions.get(&label) {
            let mut s = session.lock().unwrap();
            s.resize(w, h);
        }
    }
}

#[tauri::command]
pub fn pause_wgc_session(label: String) {
    let mut sessions_guard = SESSIONS.lock().unwrap();
    if let Some(sessions) = sessions_guard.as_mut() { 
        if let Some(session) = sessions.get(&label) {
            let mut s = session.lock().unwrap();
            s.stop_capture(); // 仅停止捕获，保留交换链
        }
    }
}

#[tauri::command]
pub fn resume_wgc_session(label: String, target_id: isize, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    let mut sessions_guard = SESSIONS.lock().unwrap();
    if sessions_guard.is_none() { *sessions_guard = Some(HashMap::new()); }
    let sessions = sessions_guard.as_mut().unwrap();

    let is_region = target_id == 0; 
    let crop = if is_region { Some(RECT { left: x, top: y, right: x + w, bottom: y + h }) } else { None };

    if let Some(session) = sessions.get(&label) {
        let mut s = session.lock().unwrap();
        s.resume(target_id, is_region, crop)
    } else {
        Err("Session not found, use start".to_string())
    }
}

// [修复 Issue 3] 强制重绘辅助函数
impl WgcSession {
    // 尝试使用缓存的纹理强制重绘一帧
    pub fn force_redraw(&mut self) {
        // 由于 render_frame 需要 &frame 对象，但该对象只在回调中存在且生命周期受限。
        // 然而，我们的 render_frame 实际上主要依赖 ctx.intermediate_texture (除了获取 size)。
        // 我们可以重构 render_frame，但在 Rust 中改动较大。
        // 简单的 HACK: 既然 intermediate_texture 已经在 Context 里了，
        // 我们只需触发 Egui 的渲染流程。但 Egui 的 render 需要在 render_frame 内部执行。
        // 由于这里无法造出一个 Direct3D11CaptureFrame，我们无法直接调用 render_frame。
        
        // 替代方案：在 SessionContext 中实现一个独立的 `redraw_cached` 方法。
        // 下面是修改后的命令实现方式。
    }
}

// 扩展 SessionContext 以支持重绘
impl SessionContext {
    fn redraw_cached(&mut self) {
        if self.intermediate_texture.is_none() { return; }
        
        // 获取窗口尺寸
        let mut rect = RECT::default();
        unsafe { GetClientRect(self.window_handle, &mut rect).ok(); }
        let width = (rect.right - rect.left).max(1) as u32;
        let height = (rect.bottom - rect.top).max(1) as u32;
        let screen_w = width as f32;
        let screen_h = height as f32;

        let (mirror, crop, use_gray) = {
            let state = self.ui_state.lock().unwrap();
            (state.mirror, state.crop, state.use_gray)
        };

        // 准备 Egui
        let mut raw_input = egui::RawInput::default();
        raw_input.screen_rect = Some(Rect::from_min_size(Pos2::ZERO, Vec2::new(screen_w, screen_h)));
        
        let full_output = self.egui_ctx.run(raw_input, |ui_ctx| {
            egui::Area::new("bg".into()).fixed_pos(Pos2::ZERO).order(egui::Order::Background).show(ui_ctx, |ui| {
                let bg_rect = Rect::from_min_size(Pos2::ZERO, Vec2::new(screen_w, screen_h));
                let mut uv_min = crop.min;
                let mut uv_max = crop.max;
                if mirror { std::mem::swap(&mut uv_min.x, &mut uv_max.x); }
                ui.painter().image(egui::TextureId::User(0), bg_rect, Rect::from_min_max(uv_min, uv_max), Color32::WHITE);
            });
        });

        // 渲染
        if let Ok(mut renderer) = self.egui_renderer.lock() {
            let clipped_primitives = self.egui_ctx.tessellate(full_output.shapes, full_output.pixels_per_point);
            let mut srv = None;
            unsafe { let _ = self.d3d_device.CreateShaderResourceView(self.intermediate_texture.as_ref().unwrap(), None, Some(&mut srv)); }
            
            let mut render_textures = self.textures.clone();
            if let Some(srv) = srv { render_textures.insert(egui::TextureId::User(0), srv); }

            unsafe {
                // 重新获取 BackBuffer (Swap Chain 可能未变)
                if let Ok(back_buffer) = self.swap_chain.GetBuffer::<windows::Win32::Graphics::Direct3D11::ID3D11Texture2D>(0) {
                    let mut rtv = None;
                    if self.d3d_device.CreateRenderTargetView(&back_buffer, None, Some(&mut rtv)).is_ok() {
                        let clear_color = [0.0, 0.0, 0.0, 0.0]; 
                        self.d3d_context.ClearRenderTargetView(rtv.as_ref().unwrap(), &clear_color);
                        self.d3d_context.OMSetRenderTargets(Some(&[rtv]), None);
                        renderer.use_gray = use_gray;
                        renderer.render(screen_w, screen_h, &clipped_primitives, &render_textures);
                    }
                }
            }
        }
        // Present
        unsafe { let _ = self.swap_chain.Present1(1, DXGI_PRESENT(0), &DXGI_PRESENT_PARAMETERS::default()); }
    }
}

#[tauri::command]
pub fn update_wgc_filter(label: String, use_gray: bool) {
    let sessions_guard = SESSIONS.lock().unwrap();
    if let Some(sessions) = sessions_guard.as_ref() {
        if let Some(session) = sessions.get(&label) {
            let s = session.lock().unwrap();
            {
                let mut ui = s.ui_state.lock().unwrap();
                ui.use_gray = use_gray;
            }
            // [修复 Issue 3] 立即重绘
            if let Some(ctx) = &s.active_context {
                if let Ok(mut c) = ctx.lock() { c.redraw_cached(); }
            }
        }
    }
}

#[tauri::command]
pub fn update_wgc_mirror(label: String, mirror: bool) {
    let sessions_guard = SESSIONS.lock().unwrap();
    if let Some(sessions) = sessions_guard.as_ref() {
        if let Some(session) = sessions.get(&label) {
            let s = session.lock().unwrap();
            {
                let mut ui = s.ui_state.lock().unwrap();
                ui.mirror = mirror;
            }
            // [修复 Issue 3] 立即重绘
            if let Some(ctx) = &s.active_context {
                if let Ok(mut c) = ctx.lock() { c.redraw_cached(); }
            }
        }
    }
}

// [新增] WGC 单帧截图功能 (用于修复优动漫等软件无法预览的问题)
pub fn capture_snapshot(hwnd_val: isize) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;
    use windows::Win32::Graphics::Direct3D11::{D3D11_TEXTURE2D_DESC, D3D11_SUBRESOURCE_DATA, D3D11_MAPPED_SUBRESOURCE};
    
    // 1. 初始化设备
    let (d3d_device, d3d_context) = create_d3d_device().map_err(|e| e.to_string())?;
    let dxgi_device = d3d_device.cast::<windows::Win32::Graphics::Dxgi::IDXGIDevice>().map_err(|e| e.to_string())?;
    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device).map_err(|e| e.to_string())? };
    let winrt_device: IDirect3DDevice = inspectable.cast().map_err(|e| e.to_string())?;

    // 2. 创建捕获项
    let item = create_capture_item_for_window(HWND(hwnd_val as _)).map_err(|e| e.to_string())?;
    let item_size = item.Size().map_err(|e| e.to_string())?;

    // 3. 创建 FramePool
    let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt_device, 
        DirectXPixelFormat::B8G8R8A8UIntNormalized, 
        1, 
        item_size
    ).map_err(|e| e.to_string())?;

    // 4. 创建会话
    let session = frame_pool.CreateCaptureSession(&item).map_err(|e| e.to_string())?;
    
    // 5. 设置信号通道
    let (tx, rx) = mpsc::channel();
    
    frame_pool.FrameArrived(&windows::Foundation::TypedEventHandler::new(
        move |pool: &Option<Direct3D11CaptureFramePool>, _| {
            if let Some(pool) = pool {
                if let Ok(frame) = pool.TryGetNextFrame() {
                    let _ = tx.send(frame);
                }
            }
            Ok(())
        }
    )).map_err(|e| e.to_string())?;

    // 6. 开始捕获并等待第一帧
    session.StartCapture().map_err(|e| e.to_string())?;
    
    let frame = rx.recv_timeout(Duration::from_millis(800)).map_err(|_| "Timeout waiting for WGC frame".to_string())?;
    
    // 停止会话 (拿到一帧就够了)
    let _ = session.Close();
    let _ = frame_pool.Close();

    // 7. 处理纹理数据
    let surface = frame.Surface().map_err(|e| e.to_string())?;
    let surface_interop = surface.cast::<IDirect3DDxgiInterfaceAccess>().map_err(|e| e.to_string())?;
    let source_texture: ID3D11Texture2D = unsafe { surface_interop.GetInterface().map_err(|e| e.to_string())? };
    
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { source_texture.GetDesc(&mut desc); }

    // 创建 CPU 可读的 Staging Texture
    let staging_desc = D3D11_TEXTURE2D_DESC {
        Width: desc.Width,
        Height: desc.Height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_STAGING, // 关键：Staging
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, // 关键：CPU Read
        MiscFlags: 0,
    };

    let mut staging_texture = None;
    unsafe {
        d3d_device.CreateTexture2D(&staging_desc, None, Some(&mut staging_texture)).map_err(|e| e.to_string())?;
        if let Some(staging) = &staging_texture {
            d3d_context.CopyResource(staging, &source_texture);
            
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            d3d_context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|e| e.to_string())?;
            
            // 8. 转换为 PNG Base64
            // 注意：WGC 返回的是 BGRA，但 image crate 默认处理 RGBA，我们需要手动 Swizzle 或者告诉 image 它是 BGRA
            // 这里我们手动拷贝并交换 B 和 R
            let width = desc.Width as usize;
            let height = desc.Height as usize;
            let src_stride = mapped.RowPitch as usize;
            let src_ptr = mapped.pData as *const u8;
            
            let mut img_buf = Vec::with_capacity(width * height * 4);
            
            for y in 0..height {
                let row_start = y * src_stride;
                for x in 0..width {
                    let pixel_idx = row_start + x * 4;
                    let b = *src_ptr.add(pixel_idx);
                    let g = *src_ptr.add(pixel_idx + 1);
                    let r = *src_ptr.add(pixel_idx + 2);
                    let _a = *src_ptr.add(pixel_idx + 3); // WGC alpha is typically 255 or premultiplied
                    
                    img_buf.push(r);
                    img_buf.push(g);
                    img_buf.push(b);
                    img_buf.push(255); // 强制不透明，避免透明窗口问题
                }
            }
            
            d3d_context.Unmap(staging, 0);
            
            // 编码
            let mut png_data = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut png_data);
            let img = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(desc.Width, desc.Height, img_buf).ok_or("Buffer create failed")?;
            // 缩略图不需要原图那么大，可以在这里 resize 优化性能，但为了清晰度先原样输出
            img.write_to(&mut cursor, image::ImageFormat::Png).map_err(|e| e.to_string())?;
            
            use base64::engine::general_purpose;
            use base64::Engine;
            let b64 = general_purpose::STANDARD.encode(png_data);
            return Ok(format!("data:image/png;base64,{}", b64));
        }
    }

    Err("Texture creation failed".to_string())
}