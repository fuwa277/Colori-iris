import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PhysicalSize } from '@tauri-apps/api/dpi';
import { listen, emit } from '@tauri-apps/api/event';
import { Pin, X, Pipette, Layers, Crop, FlipHorizontal, Scan } from 'lucide-react';
import { LUMA_ALGORITHMS, hexToRgb } from './colorLogic';
import { GlobalSvgFilters } from './MyComponents';
import { RotateCcw } from 'lucide-react'; // 记得在顶部 import 列表添加 RotateCcw

const appWindow = getCurrentWindow();

import { RegionSelector } from './MyComponents'; // 确保引入 RegionSelector

// --- 独立窗口：监控器 (WGC Version / Enhanced) ---
export const MonitorWindow = () => {
    const [isTopmost, setIsTopmost] = useState(true);
    const [isGray, setIsGray] = useState(false); 
    const [sourceConfig, setSourceConfig] = useState(null); 
    const [isSourceMinimized, setIsSourceMinimized] = useState(false);
    const [wgcError, setWgcError] = useState(null);
    const [aspectRatio, setAspectRatio] = useState(0); 
    // 删除 showControls, 使用 CSS group-hover
    const [isMirror, setIsMirror] = useState(false);
    const [isCropping, setIsCropping] = useState(false); 

    // AR 防抖定时器
    const resizeDebounceRef = React.useRef(null);

    // 日志探针 (移除写文件，改为控制台或空函数)
    const log = (msg) => console.log(`[MonitorWindow] ${msg}`);

    // 初始化
    useEffect(() => {
        // 1. 强制重置鼠标穿透状态
        invoke('set_ignore_cursor_events', { label: appWindow.label, ignore: false }).catch(console.error);

        const params = new URLSearchParams(window.location.search);
        const id = params.get('id');
        const x = parseInt(params.get('x')||0), y = parseInt(params.get('y')||0), 
              w = parseInt(params.get('w')||0), h = parseInt(params.get('h')||0);
        const label = params.get('label') || '';
        const type = params.get('type') || 'region'; 
        // [Issue 3] 接收 tid
        const tid = parseInt(params.get('tid') || '0');

        const config = { id, x, y, w, h, label, type, tid };
        setSourceConfig(config);
        
        log(`Init ID=${id}, Label=${label}, AR=${w}/${h}`);

        if (w > 0 && h > 0) setAspectRatio(w / h);

        const unlistenClose = appWindow.onCloseRequested(async (event) => {
            event.preventDefault(); 
            handleHide();
        });

        const unlistenDestroy = listen('destroy-pip', async (e) => {
            // 修复：确保 ID 匹配，处理潜在的字符串不一致问题
            if (e.payload.label === appWindow.label) {
                log("Destroying session...");
                // 先停止 WGC 再销毁窗口
                await invoke('stop_wgc_session', { label: appWindow.label }).catch(()=>{});
                await appWindow.destroy(); 
            }
        });

        const unlistenWake = listen('pip-wake', async (e) => {
            if(e.payload && e.payload.target && e.payload.target !== appWindow.label) return;
            log("Wake signal received");
            setWgcError(null);
            
            invoke('set_ignore_cursor_events', { label: appWindow.label, ignore: false });

            await appWindow.setSkipTaskbar(false);
            if (await appWindow.isMinimized()) await appWindow.unminimize();
            await appWindow.show();
            await appWindow.setFocus();
            
            setTimeout(() => {
                startOrResumeWgc(config);
            }, 200);
        });

    const handleCropConfirm = async (rect) => {
        setIsCropping(false);
        if (!sourceConfig) return;

        const winSize = await appWindow.innerSize();
        // 计算缩放比例：源尺寸 / 当前窗口尺寸
        const scaleX = sourceConfig.w / winSize.width;
        const scaleY = sourceConfig.h / winSize.height;

        // 计算相对于原始源的新坐标
        const newX = Math.round(sourceConfig.x + rect.x * scaleX);
        const newY = Math.round(sourceConfig.y + rect.y * scaleY);
        const newW = Math.round(rect.w * scaleX);
        const newH = Math.round(rect.h * scaleY);

        // 更新配置
        const newConfig = { ...sourceConfig, x: newX, y: newY, w: newW, h: newH };
        setSourceConfig(newConfig);
        
        // 1. 修复长宽比：立即更新 State 防止 WGC 回调覆盖
        if (newW > 0 && newH > 0) {
            const newRatio = newW / newH;
            setAspectRatio(newRatio);
            
            // 2. 调整窗口大小以适应新比例 (保持当前宽度，计算新高度)
            const targetH = Math.round(winSize.width / newRatio);
            await appWindow.setSize(new PhysicalSize(winSize.width, targetH));
            
            // 3. 通知 WGC 更新视口
            invoke('update_wgc_resize', { label: appWindow.label, w: winSize.width, h: targetH }).catch(()=>{});
        }

        // 4. 通知主窗口更新源列表 (修复关联断联问题)
        // 发送包含完整新配置的事件
        await emit('update-source-config', { 
            id: sourceConfig.id, // 使用原始ID
            newConfig: newConfig 
        });

        // 5. 重启 WGC 会话
        startOrResumeWgc(newConfig);
    };

        const unlistenGraySync = listen('sync-gray', (e) => {
            if (e.payload.target === appWindow.label) {
                log(`Sync Gray: ${e.payload.value}`);
                setIsGray(e.payload.value);
            }
        });

        const minCheckTimer = setInterval(async () => {
            if (config.type === 'native-app') {
                try {
                    const minimized = await invoke('is_window_minimized', { name: config.label });
                    // 探针：仅状态改变时记录，防止刷屏
                    setIsSourceMinimized(prev => {
                        if (prev !== minimized) log(`State Change: Minimized = ${minimized}`);
                        return minimized;
                    });
                } catch(e) { log(`Check Minimized Error: ${e}`); }
            }
        }, 1000);

        appWindow.isVisible().then(visible => {
            if(visible) startOrResumeWgc(config);
        });

        // 立即执行一次样式修复
        setTimeout(() => invoke('ensure_window_clickable', { label: appWindow.label }), 500);

        // [调试] 全局点击检测
        const debugHandler = (e) => console.log(`[MonitorWindow] Global Click Detected. Target: <${e.target.tagName.toLowerCase()} class="${e.target.className}">`);
        window.addEventListener('mousedown', debugHandler);

        return () => {
            // [稳定性优化] 确保清理函数正确执行，防止内存泄漏
            unlistenClose.then(f => f && f());
            unlistenDestroy.then(f => f && f());
            unlistenWake.then(f => f && f());
            unlistenGraySync.then(f => f && f());
            clearInterval(minCheckTimer);
            window.removeEventListener('mousedown', debugHandler);
        };
    }, []);

    // Resize 监听 (防抖修正模式)
    // [修复1] 自动比例调整逻辑
    useEffect(() => {
        // 监听来自后端的源尺寸变化事件
        const unlistenRatio = listen('wgc-ratio-changed', async (e) => {
            const [wStr, hStr] = e.payload.split(':');
            const w = parseInt(wStr), h = parseInt(hStr);
            if (w > 0 && h > 0) {
                const newRatio = w / h;
                // 如果比例发生显著变化
                if (Math.abs(newRatio - aspectRatio) > 0.01) {
                    setAspectRatio(newRatio);
                    
                    // 获取当前窗口宽度，保持宽度不变，调整高度
                    const currentSize = await appWindow.innerSize();
                    const newHeight = Math.round(currentSize.width / newRatio);
                    
                    await appWindow.setSize(new PhysicalSize(currentSize.width, newHeight));
                    // 更新 WGC 视口
                    invoke('update_wgc_resize', { label: appWindow.label, w: currentSize.width, h: newHeight });
                }
            }
        });

        // [优化] 使用 resizeDebounceRef (顶层定义) 进行简单的节流/防抖，修复 Hook 调用错误
        // const resizeTimeoutRef = React.useRef(null); // 删除此行: 不能在 useEffect 中调用 Hooks

        const unlistenResize = appWindow.onResized(async () => {
             const size = await appWindow.innerSize();
             
             if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);

             resizeDebounceRef.current = setTimeout(() => {
                 // [添加保护] 防止窗口销毁后继续执行
                 if (!resizeDebounceRef.current) return;
                 
                 invoke('update_wgc_resize', { label: appWindow.label, w: size.width, h: size.height });

                 if (!aspectRatio) return;

                 if (aspectRatio > 0) {
                     const currentRatio = size.width / size.height;
                     if (Math.abs(currentRatio - aspectRatio) > 0.05) {
                         const newHeight = Math.round(size.width / aspectRatio);
                         appWindow.setSize(new PhysicalSize(size.width, newHeight)).catch(()=>{});
                     }
                 }
             }, 16);
        });
        
        return () => { 
            // [修复] 组件卸载时，必须清除 pending 的计时器
            if (resizeDebounceRef.current) {
                clearTimeout(resizeDebounceRef.current);
                resizeDebounceRef.current = null;
            }
            unlistenResize.then(f => f && f()); 
            unlistenRatio.then(f => f && f());
        };
    }, [aspectRatio]);

    useEffect(() => {
        // 1. 通知主窗口更新 UI 状态
        emit('monitor-state-changed', { label: appWindow.label, isGray: isGray });
        
        // 2. 调用 Rust 命令，直接更新 WGC 渲染器的滤镜状态
        invoke('update_wgc_filter', { label: appWindow.label, useGray: isGray }).catch(err => {
            log(`Filter Update Error: ${err}`);
        });
    }, [isGray]);

    const startOrResumeWgc = async (cfg) => {
        if (!cfg) return;
        try {
            let targetHandle = 0;
            if (cfg.type === 'native-app') {
                // [Issue 3] 如果有传入 tid (HWND)，直接使用，否则回退到按名字查找
                if (cfg.tid && cfg.tid !== 0) {
                    targetHandle = cfg.tid;
                } else {
                    const hwnd = await invoke('get_window_hwnd', { name: cfg.label });
                    if (hwnd) targetHandle = hwnd;
                    else {
                        setWgcError("窗口未找到 (Window not found)");
                        return;
                    }
                }
            }
            try {
                await invoke('resume_wgc_session', { 
                    label: appWindow.label, targetId: targetHandle,
                    x: cfg.x, y: cfg.y, w: cfg.w, h: cfg.h
                });
            } catch (resumeErr) {
                log("Resume failed, trying Start");
                await invoke('start_wgc_session', { 
                    label: appWindow.label, targetId: targetHandle,
                    x: cfg.x, y: cfg.y, w: cfg.w, h: cfg.h
                });
            }
            const size = await appWindow.innerSize();
            invoke('update_wgc_resize', { label: appWindow.label, w: size.width, h: size.height });
        } catch (e) {
            log(`WGC Error: ${e}`);
            setWgcError(`WGC Error: ${e}`);
        }
    };

    const handleHide = async () => {
        log("Hiding (Pausing)");
        await invoke('pause_wgc_session', { label: appWindow.label });
        await appWindow.hide();
        await appWindow.setSkipTaskbar(true);
        emit('monitor-visibility-changed', { label: appWindow.label, visible: false });
    };

    return (
        <div 
            className="w-full h-full relative group border border-white/10 rounded-lg transition-all duration-300 flex flex-col"
            style={{ backgroundColor: 'rgba(0,0,0,0.01)' }} // 保持微量透明度以接收点击
        >
            {/* [终极修复] 专用拖拽层：fixed + z-10。使用 fixed 确保绝对填满窗口，防止 absolute 因父级布局塌陷导致失效 */}
            <div 
                className="fixed inset-0 z-10 cursor-move"
                style={{ backgroundColor: 'rgba(255,255,255,0.01)' }}
                onMouseDown={(e) => {
                    if (e.button === 0) {
                        e.preventDefault(); 
                        appWindow.startDragging().catch(console.error);
                    }
                }}
            />

            <GlobalSvgFilters icc="rec601"/>

            {/* [修复2] 裁剪模式覆盖层 */}
            {isCropping && (
                <div className="absolute inset-0 z-[70] bg-black/50" onMouseDown={e => e.stopPropagation()}>
                    <RegionSelector 
                        onConfirm={handleCropConfirm} 
                        onCancel={() => setIsCropping(false)} 
                    />
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-teal-600 text-white text-[10px] px-2 py-1 rounded shadow-lg pointer-events-none">
                        正在裁剪: 框选画面区域
                    </div>
                </div>
            )}

            {/* Resize 把手 - [回退] 兼容旧版 Tauri API (startResizing) */}
            <div className="resize-handle absolute top-0 left-0 w-full h-4 cursor-ns-resize z-50 bg-transparent"
                 onMouseDown={(e)=>{ e.stopPropagation(); appWindow.startResizing(1); }} />
            <div className="resize-handle absolute bottom-0 left-0 w-full h-4 cursor-ns-resize z-50 bg-transparent"
                 onMouseDown={(e)=>{ e.stopPropagation(); appWindow.startResizing(2); }} />
            <div className="resize-handle absolute top-0 left-0 w-4 h-full cursor-ew-resize z-50 bg-transparent"
                 onMouseDown={(e)=>{ e.stopPropagation(); appWindow.startResizing(3); }} />
            <div className="resize-handle absolute top-0 right-0 w-4 h-full cursor-ew-resize z-50 bg-transparent"
                 onMouseDown={(e)=>{ e.stopPropagation(); appWindow.startResizing(4); }} />
            <div className="resize-handle absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize z-[51] bg-white/10 hover:bg-teal-500 rounded-tl clip-triangle transition-colors"
                 onMouseDown={(e) => { e.stopPropagation(); appWindow.startResizing(); }} />

            {/* 状态提示层 */}
            {(isSourceMinimized || wgcError) && (
                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-black/90 text-white p-4 text-center backdrop-blur-md pointer-events-none">
                    {isSourceMinimized ? (
                        <div className="flex flex-col gap-2">
                            <span className="text-sm font-bold text-red-400">⚠️ 源窗口已最小化</span>
                            <span className="text-xs text-gray-400 leading-relaxed">
                                系统限制：无法在最小化状态下同步画面。<br/>
                                请还原窗口以继续监视。
                            </span>
                        </div>
                    ) : (
                        <span className="text-xs text-red-400 font-mono bg-black/50 p-2 rounded">{wgcError}</span>
                    )}
                </div>
            )}

            {/* 悬浮控制栏 - 移除了 showControls 状态，完全依赖 group-hover */}
            <div 
                className="absolute top-2 right-2 z-[60] flex flex-col items-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                onMouseDown={(e) => e.stopPropagation()} 
            >
                {/* 优化: 移除 backdrop-blur 提升渲染性能 */}
                <div className="flex gap-1 bg-black/80 p-1 rounded-lg border border-white/10 shadow-xl">
                     <button 
                        onClick={() => { 
                            const newVal = !isMirror;
                            setIsMirror(newVal);
                            invoke('update_wgc_mirror', { label: appWindow.label, mirror: newVal });
                        }} 
                        className={`p-1.5 rounded transition ${isMirror ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-white/20'}`}
                        title="镜像 (Mirror)"
                     >
                        <FlipHorizontal size={14}/>
                     </button>

                     <button 
                        onClick={() => { setIsGray(!isGray); }} 
                        className={`p-1.5 rounded transition ${isGray ? 'bg-purple-600 text-white' : 'text-gray-300 hover:bg-white/20'}`}
                        title="灰度 (Gray)"
                     >
                        <Layers size={14}/>
                     </button>
                     
                     <div className="w-[1px] h-4 bg-white/20 my-auto mx-0.5"></div>

                     <button 
                        onClick={() => {
                             const newState = !isTopmost; setIsTopmost(newState);
                             invoke('set_window_topmost', { label: appWindow.label, topmost: newState });
                        }} 
                        className={`p-1.5 rounded transition ${isTopmost ? 'bg-green-600 text-white' : 'text-gray-300 hover:bg-white/20'}`}
                        title="置顶 (Pin)"
                     >
                        <Pin size={14} className={isTopmost ? "fill-current" : ""}/>
                     </button>

                     <button 
                        onClick={handleHide} 
                        className="p-1.5 rounded text-gray-300 hover:bg-red-600 hover:text-white transition"
                        title="隐藏 (Hide)"
                     >
                        <X size={14}/>
                     </button>
                </div>
                
                <div className="px-2 py-0.5 bg-black/40 text-white/50 text-[9px] rounded pointer-events-none truncate max-w-[120px]">
                    {sourceConfig?.label}
                </div>
            </div>
        </div>
    );
};

// --- 独立窗口：全屏选区器 ---
export const SelectorWindow = () => {
    const [startPos, setStartPos] = useState(null); 
    const [endPos, setEndPos] = useState(null);     
    const [mode, setMode] = useState('idle'); 
    const [dragOffset, setDragOffset] = useState({x:0, y:0});

    useEffect(() => {
        invoke('set_window_topmost', { label: appWindow.label, topmost: true });
        setTimeout(async () => {
            await appWindow.show();
            await appWindow.setFocus();
        }, 100);

        const handleKey = (e) => { 
            if (e.key === 'Escape') cancelSelection();
            if (e.key === 'Enter' && startPos && endPos) handleConfirm();
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [startPos, endPos]);

    const getRect = () => {
        if (!startPos || !endPos) return null;
        return {
            x: Math.min(startPos.x, endPos.x),
            y: Math.min(startPos.y, endPos.y),
            w: Math.abs(endPos.x - startPos.x),
            h: Math.abs(endPos.y - startPos.y)
        };
    };

    const handleConfirm = async () => {
        const rect = getRect();
        if (!rect || rect.w < 5 || rect.h < 5) return;
        await appWindow.hide();
        setTimeout(async () => {
            await emit('region-selected', { 
                ...rect, 
                purpose: window.location.search.includes('mode=monitor') ? 'monitor' : 'screenshot' 
            });
            appWindow.close();
        }, 150); 
    };

    const cancelSelection = () => {
        if(startPos) { setStartPos(null); setEndPos(null); setMode('idle'); }
        else appWindow.close();
    };

    const handleMouseDown = (e) => {
        // 关键：阻止默认行为，防止点击穿透到桌面
        e.preventDefault(); 
        e.stopPropagation();
        
        if (e.button === 2) return; // 右键仅在松开时处理

        if (e.button === 0) { 
            const rect = getRect();
            const mx = e.clientX, my = e.clientY;
            if (rect && mx >= rect.x && mx <= rect.x + rect.w && my >= rect.y && my <= rect.y + rect.h) {
                setMode('moving');
                setDragOffset({ x: mx - rect.x, y: my - rect.y });
            } else {
                setStartPos({ x: mx, y: my });
                setEndPos({ x: mx, y: my });
                setMode('selecting');
            }
        }
    };

    const handleMouseMove = (e) => {
        if (mode === 'selecting') {
            setEndPos({ x: e.clientX, y: e.clientY });
        } else if (mode === 'moving' && startPos && endPos) {
            const rect = getRect();
            const w = rect.w; const h = rect.h;
            const newX = e.clientX - dragOffset.x;
            const newY = e.clientY - dragOffset.y;
            setStartPos({ x: newX, y: newY });
            setEndPos({ x: newX + w, y: newY + h });
        }
    };

    const handleMouseUp = (e) => {
        e.preventDefault(); e.stopPropagation();
        setMode('idle');
        if (e.button === 2) {
            // 右键松开时关闭，此时事件已被当前窗口捕获，不会传到底层
            cancelSelection();
        }
    };

    const rect = getRect();

    return (
        <div className="w-screen h-screen cursor-crosshair bg-transparent focus:outline-none"
            onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}
            onDoubleClick={handleConfirm} 
            onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }} // 彻底禁用右键菜单
        >
            <div className="absolute inset-0 bg-black/30" style={rect ? { clipPath: `polygon(0% 0%, 0% 100%, 100% 100%, 100% 0%, 0% 0%, ${rect.x}px ${rect.y}px, ${rect.x + rect.w}px ${rect.y}px, ${rect.x + rect.w}px ${rect.y + rect.h}px, ${rect.x}px ${rect.y + rect.h}px, ${rect.x}px ${rect.y}px)` } : {}} />
            {rect && (
                <div className="absolute border-2 border-slate-500 shadow-[0_0_0_1px_rgba(255,255,255,0.2)]"
                    style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
                    <div className="absolute -top-7 left-0 text-white text-xs bg-teal-700 px-1.5 py-0.5 rounded shadow font-mono">
                        {Math.round(rect.w)} x {Math.round(rect.h)}
                    </div>
                    {/* 指示器 */}
                    <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border border-slate-500 rounded-full" />
                    <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border border-slate-500 rounded-full" />
                    <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border border-slate-500 rounded-full" />
                    <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border border-slate-500 rounded-full" />
                </div>
            )}
            {!startPos && (
                <div className="absolute top-20 left-1/2 -translate-x-1/2 text-white/90 bg-black/60 px-6 py-3 rounded-xl text-sm backdrop-blur border border-white/10 select-none shadow-2xl pointer-events-none flex flex-col items-center gap-1">
                    <Crop size={24} className="mb-1 opacity-80"/><span className="font-bold">拖拽选取区域</span><span className="text-[10px] opacity-60">右键退出</span>
                </div>
            )}
        </div>
    );
};

// --- 独立窗口：参考图 ---
export const ReferenceWindow = () => {
    const [imgSrc, setImgSrc] = useState(null);
    const [isTopmost, setIsTopmost] = useState(true);
    const [isGray, setIsGray] = useState(false); 
    const [opacity, setOpacity] = useState(100);
    const [ignoreMouse, setIgnoreMouse] = useState(false);
    // 视图状态
    const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
    const [isDraggingView, setIsDraggingView] = useState(false);

    // [修复 Issue 1 & 4] 加载图片逻辑重构
    const loadRefImage = async (pathOrUrl) => {
        if (!pathOrUrl) return;
        
        // 如果是 Base64 或 http 链接直接显示
        if (pathOrUrl.startsWith('data:') || pathOrUrl.startsWith('http')) {
            setImgSrc(pathOrUrl);
            return;
        }

        // 如果是本地路径，调用后端读取 Base64，彻底解决 asset 协议裂图问题
        try {
            const base64 = await invoke('read_image_as_base64', { path: pathOrUrl });
            setImgSrc(base64);
        } catch (e) {
            console.error("Load ref failed:", e);
            // 失败时尝试回退到 asset 协议 (通常不会走到这)
            import('@tauri-apps/api/core').then(({ convertFileSrc }) => setImgSrc(convertFileSrc(pathOrUrl)));
        }
    };

    useEffect(() => {
        // 1. 优先从 URL 参数读取路径 (解决 LocalStorage 竞态)
        const params = new URLSearchParams(window.location.search);
        const urlPath = params.get('path');
        
        if (urlPath) {
            loadRefImage(urlPath);
        } else {
            // 2. 兼容旧逻辑 (截图预览等)
            const tempImg = localStorage.getItem('ref-temp-img');
            const tempPath = localStorage.getItem('ref-temp-path');
            
            if (tempPath) {
                loadRefImage(tempPath);
                localStorage.removeItem('ref-temp-path');
            } else if (tempImg) {
                setImgSrc(tempImg);
                localStorage.removeItem('ref-temp-img');
            }
        }

        const unlisten = listen('tauri://file-drop', (event) => {
             if(event.payload && event.payload.length > 0) {
                 loadRefImage(event.payload[0]);
             }
        });
        invoke('set_window_topmost', { label: appWindow.label, topmost: true });
        
        const unlistenIgnore = listen('update-ref-ignore', (event) => {
            if (appWindow.label.startsWith('ref-')) {
                setIgnoreMouse(event.payload);
                invoke('set_ignore_cursor_events', { label: appWindow.label, ignore: event.payload });
            }
        });
        return () => { unlisten.then(f => f && f()); unlistenIgnore.then(f => f && f()); };
    }, []);

    const handleWheel = (e) => {
        if (ignoreMouse) return;
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        setView(v => ({ ...v, scale: Math.max(0.1, Math.min(20, v.scale * delta)) }));
    };

    const handleMouseDown = (e) => {
        if (ignoreMouse) return; 
        e.stopPropagation();
        if (e.button === 2) { 
            setIsDraggingView(true); 
        } else if (e.button === 0) { 
            appWindow.startDragging(); 
        }
    };
    
    const handleMouseMove = (e) => {
        if (isDraggingView) {
            setView(v => ({ ...v, x: v.x + e.movementX, y: v.y + e.movementY }));
        }
    };

    return (
        <div className="w-full h-full relative group overflow-hidden bg-transparent"
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if(file && file.type.startsWith('image/')) setImgSrc(URL.createObjectURL(file));
            }}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={() => setIsDraggingView(false)}
            onContextMenu={e => e.preventDefault()}
        >
             <GlobalSvgFilters icc="rec601"/>
            {imgSrc ? (
                <div className={`w-full h-full flex items-center justify-center ${ignoreMouse ? 'pointer-events-none' : ''}`}>
                    <img 
                        src={imgSrc} 
                        draggable={false}
                        className="select-none transition-transform duration-75 ease-out w-full h-full object-contain pointer-events-none"
                        style={{ 
                            // 使用 object-contain 配合 w-full h-full 实现自适应
                            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                            opacity: opacity/100,
                            filter: isGray ? 'url(#dynamic-gray-filter)' : 'none'
                        }} 
                    />
                </div>
            ) : (
                <div className="absolute inset-0 flex items-center justify-center text-white/50 text-xs border-2 border-dashed border-white/20 m-1 rounded pointer-events-none">Drop / Paste</div>
            )}
            {!ignoreMouse && (
                <>
                    {/* 边缘缩放把手 - [修复] 更新 API */}
                    <div className="absolute top-0 left-0 w-full h-2 cursor-ns-resize z-40" onMouseDown={(e)=>{e.stopPropagation();appWindow.startResizeDragging(1);}} />
                    <div className="absolute bottom-0 left-0 w-full h-2 cursor-ns-resize z-40" onMouseDown={(e)=>{e.stopPropagation();appWindow.startResizeDragging(2);}} />
                    <div className="absolute top-0 left-0 w-2 h-full cursor-ew-resize z-40" onMouseDown={(e)=>{e.stopPropagation();appWindow.startResizeDragging(8);}} />
                    <div className="absolute top-0 right-0 w-2 h-full cursor-ew-resize z-40" onMouseDown={(e)=>{e.stopPropagation();appWindow.startResizeDragging(4);}} />
                    <div className="absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize z-50 bg-white/10 hover:bg-slate-500 rounded-tl clip-triangle pointer-events-auto"
                        onMouseDown={(e) => { e.stopPropagation(); appWindow.startResizeDragging(6); }} />
                </>
            )}
            
            <div data-tauri-no-drag 
                 className="absolute top-2 right-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-[9999] pointer-events-auto"
                 onMouseDown={(e) => e.stopPropagation()} 
            >
                    <div className="flex gap-1 justify-end">
                        {/* 重置按钮 */}
                        <button 
                            onClick={(e) => { e.stopPropagation(); setView({x:0, y:0, scale:1}); }} 
                            className="p-1.5 rounded bg-black/60 text-white/80 hover:bg-slate-600 hover:text-white cursor-pointer shadow-sm backdrop-blur-sm" 
                            title="重置视图 (Reset)"
                        >
                            <RotateCcw size={10}/>
                        </button>
                        
                        <button onClick={(e) => { e.stopPropagation(); setIsGray(!isGray); }} className={`p-1.5 rounded transition-colors cursor-pointer shadow-sm backdrop-blur-sm ${isGray ? 'bg-purple-600 text-white' : 'bg-black/60 text-white/80'}`} title="灰度 (Gray)"><Layers size={10}/></button>
                        <button onClick={(e) => { 
                            e.stopPropagation();
                            const newState = !isTopmost; 
                            setIsTopmost(newState); 
                            invoke('set_window_topmost', { label: appWindow.label, topmost: newState }); 
                        }} 
                        className={`p-1.5 rounded transition-colors cursor-pointer shadow-sm backdrop-blur-sm ${isTopmost ? `bg-slate-500 text-white` : 'bg-black/60 text-white/80'}`} title="置顶 (Pin)"><Pin size={10}/></button>
                        <button onClick={(e) => { e.stopPropagation(); appWindow.close(); }} className="p-1.5 rounded bg-red-500 text-white hover:bg-red-600 cursor-pointer shadow-sm backdrop-blur-sm"><X size={10}/></button>
                    </div>
                <input type="range" min="10" max="100" value={opacity} onChange={e=>setOpacity(e.target.value)} 
                    className="w-24 h-1 accent-slate-500 cursor-pointer" onMouseDown={e => e.stopPropagation()} 
                />
        </div>
    </div>
);
};