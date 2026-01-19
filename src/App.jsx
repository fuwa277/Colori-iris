import React, { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTauriBackend } from './hooks/useTauriBackend';
import { getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, listen } from '@tauri-apps/api/event';
import { Palette, Sun, Moon, Minimize2, X, Pin, Eye, Layers, Pipette, Monitor, Image as ImageIcon, Sliders, RefreshCw } from 'lucide-react';

import { LUMA_ALGORITHMS, getLuminance, toGamma, rgbToHsv, hsvToRgb, rgbToHex, hexToRgb } from './colorLogic';
import { GlobalSvgFilters, ColorPickerArea, IsoLuminanceGraph, ColorSliders, RegionSelector, ScreenPanel } from './MyComponents';
import { MonitorWindow, SelectorWindow, ReferenceWindow, ScreenPickerWindow } from './MyWindows'; // [新增]
import { SettingsPanel } from './SettingsPanel';
import { RefPanel } from './RefPanel';

const appWindow = getCurrentWindow();

// --- 文件日志探针 (禁用以提升性能) ---
window.logToFile = (msg) => { /* console.log(msg); */ };
const log = window.logToFile;

// 初始化 Mag API
invoke('init_mag_api').catch(e => console.error("Mag Init Failed:", e));

// [新增] 启动时从本地存储加载自定义 ICC
try {
    const savedIcc = localStorage.getItem('colori_custom_icc');
    if (savedIcc) {
        const parsed = JSON.parse(savedIcc);
        // 动态注入到算法库，键名固定为 'custom'
        LUMA_ALGORITHMS['custom'] = parsed;
    }
} catch (e) { console.error("Load Custom ICC Failed:", e); }

/**
 * MAIN APP
 */
export default function App() {
  const { colorBlockRef } = useTauriBackend();

  // [新增] 使用 Ref 同步最新设置，解决监听器闭包过时问题
  const settingsRef = useRef(null);

  // --- 基础 Hooks 和 状态 ---
  // 主窗口关闭事件监听 & 阻止默认拖拽
  useEffect(() => {
      const handleClose = async (e) => {
          // 通知所有画中画窗口关闭
          await emit('main-window-closed');
          // 允许主窗口关闭
      };

      const unlistenClose = appWindow.onCloseRequested(handleClose);

      const prevent = (e) => e.preventDefault();
      window.addEventListener('dragover', prevent);
      window.addEventListener('drop', prevent);

      return () => {
          unlistenClose.then(f => f());
          window.removeEventListener('dragover', prevent);
          window.removeEventListener('drop', prevent);
      };
  }, []);

  // [新增] 参考图记忆恢复逻辑 (放在组件顶部)
  useEffect(() => {
      // [关键修复] 仅在主窗口执行恢复逻辑，防止子窗口(参考图)启动时递归创建导致死循环
      if (appWindow.label !== 'main') return;

      const initRefRecovery = async () => {
          const shouldRemember = JSON.parse(localStorage.getItem('colori_remember_refs') || 'false');
          let keepList = [];

          if (shouldRemember) {
              try {
                  const savedSession = JSON.parse(localStorage.getItem('colori_ref_session_data') || '{}');
                  console.log("Restoring refs:", savedSession);
                  
                  // 1. 收集需要保留的文件路径
                  Object.values(savedSession).forEach(item => {
                      if (item.path && !item.path.startsWith('http')) {
                          keepList.push(item.path);
                      }
                  });

                  // 2. 清理其他垃圾文件 (传入保留列表)
                  await invoke('clean_temp_images', { keepFiles: keepList });

                  // 3. 恢复窗口
                  Object.entries(savedSession).forEach(([label, data], idx) => {
                      // 稍微错开启动时间，防止瞬时压力过大
                      setTimeout(() => {
                          try {
                              new WebviewWindow(`ref-restored-${Date.now()}-${idx}`, {
                                  url: `index.html?path=${encodeURIComponent(data.path)}`, 
                                  title: 'Ref',
                                  x: data.x, y: data.y, width: data.w, height: data.h,
                                  decorations: false, transparent: true, alwaysOnTop: data.isTopmost ?? true, 
                                  skipTaskbar: false
                              });
                          } catch(e) { console.error("Restore win failed", e); }
                      }, idx * 100);
                  });
              } catch(e) { console.error("Ref recovery failed", e); }
          } else {
              //如果不记忆，则清空所有临时文件
              await invoke('clean_temp_images', { keepFiles: [] });
          }
      };
      // 延时执行，确保后端就绪
      setTimeout(initRefRecovery, 500);

      // 监听子窗口汇报
      const unlistenReport = listen('ref-report-state', (e) => {
          const { label, ...data } = e.payload;
          refSessionRef.current[label] = data;
          // 防抖写入本地存储
          if (window._saveRefTimer) clearTimeout(window._saveRefTimer);
          window._saveRefTimer = setTimeout(() => {
              if (JSON.parse(localStorage.getItem('colori_remember_refs') || 'false')) {
                  localStorage.setItem('colori_ref_session_data', JSON.stringify(refSessionRef.current));
              }
          }, 1000);
      });

      // 监听子窗口关闭
      const unlistenClosed = listen('ref-window-closed', (e) => {
          const { label } = e.payload;
          delete refSessionRef.current[label];
          localStorage.setItem('colori_ref_session_data', JSON.stringify(refSessionRef.current));
      });

      return () => {
          unlistenReport.then(f=>f());
          unlistenClosed.then(f=>f());
      }
  }, []);

// 辅助函数：打开覆盖全屏的选区窗口
const openSelectorWindow = async (label, url) => {
    try {
        // 1. 获取虚拟桌面总边界
        const bounds = await invoke('get_total_monitor_bounds');
        
        // 2. 创建窗口覆盖所有屏幕
        new WebviewWindow(label, {
            url: url,
            x: bounds.x,
            y: bounds.y,
            width: bounds.w,
            height: bounds.h,
            transparent: true, 
            decorations: false, 
            alwaysOnTop: true, 
            skipTaskbar: true, 
            resizable: false,
            visible: false, // 初始隐藏，防止闪烁
            fullscreen: false // [关键] 必须关闭系统全屏，使用手动坐标
        });
    } catch (e) {
        console.error("Failed to open selector:", e);
    }
};

  useEffect(() => {
      // --- [Probe Start] 拖拽调试探针 ---
      console.log("[App] File Drop Listener Mounted");

      const unlistenHover = listen('tauri://file-drop-hover', (event) => {
          console.log('[Probe] Drag Hover detected:', event); // 如果这行没打印，说明被系统拦截了
      });

      const unlistenCancel = listen('tauri://file-drop-cancelled', () => {
          console.log('[Probe] Drag Cancelled');
      });

      const unlistenDrop = listen('tauri://file-drop', (event) => {
          if (event.payload && event.payload.length > 0) {
              const filePath = event.payload[0];
              const label = `ref-file-${Date.now()}`;
              // [同步103] 通过路径传参解决 LocalStorage 竞态导致的加载失败
              try {
                  new WebviewWindow(label, {
                      url: `index.html?path=${encodeURIComponent(filePath)}`,
                      width: 300, height: 300,
                      decorations: false, transparent: true, alwaysOnTop: true
                  });
              } catch (e) {
                  console.error('Window creation failed:', e);
              }
          }
      });

      return () => { 
          unlistenDrop.then(f => f && f()); 
          unlistenHover.then(f => f && f());
          unlistenCancel.then(f => f && f());
      };
      // --- [Probe End] ---
  }, []);

  // [修复 Issue 1] 优先从 URL 参数读取路径，解决 LocalStorage 竞态导致的裂图
  useEffect(() => {
      if (appWindow.label.startsWith('ref-')) {
          const params = new URLSearchParams(window.location.search);
          const path = params.get('path');
          if (path) {
              localStorage.setItem('ref-temp-path', path);
          }
      }
  }, []);

  // 1. 路由分发 (子窗口逻辑)
  if (appWindow.label.startsWith('monitor-')) return <MonitorWindow />;
  if (appWindow.label.startsWith('ref-')) return <ReferenceWindow />;
  if (appWindow.label.startsWith('selector')) return <SelectorWindow />;
  if (appWindow.label === 'picker-overlay') return <ScreenPickerWindow />; // [新增]
  if (appWindow.label === 'sync_spot') {
      const slots = JSON.parse(localStorage.getItem('colori_slots') || '[]');
      const active = parseInt(localStorage.getItem('colori_active_slot') || '0');
      const c = slots[active] || {r:0,g:0,b:0};
      const hex = rgbToHex(c.r,c.g,c.b);
      
      // 监听颜色变化实时更新
      useEffect(() => {
          const check = () => {
              const s = JSON.parse(localStorage.getItem('colori_slots') || '[]');
              const a = parseInt(localStorage.getItem('colori_active_slot') || '0');
              const nc = s[a] || {r:0,g:0,b:0};
              document.body.style.backgroundColor = rgbToHex(nc.r,nc.g,nc.b);
          };
          window.addEventListener('storage', check);
          const i = setInterval(check, 200); // 轮询保底
          return () => { window.removeEventListener('storage', check); clearInterval(i); };
      }, []);

      return <div className="w-full h-full" style={{ backgroundColor: hex, border: '1px solid white' }} />;
  }
  if (appWindow.label === 'overlay') {
      let safeIcc = 'rec601';
      try { safeIcc = JSON.parse(localStorage.getItem('colori_settings')).iccProfile || 'rec601'; } catch {}
      return (
        <div className="w-screen h-screen overflow-hidden pointer-events-none" 
            style={{ backgroundColor: 'transparent', filter: 'url(#dynamic-gray-filter)', backdropFilter: 'grayscale(100%)' }} 
        >
             <GlobalSvgFilters icc={safeIcc} />
        </div>
      );
  }

  // --- 状态管理 ---
  const loadState = (key, defaultVal) => {
      try { return JSON.parse(localStorage.getItem(key)) || defaultVal; } catch { return defaultVal; }
  };

  const [colorSlots, setColorSlots] = useState(() => loadState('colori_slots', [{r:255, g:100, b:100}, {r:255, g:255, b:255}, {r:0, g:0, b:0}]));
  const [activeSlot, setActiveSlot] = useState(0);
  const [paletteHistory, setPaletteHistory] = useState(() => loadState('colori_history', []));
  const [savedPalette, setSavedPalette] = useState(() => loadState('colori_saved', []));
 const [settings, setSettings] = useState(() => loadState('colori_settings', {
      hotkeys: true, 
      hotkeyGray: 'Alt+G',      // 修改默认: 增加 Alt
      hotkeyPick: 'Alt+Space',  // 修改默认
      hotkeyMonitor: 'Alt+F2',  // 修改默认
      hotkeyRegion: '',         // 新增
      hotkeyRef: '',            // 新增
      hotkeyShowHide: 'F8',     // [同步103] 默认显隐热键
      globalRegion: true,       // 默认开启全局
      globalRef: true,          // 默认开启全局
      globalShowHide: true,     // [同步103]
      leftHanded: false,        // [需求1] 左手模式 (镜像布局)
      hotkeySyncEnabled: false, 
      hotkeySyncApp: '', 
      hotkeySyncKey: 'Shift+F12', // 默认触发键
      hotkeySyncPickKey: 'Shift+I', // 默认取色键
      useGamma: true, // 默认开启 Gamma
      aiFilter: true, feedTags: '高级感', topmost: false, grayMode: 'custom',
      syncOnToggle: false
  }));
  const [runningApps, setRunningApps] = useState([]); 
  const [monitorPos, setMonitorPos] = useState(null);
  
  // [需求] UI 缩放状态 (Ctrl+滚轮)
  const [uiZoom, setUiZoom] = useState(() => parseFloat(localStorage.getItem('colori_ui_zoom') || '1'));
  const [showZoomTip, setShowZoomTip] = useState(false);
  const zoomTipTimer = useRef(null);
  
  // 监听 Ctrl+滚轮
  useEffect(() => {
      const handleWheel = (e) => {
          if (e.ctrlKey) {
              e.preventDefault();
              const delta = e.deltaY > 0 ? -0.05 : 0.05; // 滚轮向下缩小，向上放大
              setUiZoom(prev => {
                  const val = Math.min(Math.max(0.6, prev + delta), 2.0); // 限制范围 0.6x ~ 2.0x
                  localStorage.setItem('colori_ui_zoom', val);
                  
                  // 触发右上角提示
                  setShowZoomTip(true);
                  if (zoomTipTimer.current) clearTimeout(zoomTipTimer.current);
                  zoomTipTimer.current = setTimeout(() => setShowZoomTip(false), 2000);
                  
                  return val;
              });
          }
      };
      // 添加到 window 并在捕获阶段阻止浏览器默认缩放
      window.addEventListener('wheel', handleWheel, { passive: false });
      return () => window.removeEventListener('wheel', handleWheel);
  }, []);

  // [Issue 2] 独立的监控色状态，不干扰主色槽
  const [monitorRgb, setMonitorRgb] = useState({ r:0, g:0, b:0 });
  // [需求1] 监控同步开关
  const [monitorSync, setMonitorSync] = useState(false);
  const [isPickingPixel, setIsPickingPixel] = useState(false);
  // [修复] 色环区域高度状态 (读取记忆，默认 240px 可容纳约 170px 色环)
  const [pickerHeight, setPickerHeight] = useState(() => {
      try { return parseInt(localStorage.getItem('colori_picker_height') || '240'); } catch { return 240; }
  });
  
  // [新增] 参考图记忆相关状态
  const [rememberRefs, setRememberRefs] = useState(() => loadState('colori_remember_refs', false));
  const refSessionRef = useRef({}); // 使用 Ref 存储瞬时状态，避免频繁重渲染

  // [新增] WGC 支持检测 (用于 App 级调用)
  const [wgcSupported, setWgcSupported] = useState(true);
  useEffect(() => {
        invoke('get_os_build_version').then(ver => {
            if (ver < 18362) setWgcSupported(false);
        });
  }, []);

  // [新增] 打开画中画窗口 (提升至 App 级以支持全局快捷键)
  const openPip = async (src, startVisible = false) => {
        if (!wgcSupported) return;
        const label = `monitor-${src.id}`;
        let params = `?mode=mag&id=${src.id}&type=${src.type}&label=${encodeURIComponent(src.label)}&tid=${src.targetId || 0}`;
        if (src.crop) {
            params += `&x=${src.crop.x}&y=${src.crop.y}&w=${src.crop.w}&h=${src.crop.h}`;
        }
        
        try {
            new WebviewWindow(label, {
                url: `index.html${params}`,
                skipTaskbar: !startVisible, 
                title: src.label || 'Monitor',
                width: src.crop ? src.crop.w : 400, 
                height: src.crop ? src.crop.h : 300,
                minWidth: 50, minHeight: 50,
                transparent: true, 
                backgroundColor: "#00000000",
                alwaysOnTop: true,
                decorations: false,
                shadow: true,
                visible: false 
            });
            
            if (startVisible) {
                setTimeout(async () => {
                    const win = await WebviewWindow.getByLabel(label);
                    if(win) {
                        await win.setSkipTaskbar(false);
                        await win.show();
                        await win.setFocus();
                    }
                }, 300);
            }
        } catch(e) { console.error("OpenPip failed:", e); }
  };

  const [macroStep, setMacroStep] = useState(null); // 新增：宏调试步骤状态
  
  // [需求2 & 3] 面板折叠与滑块配置
  const [panelConfig, setPanelConfig] = useState(() => loadState('colori_panel_config', {
      sliderCollapsed: false,
      schemeCollapsed: false,
      sliderMultiMode: false, // 是否开启多选模式
      activeSliderModes: ['RGB'] // 多选模式下激活的滑块
  }));

  // 1. 修改默认主题为 false (浅色), 保持 loadState 读取记忆
  const [isDark, setIsDark] = useState(() => loadState('colori_theme', false));
  const [lang, setLang] = useState(() => loadState('colori_lang', 'zh'));
  const [monitorSources, setMonitorSources] = useState([]);
  const [activeTab, setActiveTab] = useState('color');
  const [selectionMode, setSelectionMode] = useState(null); 
  const [refIgnoreMouse, setRefIgnoreMouse] = useState(false); 
  const [subTab, setSubTab] = useState('sketch');
  const [pickerMode, setPickerMode] = useState('triangle');
  const [sliderMode, setSliderMode] = useState('RGB'); // [修复 Issue 8] 状态提升
  const [isGrayscale, setIsGrayscale] = useState(false);
  const [iccProfile, setIccProfile] = useState('rec601');
  const [schemeLockColor, setSchemeLockColor] = useState(null);
  // 配色刷新按钮独立种子
  const [randomSeed, setRandomSeed] = useState(0);
  const [similarSeed, setSimilarSeed] = useState(0);
  // [修复 UI] 清除历史的确认状态
  const [clearHistoryConfirm, setClearHistoryConfirm] = useState(false);
  
  // 修复: 系统滤镜切换冷却锁，防止轮询覆盖手动操作
  const lastGrayToggleRef = useRef(0);

  // --- 计算属性 ---
  const hsv = useMemo(() => rgbToHsv(colorSlots[activeSlot].r, colorSlots[activeSlot].g, colorSlots[activeSlot].b), [colorSlots, activeSlot]);
  const rgb = colorSlots[activeSlot];
  const luma = useMemo(() => getLuminance(rgb.r, rgb.g, rgb.b, iccProfile), [rgb, iccProfile]);
  const t = (zh, en) => lang === 'zh' ? zh : en;

  // --- 新增：本地文件数据同步 ---
  // 1. 启动时读取文件 (合并到 State)
  useEffect(() => {
      const initLoad = async () => {
          try {
              const jsonStr = await invoke('load_config_file');
              if (!jsonStr || jsonStr === "{}") return; // 文件不存在或为空，使用 localStorage 的默认值
              
              const data = JSON.parse(jsonStr);
              console.log("Loaded config from file:", data);

              if (data.settings) setSettings(prev => ({...prev, ...data.settings}));
              if (data.colorSlots) setColorSlots(data.colorSlots);
              if (data.activeSlot !== undefined) setActiveSlot(data.activeSlot);
              if (data.paletteHistory) setPaletteHistory(data.paletteHistory);
              if (data.savedPalette) setSavedPalette(data.savedPalette);
              if (data.isDark !== undefined) setIsDark(data.isDark);
              if (data.lang) setLang(data.lang);
              if (data.iccProfile) setIccProfile(data.iccProfile);
              
              // 特殊处理自定义ICC
              if (data.customIcc) {
                  localStorage.setItem('colori_custom_icc', JSON.stringify(data.customIcc));
                  LUMA_ALGORITHMS['custom'] = data.customIcc;
              }
          } catch (e) {
              console.error("Failed to load config file:", e);
          }
      };
      initLoad();
  }, []);

  // 2. 数据变更时防抖写入文件
  useEffect(() => {
      const timer = setTimeout(() => {
          const dataToSave = {
              settings,
              colorSlots,
              activeSlot,
              paletteHistory,
              savedPalette,
              isDark,
              lang,
              iccProfile,
              customIcc: JSON.parse(localStorage.getItem('colori_custom_icc') || 'null')
          };
          invoke('save_config_file', { data: JSON.stringify(dataToSave, null, 2) })
              .catch(e => console.error("Save failed:", e));
      }, 1000); // 1秒防抖，避免频繁IO

      return () => clearTimeout(timer);
  }, [settings, colorSlots, activeSlot, paletteHistory, savedPalette, isDark, lang, iccProfile]);

  // --- 副作用 (Effects) ---
  useEffect(() => localStorage.setItem('colori_history', JSON.stringify(paletteHistory)), [paletteHistory]);
  useEffect(() => localStorage.setItem('colori_saved', JSON.stringify(savedPalette)), [savedPalette]);
  
  // [修复卡顿] 优化版防抖：使用 useRef 保持定时器，避免高频创建对象
  const saveSlotsTimer = useRef(null);
  useEffect(() => {
      if (saveSlotsTimer.current) clearTimeout(saveSlotsTimer.current);
      saveSlotsTimer.current = setTimeout(() => {
          localStorage.setItem('colori_slots', JSON.stringify(colorSlots));
      }, 500);
      return () => { if(saveSlotsTimer.current) clearTimeout(saveSlotsTimer.current); };
  }, [colorSlots]);

  const saveActiveTimer = useRef(null);
  useEffect(() => {
      if (saveActiveTimer.current) clearTimeout(saveActiveTimer.current);
      saveActiveTimer.current = setTimeout(() => {
          localStorage.setItem('colori_active_slot', activeSlot);
      }, 500);
      return () => { if(saveActiveTimer.current) clearTimeout(saveActiveTimer.current); };
  }, [activeSlot]);

  useEffect(() => localStorage.setItem('colori_theme', JSON.stringify(isDark)), [isDark]);
  useEffect(() => localStorage.setItem('colori_panel_config', JSON.stringify(panelConfig)), [panelConfig]);
  useEffect(() => localStorage.setItem('colori_lang', JSON.stringify(lang)), [lang]);
  // [修复] 保存高度记忆
  useEffect(() => localStorage.setItem('colori_picker_height', pickerHeight), [pickerHeight]);
  
  useEffect(() => {
      const updatedSettings = { ...settings, iccProfile };
      localStorage.setItem('colori_settings', JSON.stringify(updatedSettings));
      // 同步 Ref
      settingsRef.current = updatedSettings;
      emit('settings-changed', updatedSettings);
  }, [settings, iccProfile]);

  useEffect(() => {
      invoke('set_sync_hotkey', { keyCombo: settings.hotkeySyncKey || 'I' });
      invoke('set_sync_pick_key', { keyChar: settings.hotkeySyncPickKey || '' });
      invoke('set_target_process_name', { name: settings.hotkeySyncApp || '' });
      invoke('set_sync_enabled', { enabled: settings.hotkeySyncEnabled || false });
      
      // 注册额外热键
      let flags = 0;
      if (settings.globalGray) flags |= 1;
      if (settings.globalPick) flags |= 2;
      if (settings.globalMonitor) flags |= 4;
      if (settings.globalRegion ?? true) flags |= 8;
      if (settings.globalRef ?? true) flags |= 16;
      if (settings.globalShowHide ?? true) flags |= 32;
      
      console.log("[App] Updating Global Hotkeys:", {
          gray: settings.hotkeyGray, 
          pick: settings.hotkeyPick, 
          moni: settings.hotkeyMonitor, 
          region: settings.hotkeyRegion,
          ref: settings.hotkeyRef,
          show: settings.hotkeyShowHide,
          flags
      });

      invoke('update_extra_hotkeys', { 
          gray: settings.hotkeyGray||"", pick: settings.hotkeyPick||"", moni: settings.hotkeyMonitor||"", 
          region: settings.hotkeyRegion||"", refKey: settings.hotkeyRef||"",
          show: settings.hotkeyShowHide||"",
          flags 
      }).catch(err => console.error("Failed to update hotkeys", err));
      
  }, [settings]); // 依赖保持 settings

  // 监听后端发来的全局热键事件 & 托盘解绑信号 & 宏调试事件
  useEffect(() => {
      // 1. 统一的面板显隐/定位控制逻辑 (区分 快捷键/托盘 触发方式)
      const toggleMainWindow = async (followMouse = true, forceShow = false) => {
          const isMinimized = await appWindow.isMinimized();
          const visible = await appWindow.isVisible();
          
          // 从 Ref 读取最新设置，确保逻辑实时性
          const currentSettings = settingsRef.current || settings;
          
          if (!forceShow && visible && !isMinimized) {
              // [新增] 如果通过快捷键最小化，且开启了联动吸色
              if (followMouse && currentSettings.syncOnToggle) {
                  invoke('run_sync_macro');
              }
              await appWindow.minimize();
          } else {
              try {
                  await appWindow.unminimize();
                  
                  // 只有当 followMouse 为 true 时（快捷键触发），才重新定位到鼠标位置
                  if (followMouse) {
                      const pos = await invoke('get_mouse_pos'); 
                      // 定位算法：X轴偏移140，Y轴偏移220，让面板中心精准对齐鼠标
                      await appWindow.setPosition(new PhysicalPosition(pos[0] - 140, pos[1] - 220));
                  }
                  
                  await appWindow.show();
                  await appWindow.setFocus();
              } catch (err) {
                  // 兜底方案：直接显示
                  await appWindow.unminimize();
                  await appWindow.show();
                  await appWindow.setFocus();
              }
          }
      };

      const unlistenMacro = listen('macro-debug-step', (e) => {
          if (e.payload === 'DONE') setMacroStep(null);
          else setMacroStep(e.payload);
      });

      const unlistenPicker = listen('picker-color-selected', (e) => {
          const hex = e.payload;
          const c = hexToRgb(hex);
          if (c) {
              setColorSlots(prev => {
                  const next = [...prev]; next[activeSlot] = c; if(activeSlot!==0) next[0]=c; return next;
              });
          }
          window._isPicking = false;
      });

      const unlistenPickerClose = listen('picker-closed', () => { window._isPicking = false; });

      // [新增] 监听托盘信号，实现 WakePip 解绑 (托盘触发时不跟随鼠标)
      const unlistenTray = listen('tray-show-main', () => {
          // [修复] 托盘触发固定为 forceShow: true，防止双击导致一开一关
          toggleMainWindow(false, true);
      });

      const unlistenHotkeys = listen('global-hotkey', async (e) => {
          if (e.payload === 'gray') {
              lastGrayToggleRef.current = Date.now();
              if (settings.grayMode === 'system') {
                  invoke('trigger_system_grayscale');
                  setIsGrayscale(p => !p);
              } else setIsGrayscale(p => !p);
          }
          if (e.payload === 'pick') {
              if (!window._isPicking) {
                  window._isPicking = true;
                  try {
                      await invoke('capture_current_monitor_snapshot');
                      new WebviewWindow('picker-overlay', {
                          url: 'index.html?mode=picker',
                          transparent: true, decorations: false, alwaysOnTop: true, 
                          skipTaskbar: true, resizable: false, focus: true, visible: false,
                          fullscreen: true 
                      });
                  } catch(err) { 
                      console.error(err);
                      window._isPicking = false; 
                  }
              }
          }
          if (e.payload === 'monitor') {
              setIsPickingPixel(true);
          }
          if (e.payload === 'region') {
              new WebviewWindow(`selector-monitor-${Date.now()}`, {
                  url: 'index.html?mode=monitor',
                  transparent: true, fullscreen: true, alwaysOnTop: true, 
                  skipTaskbar: true, decorations: false, resizable: false,
                  visible: false
              });
          }
          if (e.payload === 'ref') {
              new WebviewWindow(`selector-shot-${Date.now()}`, {
                  url: 'index.html?mode=screenshot',
                  transparent: true, fullscreen: true, alwaysOnTop: true, 
                  skipTaskbar: true, decorations: false, resizable: false,
                  visible: false
              });
          }
          if (e.payload === 'show_hide') {
              // 快捷键触发时，明确传递 true 使其跟随鼠标
              toggleMainWindow(true);
          }
      });

      return () => { 
          unlistenMacro.then(f=>f()); 
          unlistenPicker.then(f=>f());
          unlistenPickerClose.then(f=>f());
          unlistenTray.then(f=>f());
          unlistenHotkeys.then(f=>f());
      };
  }, [settings.grayMode, activeSlot]);

  useEffect(() => {
     if(window.__TAURI__) invoke('set_window_topmost', { topmost: settings.topmost }).catch(console.error);
  }, [settings.topmost]);

  useEffect(() => { 
      if (activeTab === 'settings') invoke('get_running_apps').then(setRunningApps).catch(console.error); 
      // 修复9: 监听刷新事件
      const unlisten = listen('refresh-apps-list', (e) => setRunningApps(e.payload));
      return () => { unlisten.then(f=>f()); };
  }, [activeTab]);
  useEffect(() => { emit('update-ref-ignore', refIgnoreMouse); }, [refIgnoreMouse]);

  // Effect 1: 处理 Mag API 滤镜的应用 (仅当 mode 为 custom 时)
  useEffect(() => {
      const applyMagFilter = async () => {
          if (settings.grayMode !== 'custom') {
              // 如果切走了，确保关闭 Mag 滤镜
              await invoke('set_fullscreen_grayscale', { enable: false, matrixValues: null });
              return;
          }

          if (isGrayscale) {
              let coeffs = LUMA_ALGORITHMS[iccProfile];
              if (!coeffs || typeof coeffs.r !== 'number') coeffs = LUMA_ALGORITHMS['rec601'];
              const { r, g, b } = coeffs;
              const matrix = [ 
                  r, r, r, 0.0, 0.0, 
                  g, g, g, 0.0, 0.0, 
                  b, b, b, 0.0, 0.0, 
                  0.0, 0.0, 0.0, 1.0, 0.0, 
                  0.0, 0.0, 0.0, 0.0, 1.0 
              ];
              await invoke('set_fullscreen_grayscale', { enable: true, matrixValues: matrix });
          } else {
              await invoke('set_fullscreen_grayscale', { enable: false, matrixValues: null });
          }
      };
      applyMagFilter();
  }, [isGrayscale, settings.grayMode, iccProfile]);

  // Effect 2: 处理系统滤镜状态轮询 (仅当 mode 为 system 时)
  useEffect(() => {
      let interval;
      if (settings.grayMode === 'system') {
          // 切换到系统模式时，先确保 Mag 滤镜关闭
          invoke('set_fullscreen_grayscale', { enable: false, matrixValues: null });
          
          const check = async () => {
              // 如果距离上次手动切换小于 2 秒，跳过轮询同步
              if (Date.now() - lastGrayToggleRef.current < 2000) return;

              const status = await invoke('check_system_grayscale_status');
              // 只有当状态真正改变时才更新，防止死循环
              setIsGrayscale(prev => prev !== status ? status : prev);
          };
          check();
          interval = setInterval(check, 1000);
      }
      return () => { if(interval) clearInterval(interval); };
  }, [settings.grayMode]); // 依赖仅有 mode，不依赖 isGrayscale，防止循环触发

  // 快捷键监听
  useEffect(() => {
    const handleKey = async (e) => {
      if (e.repeat) return; // 防止长按重复触发 (Fix Point 9)
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (!settings.hotkeys) return;

      // 解析按键组合
      const keys = [];
      if (e.metaKey) keys.push('WIN');
      if (e.ctrlKey) keys.push('CTRL');
      if (e.shiftKey) keys.push('SHIFT');
      if (e.altKey) keys.push('ALT');
      
      let k = e.key.toUpperCase();
      const map = { ' ': 'SPACE', 'ARROWUP': '↑', 'ARROWDOWN': '↓', 'ARROWLEFT': '←', 'ARROWRIGHT': '→' };
      k = map[k] || k;
      if (!['CONTROL','SHIFT','ALT','META'].includes(k)) keys.push(k);
      
      const currentCombo = keys.join('+');

      // 匹配逻辑
      const match = (settingKey) => settingKey && settingKey.toUpperCase() === currentCombo;

      // [修复] 移除前端重复监听，统一由后端 global-hotkey 事件触发，防止聚焦时双重切换
      if (match(settings.hotkeyGray)) {
          e.preventDefault(); // 仅阻止默认行为（如网页内搜索等），不执行逻辑
      }
      if (match(settings.hotkeyPick)) {
          e.preventDefault();
      }
      if (match(settings.hotkeyMonitor)) {
          e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [settings, monitorPos, isGrayscale]); // 增加 isGrayscale 依赖

  // 监控器轮询
  useEffect(() => {
      let interval;
      if (monitorPos) {
          interval = setInterval(async () => {
              try {
                  const [r, g, b] = await invoke('get_pixel_color', { x: monitorPos.x, y: monitorPos.y });
                  // [Issue 2] 仅更新监控色状态
                  setMonitorRgb({ r, g, b });
                  // [需求1] 如果开启了同步，且颜色发生变化（简单判断），则同步到主色槽
                  if (monitorSync) {
                      handleRgbChange({ r, g, b }, true);
                  }
              } catch (e) {}
          }, 100); // 优化: 降低轮询频率至 100ms (10FPS) 以节省 CPU
      }
      return () => clearInterval(interval);
  }, [monitorPos, monitorSync]); // 增加 monitorSync 依赖

  // 鼠标按下检测 (定点吸色)
  useEffect(() => {
      if (!isPickingPixel) return;
      let clickCheckTimer;
      const startDelay = setTimeout(() => {
          clickCheckTimer = setInterval(async () => {
              try {
                  const isDown = await invoke('is_mouse_down');
                  if (isDown) {
                      const [x, y] = await invoke('get_mouse_pos');
                      setMonitorPos({ x, y });
                      setIsPickingPixel(false); 
                  }
              } catch(e) {}
          }, 30); 
      }, 300);
      return () => { clearTimeout(startDelay); clearInterval(clickCheckTimer); };
  }, [isPickingPixel]);

  // [修复] 全局监控源管理 (整合了截图参考与屏幕监控)
  useEffect(() => {
      // 1. 区域选择/截图监听
      const unlistenRegion = listen('region-selected', async (event) => {
          const rect = event.payload;
          
          // Case A: 添加区域监控
          if (rect.purpose === 'monitor') {
              const newSource = {
                  id: Date.now(),
                  type: 'region',
                  crop: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }, 
                  label: `Region ${Math.round(rect.w)}x${Math.round(rect.h)}`
              };
              setMonitorSources(prev => [...prev, newSource]);
              openPip(newSource, false); // 立即创建窗口
          }
          
          // Case B: 截图参考
          if (rect.purpose === 'screenshot') {
             try {
                await new Promise(r => setTimeout(r, 200)); 
                setTimeout(async () => {
                    const dataUrl = await invoke('capture_region', { 
                        x: Math.round(rect.x), y: Math.round(rect.y), 
                        w: Math.round(rect.w), h: Math.round(rect.h) 
                    });
                    
                    const filePath = await invoke('save_temp_image', { dataUrl });
                    const pos = rect.logical || rect;

                    // [修复 1] 智能尺寸计算：防止因系统最小宽度限制导致图片显示不全
                    const MIN_WIN_WIDTH = 160; // 设定一个安全的最小宽度（容纳按钮）
                    let finalW = Math.round(rect.w);
                    let finalH = Math.round(rect.h);
                    const ratio = finalW / finalH;

                    // 如果截图宽度小于最小宽度，强制拉大宽度，并按比例拉大高度
                    if (finalW < MIN_WIN_WIDTH) {
                        finalW = MIN_WIN_WIDTH;
                        finalH = Math.round(finalW / ratio);
                    }

                    new WebviewWindow(`ref-${Date.now()}`, {
                        url: `index.html?path=${encodeURIComponent(filePath)}`, 
                        title: 'Ref',
                        x: Math.round(pos.x), 
                        y: Math.round(pos.y), 
                        // 使用计算后的 finalW / finalH
                        width: finalW, 
                        height: finalH,
                        decorations: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: true
                    });
                }, 200);
             } catch(e) { console.error(e); }
          }
      });

      // 2. 状态变更监听 (灰度等)
      const unlistenState = listen('monitor-state-changed', (e) => {
          setMonitorSources(prev => prev.map(s => {
              if (`monitor-${s.id}` === e.payload.label) {
                  return { ...s, isGray: e.payload.isGray };
              }
              return s;
          }));
      });

      // 3. 可见性变更监听 (同步窗口显隐状态)
      const unlistenVis = listen('monitor-visibility-changed', (e) => {
           setMonitorSources(prev => prev.map(s => {
              if (`monitor-${s.id}` === e.payload.label) {
                  return { ...s, active: e.payload.visible };
              }
              return s;
          }));
      });

      // 4. 配置更新监听 (二次裁剪)
      const unlistenConfigUpdate = listen('update-source-config', (e) => {
          const { id, newConfig } = e.payload;
          setMonitorSources(prev => prev.map(s => {
              if (String(s.id) === String(id)) {
                  return { 
                      ...s, 
                      crop: { x: newConfig.x, y: newConfig.y, w: newConfig.w, h: newConfig.h },
                      label: newConfig.label || s.label
                  };
              }
              return s;
          }));
      });

      return () => {
          unlistenRegion.then(f => f());
          unlistenState.then(f => f());
          unlistenVis.then(f => f());
          unlistenConfigUpdate.then(f => f());
      };
  }, [wgcSupported]); // 依赖 wgcSupported

  // --- 历史记录逻辑处理 ---
  // 1. 实时更新 (不写历史)
  const handleColorChange = (newHsv) => {
      // [修复 Issue 4] 手动调色不再打断定点吸色
      // if (monitorPos) setMonitorPos(null);
      const targetSlotIdx = activeSlot; 
      const currentRgb = colorSlots[targetSlotIdx] || {r:0,g:0,b:0};
      const currentHsv = rgbToHsv(currentRgb.r, currentRgb.g, currentRgb.b);
      const merged = { ...currentHsv, ...newHsv };
      const newRgb = hsvToRgb(merged.h, merged.s, merged.v);
      const newSlots = [...colorSlots];
      newSlots[targetSlotIdx] = newRgb;
      if (targetSlotIdx !== 0) newSlots[0] = newRgb;
      setColorSlots(newSlots);
  };

  // 2. 写入历史 (由鼠标松开事件触发)
  const commitToHistory = () => {
      const currentHex = rgbToHex(colorSlots[activeSlot].r, colorSlots[activeSlot].g, colorSlots[activeSlot].b);
      setPaletteHistory(prev => {
          if (prev[0] === currentHex) return prev; 
          return [currentHex, ...prev].slice(0, 64); // 历史上限 64
      });
  };

  // 需要将 commitToHistory 传递给 ColorPickerArea
  
  const handleRgbChange = (newRgb, isFromMonitor = false) => { 
      // [修复 Issue 4] 仅在非监控模式下的外部变动才可能影响，但这里我们也允许共存
      // if (!isFromMonitor && monitorPos) setMonitorPos(null); 
      const newSlots = [...colorSlots];
      newSlots[activeSlot] = newRgb;
      if (activeSlot !== 0) newSlots[0] = newRgb;
      setColorSlots(newSlots);
  };

  const generateScheme = (type) => {
      const base = schemeLockColor || hsv;
      const { h, s, v } = base;
      let offsets = [];
      if (type === 'complement') offsets = [180];
      if (type === 'analogous') offsets = [-30, 30];
      if (type === 'triadic') offsets = [120, 240];
      if (type === 'split') offsets = [150, 210];
      if (type === 'tetradic') offsets = [90, 180, 270];
      
      // 完全随机 (保持原样)
      if (type === 'random') {
           return Array(4).fill(0).map(() => ({ h: Math.random()*360, s: 60+Math.random()*40, v: 70+Math.random()*30 }));
      }
      return offsets.map(o => {
          let newH = (h + o) % 360;
          if (newH < 0) newH += 360;
          return { h: newH, s, v };
      });
  };

  // 修复: 相似随机逻辑分离。
  // 1. 根据 similarSeed 生成固定的“偏移量”，而不是直接生成颜色。
  const similarOffsets = useMemo(() => {
      return Array(4).fill(0).map(() => ({
          dh: Math.random() * 60 - 30, // 色相偏移 ±30
          ds: Math.random() * 40 - 20, // 饱和度偏移 ±20
          dv: Math.random() * 40 - 20  // 亮度偏移 ±20
      }));
  }, [similarSeed]); // 仅当点击刷新(改变seed)时重算偏移量

  // 2. 根据当前颜色 + 偏移量 计算最终颜色
  const similarScheme = useMemo(() => {
      const base = schemeLockColor || hsv;
      return similarOffsets.map(offset => ({
          h: (base.h + offset.dh + 360) % 360,
          s: Math.max(0, Math.min(100, base.s + offset.ds)),
          v: Math.max(0, Math.min(100, base.v + offset.dv))
      }));
  }, [similarOffsets, schemeLockColor, hsv]); // 颜色变动时，应用相同的偏移量，不再闪烁

  const randomScheme = useMemo(() => generateScheme('random'), [randomSeed]);

  // --- 关键修复：内容渲染分离 ---
  // 将中间复杂的 Tab 内容渲染提取出来，避免大括号嵌套错误
  const renderActiveTabContent = () => {
      switch (activeTab) {
          case 'screen':
              return <ScreenPanel isDark={isDark} lang={lang} sources={monitorSources} setSources={setMonitorSources} />;
          case 'push':
              return <RefPanel 
                  isDark={isDark} t={t} 
                  refIgnoreMouse={refIgnoreMouse} setRefIgnoreMouse={setRefIgnoreMouse}
                  rememberRefs={rememberRefs} 
                  setRememberRefs={(val) => {
                      setRememberRefs(val);
                      localStorage.setItem('colori_remember_refs', JSON.stringify(val));
                      if(!val) localStorage.removeItem('colori_ref_session_data'); // 关闭时清空数据
                  }}
              />;
          case 'settings':
              return <SettingsPanel 
                  isDark={isDark} 
                  lang={lang} setLang={setLang}
                  settings={settings} setSettings={setSettings}
                  isGrayscale={isGrayscale} setIsGrayscale={setIsGrayscale}
                  runningApps={runningApps}
                  iccProfile={iccProfile} setIccProfile={setIccProfile}
                  t={t}
              />;
          case 'color':
          default:
              return (
                <div className="h-full flex flex-col overflow-hidden">
                    {/* 上半部分：色环区域 (改为 flex-1 自适应剩余空间) */}
                    <div className="flex-1 min-h-[180px] relative shrink-0">
                        <ColorPickerArea 
                            hue={hsv.h} saturation={hsv.s} value={hsv.v} 
                            onChange={handleColorChange}
                            onUpdateCurrent={(rgb) => handleRgbChange(rgb)}
                            onCommit={commitToHistory}
                            pickerMode={pickerMode}
                            onToggleMode={() => setPickerMode(m => m === 'triangle' ? 'square' : 'triangle')}
                            colorSlots={colorSlots}
                            activeSlot={activeSlot}
                            onSlotClick={setActiveSlot}
                            lang={lang} isDark={isDark}
                            monitorPos={monitorPos} setMonitorPos={setMonitorPos}
                            monitorRgb={monitorRgb} 
                            monitorSync={monitorSync} setMonitorSync={setMonitorSync}
                            isPickingPixel={isPickingPixel} setIsPickingPixel={setIsPickingPixel}
                            leftHanded={settings.leftHanded}
                        />
                    </div>

                    {/* 调节杆 (Resizer) - 控制下方面板高度 */}
                    <div 
                        className="h-1.5 -my-0.5 cursor-row-resize z-50 flex items-center justify-center group opacity-50 hover:opacity-100"
                        onPointerDown={(e) => {
                            e.currentTarget.setPointerCapture(e.pointerId);
                            const startY = e.clientY;
                            const startH = pickerHeight; // 这里复用 pickerHeight 变量名来存储下方面板高度
                            const onMove = (ev) => {
                                // 鼠标向下拖动(dy>0) -> 下方面板变小 -> height 减小
                                const dy = ev.clientY - startY;
                                const newH = Math.max(120, startH - dy); 
                                setPickerHeight(newH);
                            };
                            const onUp = (ev) => {
                                ev.currentTarget.removeEventListener('pointermove', onMove);
                                ev.currentTarget.removeEventListener('pointerup', onUp);
                                ev.currentTarget.releasePointerCapture(ev.pointerId);
                            };
                            e.currentTarget.addEventListener('pointermove', onMove);
                            e.currentTarget.addEventListener('pointerup', onUp);
                        }}
                    >
                        {/* 视觉上的细条 */}
                        <div className="w-12 h-1 rounded-full bg-gray-400/30 group-hover:bg-blue-500/50 transition-colors" />
                    </div>

                    {/* 下半部分：面板区域 (改为受控高度) */}
                    <div 
                        style={{ height: pickerHeight, maxHeight: '80%' }} 
                        className={`shrink-0 min-h-[120px] rounded-t-[20px] p-4 flex flex-col gap-4 shadow-[0_-5px_15px_rgba(0,0,0,0.1)] border-t border-white/5 ${isDark ? 'bg-[#1e1e1e]' : 'bg-white'}`}
                    >
                        <div className="flex justify-between border-b border-gray-500/10 pb-2 shrink-0">
                            <div className="flex gap-4 text-xs font-bold">
                                {['sketch', 'scheme', 'palette'].map(k => (
                                    <button key={k} onClick={() => setSubTab(k)} className={`pb-1 uppercase transition-colors ${subTab === k ? 'text-slate-500 border-b-2 border-slate-500' : 'opacity-40 hover:opacity-100'}`}>
                                        {k === 'sketch' ? t('素描 Value', 'Value') : (k === 'scheme' ? t('配色 Scheme', 'Scheme') : t('色板 Palette', 'Palette'))}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* [修复2] 将容器改为 flex-1 + overflow-hidden，利用子容器的 class 控制显示，实现滚动记忆 */}
                        <div className="flex-1 overflow-hidden relative pr-1">
                            
                            {/* Sketch Tab */}
                            <div className={`absolute inset-0 overflow-y-auto custom-scrollbar ${subTab === 'sketch' ? 'block' : 'hidden'}`}>
                                <div className="animate-in fade-in space-y-1 pb-0 -mt-[3px]">
                                    <div className="rounded-lg border border-white/10 shadow-inner">
                                        <IsoLuminanceGraph 
                                            targetLuminance={luma} 
                                            hue={hsv.h} saturation={hsv.s} 
                                            value={hsv.v} 
                                            onPickColor={handleColorChange} 
                                            alg={settings.grayMode === 'system' ? 'rec601' : iccProfile}
                                            lang={lang}
                                            useGamma={settings.useGamma ?? true}
                                            setUseGamma={(val) => setSettings(s => ({...s, useGamma: val}))}
                                        />
                                    </div>
                                    <div className="flex justify-between items-center px-1">
                                        <span className="text-[9px] font-bold opacity-50 flex items-center gap-1 uppercase tracking-wider">
                                            <ImageIcon size={9} /> 
                                            {settings.grayMode === 'system' ? 'Rec.601 (System)' : (LUMA_ALGORITHMS[iccProfile]?.name || 'Custom')}
                                        </span>
                                        <div className="flex gap-3 font-mono text-[10px]">
                                            <span>Y: <b className="text-slate-500">{luma.toFixed(2)}</b></span>
                                            <span>Gray: <b className="text-slate-500">{Math.round(toGamma(luma)*255)}</b></span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Scheme Tab - [修复2] 开启 overflow-y-auto 实现内部独立滚动 */}
                            <div className={`absolute inset-0 overflow-y-auto custom-scrollbar p-1 ${subTab === 'scheme' ? 'block' : 'hidden'}`}>
                                <div className="animate-in fade-in space-y-2 pb-2">
                                    
                                    {/* 色彩滑块区域 */}
                                    <div className={`rounded-xl border transition-all ${isDark ? 'bg-white/5 border-white/5' : 'bg-black/5 border-black/5'}`}>
                                        <div className="flex items-center justify-between p-2 cursor-pointer select-none" onClick={() => setPanelConfig(s => ({...s, sliderCollapsed: !s.sliderCollapsed}))}>
                                            <span className="text-[10px] font-bold opacity-60 uppercase">{t('色彩滑块', 'Sliders')}</span>
                                            <span className={`text-[9px] opacity-40 transform transition-transform ${panelConfig.sliderCollapsed ? '-rotate-90' : 'rotate-0'}`}>▼</span>
                                        </div>
                                        
                                        {!panelConfig.sliderCollapsed && (
                                            <div className="px-2 pb-2">
                                                <ColorSliders 
                                                    r={rgb.r} g={rgb.g} b={rgb.b} 
                                                    onChange={handleRgbChange} 
                                                    isDark={isDark} 
                                                    mode={sliderMode} setMode={setSliderMode}
                                                    panelConfig={panelConfig} setPanelConfig={setPanelConfig}
                                                />
                                            </div>
                                        )}
                                    </div>

                                    {/* 配色方案区域 */}
                                    <div className={`rounded-xl border transition-all ${isDark ? 'bg-white/5 border-white/5' : 'bg-black/5 border-black/5'}`}>
                                        <div className="flex items-center justify-between p-2 cursor-pointer select-none" onClick={() => setPanelConfig(s => ({...s, schemeCollapsed: !s.schemeCollapsed}))}>
                                            <span className="text-[10px] font-bold opacity-60 uppercase">{t('配色方案', 'Schemes')}</span>
                                            {/* [修复3] 锁定按钮样式对齐与文字添加 */}
                                            <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                                <span className="text-[9px] opacity-50">{t('锁定基准色', 'Lock Base')}</span>
                                                <button 
                                                    onClick={() => setSchemeLockColor(schemeLockColor ? null : hsv)}
                                                    className={`
                                                        w-7 h-4 rounded-full relative transition-colors border border-transparent
                                                        ${schemeLockColor ? 'bg-blue-500' : 'bg-slate-400/30 hover:bg-slate-400/50'}
                                                    `}
                                                    title={t('锁定基准色', 'Lock Base')}
                                                >
                                                    <div className={`absolute w-3 h-3 bg-white rounded-full transition-all shadow-sm ${schemeLockColor ? 'left-[13px] top-[1px]' : 'left-0.5 top-[1px]'}`} />
                                                </button>
                                                <span className={`text-[9px] opacity-40 transform transition-transform ml-1 cursor-pointer ${panelConfig.schemeCollapsed ? '-rotate-90' : 'rotate-0'}`} onClick={() => setPanelConfig(s => ({...s, schemeCollapsed: !s.schemeCollapsed}))}>▼</span>
                                            </div>
                                        </div>

                                        {!panelConfig.schemeCollapsed && (
                                            <div className="px-1 pb-1">
                                                <div className="grid grid-cols-2 gap-2 mb-2">
                                                    {[
                                                        {id: 'complement', n: t('互补', 'Comp')},
                                                        {id: 'split', n: t('分离互补', 'Split')},
                                                        {id: 'triadic', n: t('三角', 'Tri')},
                                                        {id: 'tetradic', n: t('四角', 'Tetra')},
                                                        {id: 'analogous', n: t('近似', 'Ana')},
                                                    ].map(m => {
                                                        const harmonyColors = generateScheme(m.id);
                                                        const base = schemeLockColor || hsv;
                                                        const fullScheme = [base, ...harmonyColors];
                                                        return (
                                                            <div key={m.id} className={`p-2 rounded-lg border ${isDark?'bg-white/5 border-white/5':'bg-black/5 border-black/5'}`}>
                                                                <div className="text-[9px] opacity-50 mb-1">{m.n}</div>
                                                                <div className="flex h-4 rounded overflow-hidden">
                                                                    {fullScheme.map((c, i) => (
                                                                        <div key={i} className="flex-1 cursor-pointer hover:opacity-80 transition-opacity" 
                                                                            style={{ backgroundColor: rgbToHex(hsvToRgb(c.h,c.s,c.v).r, hsvToRgb(c.h,c.s,c.v).g, hsvToRgb(c.h,c.s,c.v).b) }}
                                                                            onClick={() => handleColorChange(c)}
                                                                        />
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                    
                                                    <div className={`p-2 rounded-lg border ${isDark?'bg-white/5 border-white/5':'bg-black/5 border-black/5'}`}>
                                                        <div className="flex justify-between items-center mb-1">
                                                            <span className="text-[9px] opacity-50">{t('相似随机', 'Similar')}</span>
                                                            <button onClick={() => setSimilarSeed(Math.random())} className="p-0.5 rounded hover:bg-white/10 text-slate-500"><RefreshCw size={10} /></button>
                                                        </div>
                                                        <div className="flex h-4 rounded overflow-hidden">
                                                            {similarScheme.map((c, i) => (
                                                                <div key={i} className="flex-1 cursor-pointer hover:opacity-80 transition-opacity" 
                                                                    style={{ backgroundColor: rgbToHex(hsvToRgb(c.h,c.s,c.v).r, hsvToRgb(c.h,c.s,c.v).g, hsvToRgb(c.h,c.s,c.v).b) }}
                                                                    onClick={() => handleColorChange(c)}
                                                                />
                                                            ))}
                                                        </div>
                                                    </div>
                                                </div>
                                                
                                                <div className={`p-2 rounded-lg border ${isDark?'bg-white/5 border-white/5':'bg-black/5 border-black/5'}`}>
                                                    <div className="flex justify-between items-center mb-1">
                                                        <span className="text-[9px] opacity-50">{t('随机灵感', 'Random Idea')}</span>
                                                        <button onClick={() => setRandomSeed(Math.random())} className="p-0.5 rounded hover:bg-white/10 text-slate-500"><RefreshCw size={10} /></button>
                                                    </div>
                                                    <div className="flex h-4 rounded overflow-hidden">
                                                        {randomScheme.map((c, i) => (
                                                            <div key={i} className="flex-1 cursor-pointer hover:opacity-80 transition-opacity" 
                                                                style={{ backgroundColor: rgbToHex(hsvToRgb(c.h,c.s,c.v).r, hsvToRgb(c.h,c.s,c.v).g, hsvToRgb(c.h,c.s,c.v).b) }}
                                                                onClick={() => handleColorChange(c)}
                                                            />
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Palette Tab */}
                            <div className={`absolute inset-0 overflow-y-auto custom-scrollbar ${subTab === 'palette' ? 'block' : 'hidden'}`}>
                                <div className="animate-in fade-in space-y-4 pt-1 px-1"> {/* 增加 px-1 防止 flex 溢出 */}
                                    <div>
                                        <div className="flex justify-between items-center mb-2">
                                            <span className="text-[10px] font-bold opacity-50 uppercase">{t('收藏', 'Saved')}</span>
                                            <button onClick={() => setSavedPalette(prev => [...prev, rgbToHex(rgb.r,rgb.g,rgb.b)])} 
                                                className="px-2 py-0.5 rounded bg-slate-500/10 border border-teal-600/30 text-slate-500 hover:bg-slate-500 hover:text-white text-[9px] transition">
                                                + ADD
                                            </button>
                                        </div>
                                        {/* [修复] 使用 Flex Wrap + 固定尺寸 (w-6 h-6)，防止随窗口拉伸 */}
                                        <div className="flex flex-wrap gap-1.5"> 
                                            {savedPalette.map((hex, i) => (
                                                <div key={i} className="w-6 h-6 rounded-sm cursor-pointer relative group hover:scale-110 transition-transform shadow-sm box-border border border-gray-400/30" style={{ background: hex }} onClick={() => { const c = hexToRgb(hex); if(c) handleRgbChange(c); }} onContextMenu={(e) => { e.preventDefault(); setSavedPalette(prev => prev.filter((_, idx) => idx !== i)); }} />
                                            ))}
                                        </div>
                                        {savedPalette.length === 0 && <div className="text-[9px] opacity-20 text-center py-2">Empty</div>}
                                    </div>
                                    <div>
                                        <div className="flex justify-between items-center mb-2">
                                            <span className="text-[10px] font-bold opacity-50 uppercase">{t('历史', 'History')}</span>
                                            {/* [修复 UI] 美化清空按钮：支持点击别处取消(onBlur) + 3秒自动恢复 */}
                                            <button 
                                                onBlur={() => setClearHistoryConfirm(false)} // [新增] 失去焦点(点击别处)时立即取消
                                                onClick={() => { 
                                                    if (clearHistoryConfirm) {
                                                        setPaletteHistory([]);
                                                        setClearHistoryConfirm(false);
                                                    } else {
                                                        setClearHistoryConfirm(true);
                                                        // 3秒后自动恢复作为兜底
                                                        setTimeout(() => setClearHistoryConfirm(false), 3000);
                                                    }
                                                }} 
                                                className={`px-2 py-0.5 rounded border text-[9px] transition font-bold ${
                                                    clearHistoryConfirm 
                                                    ? 'bg-red-500 border-red-500 text-white' 
                                                    : 'bg-slate-500/10 border-slate-500/20 text-slate-500 hover:bg-slate-500/20'
                                                }`}
                                            >
                                                {clearHistoryConfirm ? t('确定清除?', 'Confirm?') : t('清除', 'CLEAR')}
                                            </button>
                                        </div>
                                        {/* [修复] 使用 Flex Wrap + 固定尺寸 */}
                                        <div className="flex flex-wrap gap-1">
                                            {paletteHistory.map((hex, i) => (
                                                <div key={i} className="w-6 h-6 rounded-sm cursor-pointer hover:scale-110 transition-transform border border-black/5" style={{ background: hex }} onClick={() => { const c = hexToRgb(hex); if(c) handleRgbChange(c); }} title={hex} />
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
              );
      }
  };

  return (
    <div 
      className={`w-full h-full flex flex-col transition-colors duration-300 overflow-hidden ${isDark ? 'bg-[#1a1a1a] text-gray-100' : 'bg-[#f5f5f5] text-gray-900'}`}
      style={{ filter: isGrayscale ? `url(#dynamic-gray-filter)` : 'none' }}
    >
      <GlobalSvgFilters icc={iccProfile} />

      <div className={`h-screen w-screen flex flex-col overflow-hidden relative ${isDark ? 'bg-[#1f1f23]' : 'bg-white'}`}>
        
        {selectionMode && (
            <RegionSelector onConfirm={(r)=>{}} onCancel={() => setSelectionMode(null)} />
        )}

        {/* 宏调试提示层 - 当有步骤时显示 */}
        {macroStep && (
            <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[9999] bg-red-600 text-white px-6 py-3 rounded-lg shadow-2xl animate-pulse flex flex-col items-center">
                <span className="text-xs font-bold opacity-80 uppercase">Macro Debug Paused</span>
                <span className="text-lg font-bold">{macroStep}</span>
                <span className="text-[10px] mt-1 bg-black/20 px-2 py-0.5 rounded">Press SPACE to Continue</span>
            </div>
        )}

        {/* 缩放提示 (右上角, 点击还原) */}
        {showZoomTip && (
            <div 
                className="fixed top-16 right-4 z-[9999] bg-black/80 text-white px-3 py-1.5 rounded-lg shadow-xl text-xs font-mono cursor-pointer hover:bg-blue-600 transition-colors pointer-events-auto backdrop-blur animate-in fade-in slide-in-from-top-2"
                onClick={() => {
                    setUiZoom(1);
                    localStorage.setItem('colori_ui_zoom', 1);
                    setShowZoomTip(false);
                }}
            >
                Zoom: {Math.round(uiZoom * 100)}% (Reset)
            </div>
        )}

        {/* --- 顶部标题栏 --- */}
        <div className="h-14 shrink-0 flex items-center justify-between px-3 border-b border-gray-500/10 drag-region select-none z-50 bg-inherit" style={{ zoom: uiZoom }}>
           <div className="flex items-center gap-2 pointer-events-none">
              <div className="w-6 h-6 bg-gradient-to-tr from-blue-500 to-purple-500 rounded-lg flex items-center justify-center text-white shadow-lg">
                  <Palette size={14} />
              </div>
              <span className="font-sans text-sm font-bold tracking-wide opacity-90">
                {monitorPos ? 
                    <span className="text-green-400 text-xs flex items-center gap-1"><Eye size={10}/> RUN ({monitorPos.x},{monitorPos.y})</span> :
                    (isPickingPixel ? <span className="text-slate-400 animate-pulse">{t("请点击屏幕选点...", "Click anywhere to lock")}</span> : "COLORI")
                }
              </span>
           </div>

           <div className="flex flex-col items-end justify-center gap-0.5 no-drag">
               <div className="flex items-center gap-2">
                   <button onClick={() => setSettings(s => ({...s, topmost: !s.topmost}))} className={`p-1 rounded transition hover:bg-black/5 dark:hover:bg-white/10 ${settings.topmost ? 'text-slate-500' : 'opacity-40 hover:opacity-100'}`} title={t("置顶", "Pin Top")}>
                       <Pin size={12} className={settings.topmost ? "fill-current" : ""}/>
                    </button>
                   <button onClick={() => appWindow.minimize()} className="p-1 opacity-40 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 rounded transition"><Minimize2 size={12}/></button>
                   <button onClick={() => appWindow.hide()} className="p-1 opacity-40 hover:opacity-100 hover:bg-red-500 hover:text-white rounded transition"><X size={12}/></button>
               </div>

               <div className="flex items-center gap-2 pr-0.5">
                   <button
                      onClick={(e) => {
                          if (window._grayToggleTimeout) return;
                          window._grayToggleTimeout = setTimeout(() => window._grayToggleTimeout = null, 500);
                          
                          // 记录操作时间，锁定轮询
                          lastGrayToggleRef.current = Date.now();

                          if (settings.grayMode === 'system') {
                              invoke('set_fullscreen_grayscale', { enable: false }); 
                              invoke('trigger_system_grayscale');
                              // 乐观更新 UI
                              setIsGrayscale(prev => !prev);
                          } else {
                              setIsGrayscale(prev => !prev);
                          }
                      }}
                      onContextMenu={(e) => {
                          if (settings.grayMode === 'system') {
                              e.preventDefault();
                              invoke('open_color_filter_settings');
                          }
                      }}
                      className={`flex items-center gap-1 text-[9px] transition ${isGrayscale ? 'text-slate-400 font-bold' : 'opacity-40 hover:opacity-100'}`}
                      title={settings.grayMode === 'system' ? t("左键: 触发Win+Ctrl+C | 右键: 系统设置", "L-Click: System Hotkey | R-Click: Settings") : t("开启/关闭 应用内灰度滤镜", "Toggle App Grayscale Filter")}
                   >
                     <Layers size={10}/> {settings.grayMode === 'system' ? (isGrayscale ? 'SYS' : 'OFF') : (isGrayscale ? 'APP' : 'OFF')}
                   </button>
                   <div className="w-[1px] h-2 bg-current opacity-20"></div>
                   <button onClick={() => setIsDark(!isDark)} className="opacity-40 hover:opacity-100 transition" title={t("切换深色/浅色模式", "Toggle Theme")}>
                     {isDark ? <Sun size={10} /> : <Moon size={10} />}
                   </button>
               </div>
           </div>
        </div>

        {/* --- 主要内容区域 --- */}
        {/* [修复2] 根据 Tab 类型决定滚动策略：Color/Screen 内部自理，其他(Settings/Ref)由父容器滚动 */}
        {/* [需求] 应用 zoom 样式实现缩放，但保留 flex 布局结构 */}
        <div 
            className={`flex-1 min-h-0 relative ${['settings', 'push'].includes(activeTab) ? 'overflow-y-auto custom-scrollbar' : 'overflow-hidden'}`}
            style={{ zoom: uiZoom }} // 应用缩放
        >
           {renderActiveTabContent()}
        </div>

        {/* --- 底部导航栏 --- */}
        <div className={`h-14 shrink-0 border-t border-white/5 backdrop-blur-xl flex justify-around items-center z-[100] ${isDark ? 'bg-[#1f1f23]/95' : 'bg-[#f5f5f5]/95'}`} style={{ zoom: uiZoom }}>
            {[
                {id: 'color', icon: Pipette, l: t('调色', 'Color')},
                {id: 'screen', icon: Monitor, l: t('屏幕', 'Screen')},
                {id: 'push', icon: ImageIcon, l: t('参考', 'Ref')},
                {id: 'settings', icon: Sliders, l: t('设置', 'Set')}
            ].map(tab => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex flex-col items-center gap-0.5 p-2 rounded-xl transition-all ${activeTab===tab.id ? 'text-blue-500 font-bold scale-105' : 'opacity-40'}`}>
                    <tab.icon size={18} />
                    <span className="text-[9px] font-medium">{tab.l}</span>
                </button>
            ))}
        </div>
        
        {/* [修复] 已移除底部自定义调整手柄，解决阻挡原生把手的问题 */}
      </div>
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 10px; }
        .drag-region { -webkit-app-region: drag; }
        .no-drag, .no-drag button, .drag-region button { -webkit-app-region: no-drag; }
      `}</style>
    </div>
  );
}