import React, { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTauriBackend } from './hooks/useTauriBackend';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, listen } from '@tauri-apps/api/event';
import { Palette, Sun, Moon, Minimize2, X, Pin, Eye, Layers, Pipette, Monitor, Image as ImageIcon, Sliders, RefreshCw } from 'lucide-react';

import { LUMA_ALGORITHMS, getLuminance, toGamma, rgbToHsv, hsvToRgb, rgbToHex, hexToRgb } from './colorLogic';
import { GlobalSvgFilters, ColorPickerArea, IsoLuminanceGraph, ColorSliders, RegionSelector, ScreenPanel } from './MyComponents';
import { MonitorWindow, SelectorWindow, ReferenceWindow } from './MyWindows';
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

  // --- 基础 Hooks 和 状态 ---
  // 主窗口关闭事件监听
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
          console.log('[Probe] Drop Event:', event);
          
          if (event.payload && event.payload.length > 0) {
              console.log('[Probe] File Paths:', event.payload);
              const filePath = event.payload[0];
              const label = `ref-file-${Date.now()}`;
              localStorage.setItem('ref-temp-path', filePath); 
              // 尝试创建窗口
              try {
                  const win = new WebviewWindow(label, {
                      url: 'index.html',
                      width: 300, height: 300,
                      decorations: false, transparent: true, alwaysOnTop: true
                  });
                  console.log('[Probe] Window creating:', label);
              } catch (e) {
                  console.error('[Probe] Window creation failed:', e);
              }
          } else {
              console.warn('[Probe] Drop payload is empty!');
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
      hotkeySyncEnabled: false, 
      hotkeySyncApp: '', 
      hotkeySyncKey: 'Shift+F12', // 默认触发键
      hotkeySyncPickKey: 'Shift+I', // 默认取色键
      aiFilter: true, feedTags: '高级感', topmost: false, grayMode: 'custom'
  }));
  const [runningApps, setRunningApps] = useState([]); 
  const [monitorPos, setMonitorPos] = useState(null); 
  // [Issue 2] 独立的监控色状态，不干扰主色槽
  const [monitorRgb, setMonitorRgb] = useState({ r:0, g:0, b:0 });
  const [isPickingPixel, setIsPickingPixel] = useState(false);
  const [macroStep, setMacroStep] = useState(null); // 新增：宏调试步骤状态
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
  useEffect(() => localStorage.setItem('colori_slots', JSON.stringify(colorSlots)), [colorSlots]);
  useEffect(() => localStorage.setItem('colori_active_slot', activeSlot), [activeSlot]);
  useEffect(() => localStorage.setItem('colori_theme', JSON.stringify(isDark)), [isDark]);
  useEffect(() => localStorage.setItem('colori_lang', JSON.stringify(lang)), [lang]);
  
  useEffect(() => {
      const updatedSettings = { ...settings, iccProfile };
      localStorage.setItem('colori_settings', JSON.stringify(updatedSettings));
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
      
      console.log("[App] Updating Global Hotkeys:", {
          gray: settings.hotkeyGray, 
          pick: settings.hotkeyPick, 
          moni: settings.hotkeyMonitor, 
          flags
      });

      invoke('update_extra_hotkeys', { 
          gray: settings.hotkeyGray||"", pick: settings.hotkeyPick||"", moni: settings.hotkeyMonitor||"", 
          flags 
      }).catch(err => console.error("Failed to update hotkeys", err));
      
  }, [settings]); // 依赖保持 settings

  // 监听后端发来的全局热键事件 & 宏调试事件
  useEffect(() => {
      // 监听宏步进
      const unlistenMacro = listen('macro-debug-step', (e) => {
          if (e.payload === 'DONE') setMacroStep(null);
          else setMacroStep(e.payload);
      });

      const unlisten = listen('global-hotkey', async (e) => {
          if (e.payload === 'gray') {
              // [修复] 更新时间锁，防止轮询器在系统响应前覆盖状态
              lastGrayToggleRef.current = Date.now();
              
              if (settings.grayMode === 'system') {
                  invoke('trigger_system_grayscale');
                  setIsGrayscale(p => !p);
              } else setIsGrayscale(p => !p);
          }
          if (e.payload === 'pick') {
              // 修复: 即使最小化也要先还原并置顶，否则 EyeDropper 会报错
              if (await appWindow.isMinimized()) await appWindow.unminimize();
              await appWindow.show();
              await appWindow.setFocus();
              
              if (window.EyeDropper && !window._isPicking) {
                  window._isPicking = true;
                  try { 
                      const res = await new window.EyeDropper().open(); 
                      const c = hexToRgb(res.sRGBHex); 
                      if(c) {
                          // 需要手动更新 state，因为这是异步事件
                          setColorSlots(prev => {
                              const next = [...prev]; next[activeSlot] = c; if(activeSlot!==0) next[0]=c; return next;
                          });
                      }
                  } catch(err) {}
                  window._isPicking = false;
              }
          }
          if (e.payload === 'monitor') {
              await appWindow.setFocus();
              setIsPickingPixel(true);
          }
      });
      return () => { unlisten.then(f=>f()); };
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
                  // [Issue 2] 仅更新监控色状态，不更新当前选色
                  setMonitorRgb({ r, g, b });
              } catch (e) {}
          }, 100); // 优化: 降低轮询频率至 100ms (10FPS) 以节省 CPU
      }
      return () => clearInterval(interval);
  }, [monitorPos]);

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

  useEffect(() => {
      const unlisten = listen('region-selected', async (event) => {
          const rect = event.payload;
          if (rect.purpose === 'screenshot') {
             try {
                await new Promise(r => setTimeout(r, 200)); 
                setTimeout(async () => {
                    const dataUrl = await invoke('capture_region', { 
                        x: Math.round(rect.x), y: Math.round(rect.y), 
                        w: Math.round(rect.w), h: Math.round(rect.h) 
                    });
                    localStorage.setItem('ref-temp-img', dataUrl);
                    new WebviewWindow(`ref-${Date.now()}`, {
                        url: 'index.html', title: 'Ref',
                        x: Math.round(rect.x), y: Math.round(rect.y), 
                        width: Math.round(rect.w), height: Math.round(rect.h),
                        decorations: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: true
                    });
                }, 200);
             } catch(e) { console.error(e); }
          }
      });
      return () => { unlisten.then(f => f()); };
  }, []);

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
              return <RefPanel isDark={isDark} t={t} refIgnoreMouse={refIgnoreMouse} setRefIgnoreMouse={setRefIgnoreMouse} />;
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
              // 调色板内容较多，保持在这里
              return (
                <div className="min-h-full flex flex-col">
                    <div className="pt-2 px-2">
                        <ColorPickerArea 
                            hue={hsv.h} saturation={hsv.s} value={hsv.v} 
                            onChange={handleColorChange}
                            onUpdateCurrent={(rgb) => handleRgbChange(rgb)} // 允许监控槽反向同步
                            onCommit={commitToHistory}
                            pickerMode={pickerMode}
                            onToggleMode={() => setPickerMode(m => m === 'triangle' ? 'square' : 'triangle')}
                            colorSlots={colorSlots}
                            activeSlot={activeSlot}
                            onSlotClick={setActiveSlot}
                            lang={lang} isDark={isDark}
                            monitorPos={monitorPos} setMonitorPos={setMonitorPos}
                            monitorRgb={monitorRgb} // 传入监控色
                            isPickingPixel={isPickingPixel} setIsPickingPixel={setIsPickingPixel}
                        />
                    </div>

                    {/* 下半面板位置下移 */}
                    <div className={`flex-1 min-h-0 mt-[3px] rounded-t-[24px] p-4 flex flex-col gap-4 shadow-[0_-5px_15px_rgba(0,0,0,0.1)] ${isDark ? 'bg-[#1e1e1e]' : 'bg-white'}`}>
                        <div className="flex justify-between border-b border-gray-500/10 pb-2 shrink-0">
                            <div className="flex gap-4 text-xs font-bold">
                                {['sketch', 'scheme', 'palette'].map(k => (
                                    <button key={k} onClick={() => setSubTab(k)} className={`pb-1 uppercase transition-colors ${subTab === k ? 'text-slate-500 border-b-2 border-slate-500' : 'opacity-40 hover:opacity-100'}`}>
                                        {k === 'sketch' ? t('素描 Value', 'Value') : (k === 'scheme' ? t('配色 Scheme', 'Scheme') : t('色板 Palette', 'Palette'))}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto custom-scrollbar relative pr-1">
                            {subTab === 'sketch' && (
                                /* 微调: -mt-[3px] 将素描图表向上移动约 3px */
                                <div className="animate-in fade-in space-y-1 pb-0 overflow-hidden -mt-[3px]">
                                    <div className="rounded-lg overflow-hidden border border-white/10 shadow-inner">
                                        <IsoLuminanceGraph targetLuminance={luma} hue={hsv.h} saturation={hsv.s} onPickColor={handleColorChange} alg={iccProfile} />
                                    </div>
                                    <div className="flex justify-between items-center px-1">
                                        <span className="text-[9px] font-bold opacity-50 flex items-center gap-1 uppercase tracking-wider"><ImageIcon size={9} /> Rec.601 Luma</span>
                                        <div className="flex gap-3 font-mono text-[10px]">
                                            <span>Y: <b className="text-slate-500">{luma.toFixed(2)}</b></span>
                                            <span>Gray: <b className="text-slate-500">{Math.round(toGamma(luma)*255)}</b></span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {subTab === 'scheme' && (
                                <div className="animate-in fade-in space-y-2 pb-2 h-full flex flex-col">
                                    <div className="shrink-0">
                                        <ColorSliders 
                                            r={rgb.r} g={rgb.g} b={rgb.b} 
                                            onChange={handleRgbChange} 
                                            isDark={isDark} 
                                            mode={sliderMode} setMode={setSliderMode} // 传递 props
                                        />
                                    </div>
                                    <div className="flex justify-end px-1">
                                        <button 
                                            onClick={() => setSchemeLockColor(schemeLockColor ? null : hsv)}
                                            className={`
                                                flex items-center gap-2 px-2 py-1 rounded-full text-[10px] transition-all border
                                                ${schemeLockColor 
                                                    ? 'bg-blue-500/10 text-blue-500 border-blue-500/30' 
                                                    : 'bg-transparent text-slate-500 border-transparent hover:bg-slate-500/5'
                                                }
                                            `}
                                        >
                                            <span className="opacity-70">{t('锁定基准色', 'Lock Base')}</span>
                                            <div className={`w-6 h-3 rounded-full relative transition-colors ${schemeLockColor ? 'bg-blue-500' : 'bg-slate-300'}`}>
                                                <div className={`absolute top-0.5 w-2 h-2 bg-white rounded-full transition-transform shadow-sm ${schemeLockColor ? 'left-3.5' : 'left-0.5'}`} />
                                            </div>
                                        </button>
                                    </div>
                                    <div className="flex-1 overflow-y-auto custom-scrollbar p-1">
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
                                                                <div key={i} className="flex-1 cursor-pointer" 
                                                                    style={{ backgroundColor: rgbToHex(hsvToRgb(c.h,c.s,c.v).r, hsvToRgb(c.h,c.s,c.v).g, hsvToRgb(c.h,c.s,c.v).b) }}
                                                                    onClick={() => handleColorChange(c)}
                                                                />
                                                            ))}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                            {/* 布局修改: 相似随机放在 近似(Ana) 的右边，即作为 grid 的最后一个元素 */}
                                            <div className={`p-2 rounded-lg border ${isDark?'bg-white/5 border-white/5':'bg-black/5 border-black/5'}`}>
                                                <div className="flex justify-between items-center mb-1">
                                                    <span className="text-[9px] opacity-50">{t('相似随机', 'Similar')}</span>
                                                    <button onClick={() => setSimilarSeed(Math.random())} className="p-0.5 rounded hover:bg-white/10 text-slate-500"><RefreshCw size={10} /></button>
                                                </div>
                                                <div className="flex h-4 rounded overflow-hidden">
                                                    {similarScheme.map((c, i) => (
                                                        <div key={i} className="flex-1 cursor-pointer" 
                                                            style={{ backgroundColor: rgbToHex(hsvToRgb(c.h,c.s,c.v).r, hsvToRgb(c.h,c.s,c.v).g, hsvToRgb(c.h,c.s,c.v).b) }}
                                                            onClick={() => handleColorChange(c)}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                        {/* 完全随机 独占一行 */}
                                        <div className={`p-2 rounded-lg border ${isDark?'bg-white/5 border-white/5':'bg-black/5 border-black/5'}`}>
                                            <div className="flex justify-between items-center mb-1">
                                                <span className="text-[9px] opacity-50">{t('随机灵感', 'Random Idea')}</span>
                                                <button onClick={() => setRandomSeed(Math.random())} className="p-0.5 rounded hover:bg-white/10 text-slate-500"><RefreshCw size={10} /></button>
                                            </div>
                                            <div className="flex h-4 rounded overflow-hidden">
                                                {randomScheme.map((c, i) => (
                                                    <div key={i} className="flex-1 cursor-pointer" 
                                                        style={{ backgroundColor: rgbToHex(hsvToRgb(c.h,c.s,c.v).r, hsvToRgb(c.h,c.s,c.v).g, hsvToRgb(c.h,c.s,c.v).b) }}
                                                        onClick={() => handleColorChange(c)}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {subTab === 'palette' && (
                                <div className="animate-in fade-in space-y-4">
                                    <div>
                                        <div className="flex justify-between items-center mb-2">
                                            <span className="text-[10px] font-bold opacity-50 uppercase">{t('收藏', 'Saved')}</span>
                                            <button onClick={() => setSavedPalette(prev => [...prev, rgbToHex(rgb.r,rgb.g,rgb.b)])} 
                                                className="px-2 py-0.5 rounded bg-slate-500/10 border border-teal-600/30 text-slate-500 hover:bg-slate-500 hover:text-white text-[9px] transition">
                                                + ADD
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-8 gap-1.5"> 
                                            {savedPalette.map((hex, i) => (
                                                <div key={i} className="aspect-square rounded-sm cursor-pointer relative group hover:scale-110 transition-transform shadow-sm box-border border border-gray-400/30" style={{ background: hex }} onClick={() => { const c = hexToRgb(hex); if(c) handleRgbChange(c); }} onContextMenu={(e) => { e.preventDefault(); setSavedPalette(prev => prev.filter((_, idx) => idx !== i)); }} />
                                            ))}
                                        </div>
                                        {savedPalette.length === 0 && <div className="text-[9px] opacity-20 text-center py-2">Empty</div>}
                                    </div>
                                    <div>
                                        <div className="text-[10px] font-bold opacity-50 uppercase mb-2">{t('历史', 'History')}</div>
                                        <div className="grid grid-cols-8 gap-1">
                                            {paletteHistory.map((hex, i) => (
                                                <div key={i} className="aspect-square rounded-sm cursor-pointer hover:scale-110 transition-transform" style={{ background: hex }} onClick={() => { const c = hexToRgb(hex); if(c) handleRgbChange(c); }} title={hex} />
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
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

        {/* --- 顶部标题栏 --- */}
        <div className="h-14 shrink-0 flex items-center justify-between px-3 border-b border-gray-500/10 drag-region select-none z-50 bg-inherit">
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
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar relative [scrollbar-gutter:stable]">
           {renderActiveTabContent()}
        </div>

        {/* --- 底部导航栏 --- */}
        <div className={`h-14 shrink-0 border-t border-white/5 backdrop-blur-xl flex justify-around items-center z-[100] ${isDark ? 'bg-[#1f1f23]/95' : 'bg-[#f5f5f5]/95'}`}>
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
        
        {/* 底部调整高度手柄 */}
        <div 
            className="h-1.5 w-full cursor-ns-resize z-[200] hover:bg-slate-500/20 transition-colors absolute bottom-0 left-0"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); appWindow.startResizeDragging(2); }}
        />
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