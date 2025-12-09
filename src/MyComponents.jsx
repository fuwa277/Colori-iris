import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';
import { Triangle, Grid, Copy, Eye, Pipette, Image as ImageIcon, Maximize2, Minimize2, Layers, Monitor, Crop, X, RefreshCw, AlertCircle, Link, Check, ChevronDown } from 'lucide-react';
import { 
    LUMA_ALGORITHMS, getLuminance, hsvToRgb, rgbToHex, hexToRgb, rgbToHsv, 
    toGamma, rgbToCmyk, cmykToRgb, rgbToLab, culoriRgb, culoriCmyk 
} from './colorLogic';

const appWindow = getCurrentWindow();

// --- 组件: 快捷键录制器 ---
export const HotkeyRecorder = ({ value, onChange, placeholder, isDark, uniqueKey, activeRecorder, onActivate }) => {
    // 状态受控：判断当前组件是否处于录制状态
    const recording = activeRecorder === uniqueKey;

    // [新增] 封装开始录制逻辑
    const startRecording = (e) => {
        e.stopPropagation(); // 防止冒泡
        if (onActivate) onActivate(uniqueKey); // 通知父组件激活当前ID
        // 通知后端：开始录制，暂停宏触发
        invoke('set_hotkey_recording_status', { isRecording: true }).catch(console.error);
    };

    // [新增] 封装结束录制逻辑
    const stopRecording = (newValue) => {
        if (onActivate) onActivate(null); // 通知父组件取消激活
        onChange(newValue);
        // 延时恢复：给用户一点时间松开按键，防止松手慢了触发宏
        setTimeout(() => {
            invoke('set_hotkey_recording_status', { isRecording: false }).catch(console.error);
        }, 500); 
    };

    const handleKeyDown = (e) => {
        if (!recording) return;
        e.preventDefault(); e.stopPropagation();
        const keys = [];
        if (e.metaKey) keys.push('Win'); 
        if (e.ctrlKey) keys.push('Ctrl');
        if (e.shiftKey) keys.push('Shift');
        if (e.altKey) keys.push('Alt');
        
        // 获取原始 Code 用于判断位置
        const code = e.code;
        let keyLabel = e.key.toUpperCase();

        // [修复] 添加 NUMLOCK 到忽略列表
        const ignore = ['CONTROL','SHIFT','ALT','META', 'NUMLOCK'];
        if (ignore.includes(keyLabel)) return; 
        
        if (keyLabel === 'ESCAPE' || keyLabel === 'DELETE' || keyLabel === 'BACKSPACE') {
            stopRecording(''); 
            return;
        }

        // --- 增强按键映射逻辑 ---
        // 1. 处理小键盘 (Location 3)
        if (e.location === 3) {
            const numMap = {
                'Numpad0': 'NUM0', 'Numpad1': 'NUM1', 'Numpad2': 'NUM2', 
                'Numpad3': 'NUM3', 'Numpad4': 'NUM4', 'Numpad5': 'NUM5',
                'Numpad6': 'NUM6', 'Numpad7': 'NUM7', 'Numpad8': 'NUM8', 'Numpad9': 'NUM9',
                'NumpadAdd': 'NUM+', 'NumpadSubtract': 'NUM-', 'NumpadMultiply': 'NUM*', 
                'NumpadDivide': 'NUM/', 'NumpadDecimal': 'NUM.', 'NumpadEnter': 'ENTER'
            };
            if (numMap[code]) keyLabel = numMap[code];
        } else {
            // 2. 处理主键盘符号 (解决 - = [ ] 等符号识别问题)
            // 使用 code 映射可以避免输入法影响，且方便后端统一处理
            const symbolMap = {
                'Minus': '-', 'Equal': '=', 
                'BracketLeft': '[', 'BracketRight': ']', 
                'Backslash': '\\', 'Semicolon': ';', 
                'Quote': "'", 'Comma': ',', 'Period': '.', 'Slash': '/', 'Grave': '`'
            };
            
            if (symbolMap[code]) {
                keyLabel = symbolMap[code];
            } else {
                // 常规映射
                const map = { ' ': 'SPACE', 'ARROWUP': '↑', 'ARROWDOWN': '↓', 'ARROWLEFT': '←', 'ARROWRIGHT': '→' };
                keyLabel = map[keyLabel] || keyLabel;
            }
        }

        keys.push(keyLabel);
        
        stopRecording(keys.join('+')); 
    };

    // 右键清除
    const handleContextMenu = (e) => {
        e.preventDefault();
        // 修复：右键同时也需要取消录制状态，否则会一直卡在红色录制态
        if (onActivate) onActivate(null);
        invoke('set_hotkey_recording_status', { isRecording: false }).catch(()=>{});
        onChange('');
    };

    // 显示逻辑修正: 如果 value 是空字符串，显示 'Disabled'
    const displayValue = value === '' ? 'Disabled' : (value || placeholder || 'None');

    return (
        <button 
            onClick={startRecording} 
            onKeyDown={handleKeyDown}
            onContextMenu={handleContextMenu}
            className={`
                h-7 px-3 min-w-[80px] text-[10px] font-bold font-mono rounded-md border transition-all flex items-center justify-center shadow-sm
                ${recording 
                    ? 'bg-red-500 border-red-600 text-white animate-pulse' 
                    : (isDark 
                        ? 'bg-[#2a2a2a] border-white/10 text-gray-300 hover:border-white/30' 
                        : 'bg-white border-gray-200 text-gray-600 hover:border-blue-400')
                }
            `}
        >
            {recording ? '按键...' : displayValue}
        </button>
    );
};

// --- 公共资源：SVG 滤镜定义 ---
export const GlobalSvgFilters = ({ icc = 'rec601' }) => {
    const coeffs = LUMA_ALGORITHMS[icc] || LUMA_ALGORITHMS['rec601'];
    return (
    <svg className="hidden">
        <defs>
            <filter id="dynamic-gray-filter">
                <feComponentTransfer>
                    <feFuncR type="gamma" amplitude="1" exponent="2.2" offset="0"/>
                    <feFuncG type="gamma" amplitude="1" exponent="2.2" offset="0"/>
                    <feFuncB type="gamma" amplitude="1" exponent="2.2" offset="0"/>
                </feComponentTransfer>
                <feColorMatrix type="matrix" values={`${coeffs.r} ${coeffs.g} ${coeffs.b} 0 0  ${coeffs.r} ${coeffs.g} ${coeffs.b} 0 0  ${coeffs.r} ${coeffs.g} ${coeffs.b} 0 0  0 0 0 1 0`} />
                <feComponentTransfer>
                    <feFuncR type="gamma" amplitude="1" exponent="0.4545" offset="0"/>
                    <feFuncG type="gamma" amplitude="1" exponent="0.4545" offset="0"/>
                    <feFuncB type="gamma" amplitude="1" exponent="0.4545" offset="0"/>
                </feComponentTransfer>
            </filter>
        </defs>
    </svg>
    );
};

// --- 色轮组件 ---
export const ColorPickerArea = ({ hue, saturation, value, onChange, onUpdateCurrent, onCommit, pickerMode, onToggleMode, colorSlots, activeSlot, onSlotClick, lang, isDark, monitorPos, setMonitorPos, monitorRgb, monitorSync, setMonitorSync, isPickingPixel, setIsPickingPixel }) => {
  const canvasRef = useRef(null);
  const [isDraggingRing, setIsDraggingRing] = useState(false);
  const [isDraggingShape, setIsDraggingShape] = useState(false);
  // [修复] 添加 rAF 引用，用于数位板高频事件节流
  const rAfRef = useRef(null); 
  const t = (zh, en) => lang === 'zh' ? zh : en;

  const size = 170; 
  const center = size / 2;
  const outerRadius = size / 2 - 2;
  const innerRadius = outerRadius - 12; 
  const shapeRadius = innerRadius - 8;
  const rotationOffset = -150 * (Math.PI / 180);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, size, size);
    for (let i = 0; i < 360; i++) {
      const rad = (i * Math.PI / 180) + rotationOffset;
      const nextRad = ((i + 1.5) * Math.PI / 180) + rotationOffset;
      ctx.beginPath();
      ctx.arc(center, center, (outerRadius + innerRadius) / 2, rad, nextRad);
      ctx.lineWidth = outerRadius - innerRadius;
      ctx.strokeStyle = `hsl(${i}, 100%, 50%)`;
      ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    let vHue, vWhite, vBlack;
    if (pickerMode === 'triangle') {
        vHue = { x: center + shapeRadius, y: center };
        vWhite = { x: center - shapeRadius * 0.5, y: center - shapeRadius * 0.866 };
        vBlack = { x: center - shapeRadius * 0.5, y: center + shapeRadius * 0.866 };
        ctx.moveTo(vHue.x, vHue.y); ctx.lineTo(vWhite.x, vWhite.y); ctx.lineTo(vBlack.x, vBlack.y); ctx.closePath();
    } else {
        const boxSize = shapeRadius * 1.4; const half = boxSize / 2;
        vWhite = { x: center - half, y: center - half }; vHue = { x: center + half, y: center - half };
        vBlack = { x: center - half, y: center + half };
        ctx.rect(vWhite.x, vWhite.y, boxSize, boxSize);
    }
    ctx.clip();
    if (pickerMode === 'triangle') {
        ctx.fillStyle = `hsl(${hue}, 100%, 50%)`; ctx.fill();
        const gWhite = ctx.createLinearGradient(vWhite.x, vWhite.y, (vHue.x + vBlack.x)/2, (vHue.y + vBlack.y)/2);
        gWhite.addColorStop(0, 'white'); gWhite.addColorStop(1, 'transparent'); ctx.fillStyle = gWhite; ctx.fill();
        const gBlack = ctx.createLinearGradient(vBlack.x, vBlack.y, (vHue.x + vWhite.x)/2, (vHue.y + vWhite.y)/2);
        gBlack.addColorStop(0, 'black'); gBlack.addColorStop(1, 'transparent'); ctx.fillStyle = gBlack; ctx.fill();
    } else {
        const gHorz = ctx.createLinearGradient(vWhite.x, 0, vHue.x, 0);
        gHorz.addColorStop(0, 'white'); gHorz.addColorStop(1, `hsl(${hue}, 100%, 50%)`); ctx.fillStyle = gHorz; ctx.fillRect(0,0,size,size);
        const gVert = ctx.createLinearGradient(0, vWhite.y, 0, vBlack.y);
        gVert.addColorStop(0, 'transparent'); gVert.addColorStop(1, 'black'); ctx.fillStyle = gVert; ctx.fillRect(0,0,size,size);
    }
    ctx.restore();
    const hueRad = (hue * Math.PI / 180) + rotationOffset;
    const hueX = center + ((outerRadius + innerRadius)/2) * Math.cos(hueRad);
    const hueY = center + ((outerRadius + innerRadius)/2) * Math.sin(hueRad);
    ctx.beginPath(); ctx.arc(hueX, hueY, 4, 0, 2 * Math.PI);
    ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();
    let pX, pY; const S = saturation / 100; const V = value / 100;
    if (pickerMode === 'triangle') {
        const tipX = center + shapeRadius;
        const tipY = center; 
        const backX = center - shapeRadius * 0.5;
        const topY = center - shapeRadius * 0.866; const botY = center + shapeRadius * 0.866;
        const topEdgeX = (backX) + (tipX - backX) * S; const topEdgeY = (topY) + (tipY - topY) * S;
        pX = backX + (topEdgeX - backX) * V; pY = botY + (topEdgeY - botY) * V;
    } else {
        const boxSize = shapeRadius * 1.4; const startX = center - boxSize/2; const startY = center - boxSize/2;
        pX = startX + S * boxSize; pY = startY + (1 - V) * boxSize;
    }
    ctx.beginPath(); ctx.arc(pX, pY, 5, 0, 2 * Math.PI);
    ctx.strokeStyle = V > 0.5 ? 'black' : 'white'; ctx.lineWidth = 2; ctx.stroke(); ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${value}%)`; ctx.fill();
  }, [hue, saturation, value, pickerMode]);

  const handleInteraction = (e) => {
    // [性能优化] 极速节流：如果已有挂起的帧，直接返回，不读取任何事件属性
    // 这对数位板（高回报率设备）至关重要，防止主线程被事件洪水淹没
    if (rAfRef.current) return;

    // 仅在未节流时读取坐标
    const clientX = e.clientX;
    const clientY = e.clientY;

    rAfRef.current = requestAnimationFrame(() => {
        rAfRef.current = null; // 重置锁

        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width; const scaleY = canvas.height / rect.height;
        const x = (clientX - rect.left) * scaleX; const y = (clientY - rect.top) * scaleY;
        const dist = Math.sqrt((x - center)**2 + (y - center)**2);
        
        // 注意：这里移除了对 e.buttons 的判断，因为在 rAF 中访问不到，且外层 pointermove 已隐含
        if (!isDraggingRing && !isDraggingShape && dist > size/2) return;

        if (!isDraggingShape && (isDraggingRing || (dist > innerRadius && dist < outerRadius + 5))) {
          setIsDraggingRing(true);
          let angle = Math.atan2(y - center, x - center) - rotationOffset;
          let newHue = (angle * 180 / Math.PI + 360) % 360;
          onChange({ h: newHue });
        } else if (!isDraggingRing) {
          setIsDraggingShape(true);
          let newS, newV;
          if (pickerMode === 'triangle') {
              const tipX = center + shapeRadius; const backX = center - shapeRadius * 0.5;
              const topY = center - shapeRadius * 0.866; const botY = center + shapeRadius * 0.866;
              const vHue = {x:tipX, y:center}, vWhite={x:backX, y:topY}, vBlack={x:backX, y:botY};
              const denom = (vWhite.y - vBlack.y) * (vHue.x - vBlack.x) + (vBlack.x - vWhite.x) * (vHue.y - vBlack.y);
              const wHue = ((vWhite.y - vBlack.y) * (x - vBlack.x) + (vBlack.x - vWhite.x) * (y - vBlack.y)) / denom;
              const wBlack = 1 - wHue - ((vBlack.y - vHue.y) * (x - vBlack.x) + (vHue.x - vBlack.x) * (y - vBlack.y)) / denom;
              newV = 1 - wBlack; newS = newV > 0.001 ? wHue / newV : 0;
          } else {
              const boxSize = shapeRadius * 1.4; const startX = center - boxSize/2; const startY = center - boxSize/2;
              newS = (x - startX) / boxSize; newV = 1 - ((y - startY) / boxSize);
          }
          onChange({ s: Math.max(0, Math.min(100, newS * 100)), v: Math.max(0, Math.min(100, newV * 100)) });
        }
    });
  };
  const stopDrag = () => { 
      // [修复] 停止时取消挂起的动画帧，防止松手后的滞后帧重新激活拖拽状态
      if (rAfRef.current) { cancelAnimationFrame(rAfRef.current); rAfRef.current = null; }
      setIsDraggingRing(false); setIsDraggingShape(false); 
  };

  return (
    <div className="flex flex-col w-full select-none h-[210px] relative pt-1">
        {/* 色轮区域 */}
        <div className="flex items-start justify-center touch-none relative h-[200px] -mt-2">
            {/* 问题2: 按钮放大 padding p-2 */}
            <button onClick={onToggleMode} 
                className={`absolute top-[8px] left-4 p-2 rounded-md border shadow-sm transition-all z-20
                ${isDark 
                    ? 'bg-[#2a2a2a] border-white/10 text-gray-400 hover:text-slate-300 hover:border-slate-500/50' 
                    : 'bg-white border-gray-200 text-gray-500 hover:text-slate-600 hover:border-slate-500'}`} 
                title={t("切换形状", "Toggle Shape")}
            >
                {pickerMode === 'triangle' ? <Triangle size={14} className="rotate-90 fill-current"/> : <Grid size={14} className="fill-current"/>}
            </button>

            <canvas 
                ref={canvasRef} width={size} height={size} 
                className="cursor-crosshair mt-1"
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); handleInteraction(e); }}
                onPointerMove={(e) => (isDraggingRing || isDraggingShape) && handleInteraction(e)}
                onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); stopDrag(); if(onCommit) onCommit(); }}
                // [修复] 监听指针捕获丢失事件(如拖出窗口松开)，作为 pointerUp 的兜底，防止拖拽状态卡死
                onLostPointerCapture={(e) => { stopDrag(); if(onCommit) onCommit(); }}
            />
        </div>
        
        {/* 问题1: 布局重构 */}
        <div className="flex items-end justify-between px-4 pb-2 h-[27px] -mt-6 relative z-30">
             {/* 左侧：圆槽 + 混色条 (下沉) */}
             {/* Fix 5: 增加 ring-1 ring-black/10 确保白色时可见 */}
             <div className="flex items-center gap-2 pl-[8px] translate-y-0.5">
                 <div onClick={() => onSlotClick(1)} className={`w-[14px] h-[10px] rounded-full border cursor-pointer transition-all shadow-sm ring-1 ring-black/5 ${activeSlot === 1 ? `border-white ring-slate-400 scale-125` : 'border-white/20 opacity-60 hover:opacity-100'}`} style={{ backgroundColor: rgbToHex(colorSlots[1]?.r||0, colorSlots[1]?.g||0, colorSlots[1]?.b||0) }} />
                 <div 
                    className="w-[130px] h-[10px] rounded-full relative cursor-crosshair overflow-hidden border border-black/5 dark:border-white/10 group touch-none"
                    onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        const rect = e.currentTarget.getBoundingClientRect();
                        const updateColor = (clientX) => {
                            const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                            const c1 = colorSlots[1] || {r:0,g:0,b:0}, c2 = colorSlots[2] || {r:255,g:255,b:255};
                            const r = Math.round(c1.r + (c2.r - c1.r) * percent);
                            const g = Math.round(c1.g + (c2.g - c1.g) * percent);
                            const b = Math.round(c1.b + (c2.b - c1.b) * percent);
                            onChange(rgbToHsv(r, g, b));
                        };
                        
                        // 立即触发一次，支持单击取色
                        updateColor(e.clientX);
                        
                        const handleMove = (ev) => { ev.preventDefault(); updateColor(ev.clientX); };
                        const handleUp = (ev) => {
                            ev.currentTarget.removeEventListener('pointermove', handleMove);
                            ev.currentTarget.removeEventListener('pointerup', handleUp);
                            ev.currentTarget.releasePointerCapture(ev.pointerId);
                            if(onCommit) onCommit();
                        };
                        
                        e.currentTarget.addEventListener('pointermove', handleMove);
                        e.currentTarget.addEventListener('pointerup', handleUp);
                    }}
                 >
                    <div className="absolute inset-0" style={{ background: `linear-gradient(to right, ${rgbToHex(colorSlots[1]?.r||0, colorSlots[1]?.g||0, colorSlots[1]?.b||0)}, ${rgbToHex(colorSlots[2]?.r||0, colorSlots[2]?.g||0, colorSlots[2]?.b||0)})` }} />
                    <div className="absolute inset-0 opacity-0 group-hover:opacity-100 bg-white/10 transition-opacity" />
                 </div>
                 <div onClick={() => onSlotClick(2)} className={`w-[14px] h-[10px] rounded-full border cursor-pointer transition-all shadow-sm ring-1 ring-black/5 ${activeSlot === 2 ? `border-white ring-slate-400 scale-125` : 'border-white/20 opacity-60 hover:opacity-100'}`} style={{ backgroundColor: rgbToHex(colorSlots[2]?.r||0, colorSlots[2]?.g||0, colorSlots[2]?.b||0) }} />
             </div>

             {/* 右侧：方槽 + 上方功能键 */}
             {/* 修改: items-center 改为 items-end 实现右对齐 */}
             <div className="flex flex-col items-end gap-1.5 -mb-1">
                 {/* 修改: 功能键改为竖排 flex-col */}
                 <div className="flex flex-col gap-1">
                     <button 
                        className={`w-6 h-6 rounded border flex items-center justify-center shadow-sm transition-all
                        ${monitorPos ? 'bg-slate-500 border-slate-500 text-white' : (isPickingPixel ? 'bg-slate-500/20 border-slate-400 text-slate-400 animate-pulse' : (isDark ? 'bg-[#2a2a2a] border-white/10 text-gray-400 hover:text-slate-300' : 'bg-white border-gray-200 text-gray-500 hover:text-slate-600'))}`}
                        title={monitorPos ? t("停止监控", "Stop Monitor") : t("定点吸色", "Pick & Monitor")}
                        onClick={() => { if (monitorPos) setMonitorPos(null); else setIsPickingPixel(!isPickingPixel); }}
                     >
                        <Eye size={12} />
                     </button>
                     <button 
                        className={`w-6 h-6 rounded border flex items-center justify-center shadow-sm transition-all
                        ${isDark ? 'bg-[#2a2a2a] border-white/10 text-gray-400 hover:text-slate-300' : 'bg-white border-gray-200 text-gray-500 hover:text-slate-600'}`}
                        onClick={async (e) => {
                            e.stopPropagation();
                            e.currentTarget.blur();

                            // [修复] 先尝试关闭旧窗口，并等待销毁完成，防止 Label 冲突
                            try {
                                const oldWin = await WebviewWindow.getByLabel('picker-overlay');
                                if (oldWin) {
                                    await oldWin.close();
                                    // 关键修复：强制等待 200ms 让后台释放 Label，否则立即重建会失败
                                    await new Promise(r => setTimeout(r, 200));
                                }
                            } catch (e) {}

                            // [优化] 使用自定义高性能取色窗口，解决数位板卡顿问题
                            // [修复] 移除死锁检查，允许强制重新触发防止卡死
                            window._isPicking = true;
                            
                            // 先获取快照数据 (存入后端内存)
                            try {
                                await invoke('capture_current_monitor_snapshot');
                                
                                // 直接打开全屏窗口，位置和尺寸由窗口内部读取后端数据后决定
                                new WebviewWindow('picker-overlay', {
                                    url: 'index.html?mode=picker',
                                    fullscreen: true, // 简单粗暴，直接全屏
                                    transparent: true, decorations: false, alwaysOnTop: true, 
                                    skipTaskbar: true, resizable: false, focus: true,
                                    visible: false 
                                });
                            } catch (err) {
                                console.error("Snapshot failed:", err);
                                window._isPicking = false;
                            }
                        }}
                        title={t("屏幕吸管", "EyeDropper")}
                     >
                        <Pipette size={12} />
                     </button>
                 </div>

                 {/* [Issue 2] 重构：色槽重叠布局 (左上大 + 右下小) */}
                     <div className="relative w-10 h-10 mb-0.5">
                         
                         {/* 1. 当前选色槽 (左上，略大) */}
                     <div 
                        // [Fix 3] 移除此处重复的定时器，减少 IPC 调用，缓解拖拽卡顿
                        // 坐标同步已由 useTauriBackend 统一管理
                        onClick={() => onSlotClick(0)}
                        className={`absolute top-0 left-0 w-7 h-7 rounded-md shadow-md border transition-all cursor-pointer overflow-hidden group z-10
                        ${activeSlot === 0 ? 'border-white ring-1 ring-slate-400' : 'border-white/10 hover:scale-105'}`}
                        style={{ backgroundColor: rgbToHex(colorSlots[0].r, colorSlots[0].g, colorSlots[0].b) }}
                        title={t("当前颜色", "Current Color")}
                     >
                         {/* 复制图标 */}
                         <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
                             <Copy size={10} className="text-white drop-shadow-md"/>
                         </div>
                     </div>

                     {/* 2. 监控色槽 (右下，略小，有描边，常驻) */}
                     <div 
                        onClick={() => {
                            // 点击同步：将监控色 -> 当前色
                            if (onUpdateCurrent) onUpdateCurrent(monitorRgb);
                        }}
                        className={`absolute bottom-0 right-0 w-6 h-6 rounded-md border-2 border-white/80 shadow-lg cursor-pointer transition-transform hover:scale-110 z-20 flex items-center justify-center
                        ${monitorPos ? 'ring-1 ring-green-500' : 'grayscale opacity-50'}`}
                        style={{ backgroundColor: rgbToHex(monitorRgb.r, monitorRgb.g, monitorRgb.b) }}
                        title={monitorPos ? t("点击同步到当前", "Click to Sync") : t("未监控，使用定点吸色进行取色监控", "Idle")}
                     >
                        {!monitorPos && <div className="w-0.5 h-full bg-red-500/50 rotate-45 absolute"/>}
                     </div>

                 </div>
             </div>
        </div>
    </div>
  );
};

// --- 等亮度图表 (修复版) ---
export const IsoLuminanceGraph = ({ targetLuminance, hue, saturation, value, onPickColor, alg = 'rec601', lang, useGamma, setUseGamma }) => {
  const t = (zh, en) => lang === 'zh' ? zh : en; 
  const canvasRef = useRef(null);
  const [crosshair, setCrosshair] = useState(null);
  // const [useGamma, setUseGamma] = useState(true); // 已移交父组件管理

  // [新增] 自适应 Tooltip 状态
  const [showTip, setShowTip] = useState(false);
  const [tipPos, setTipPos] = useState({ top: 0, left: 0, goUp: false });
  const tipTriggerRef = useRef(null);

  // [修改] 智能计算位置函数
  const handleTipEnter = () => {
      if (tipTriggerRef.current) {
          const rect = tipTriggerRef.current.getBoundingClientRect();
          const winW = window.innerWidth;
          const winH = window.innerHeight;
          const tooltipWidth = 260; // 对应 w-64 (256px) + 少量余量

          // 1. 垂直方向判断：如果下方空间小于 180px，则向上弹出
          const spaceBottom = winH - rect.bottom;
          const goUp = spaceBottom < 180; 

          // 2. 水平方向判断：优先居中对齐，然后强制限制在屏幕内
          // 初步计算居中位置
          let left = rect.left + rect.width / 2 - tooltipWidth / 2;
          
          // 左边界限制 (至少留 8px)
          if (left < 8) left = 8;
          // 右边界限制
          if (left + tooltipWidth > winW - 8) left = winW - tooltipWidth - 8;

          setTipPos({ 
              // goUp时：显示在元素顶部上方 8px；否则显示在底部下方 8px
              top: goUp ? rect.top - 8 : rect.bottom + 8, 
              left: left, 
              goUp 
          });
          setShowTip(true);
      }
  };

  // [新增] 本地计算有效目标亮度
  // 如果组件内关闭了 Gamma，需要根据当前的 H/S/V 重新计算一个不带 Gamma 的亮度作为目标，
  // 否则会使用 App 传入的带 Gamma 的 targetLuminance，导致错位。
  const effectiveTargetLuminance = React.useMemo(() => {
      if (value !== undefined) {
          const rgb = hsvToRgb(hue, saturation, value);
          return getLuminance(rgb.r, rgb.g, rgb.b, alg, useGamma);
      }
      return targetLuminance;
  }, [hue, saturation, value, alg, useGamma, targetLuminance]);

  const drawMarker = useCallback((ctx, w, h) => {
      const x = (hue / 360) * w;
      const y = h - (saturation / 100) * h;
      ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
      ctx.shadowColor = 'black'; ctx.shadowBlur = 2;
      ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
      ctx.shadowBlur = 0;
  }, [hue, saturation]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width; const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0,0,w,h); 
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let x = 0; x < w; x++) {
      const hVal = (x / w) * 360;
      for (let y = 0; y < h; y++) {
        const sVal = 1 - (y / h); 
        const rgbMax = hsvToRgb(hVal, sVal * 100, 100);
        const lMax = getLuminance(rgbMax.r, rgbMax.g, rgbMax.b, alg, useGamma);
        if (lMax >= effectiveTargetLuminance * 0.99) {
           const ratio = effectiveTargetLuminance / (lMax + 0.0001);
           const vDec = useGamma ? Math.pow(ratio, 1/2.2) : ratio;
           const finalV = Math.min(100, vDec * 100);
           const c = hsvToRgb(hVal, sVal * 100, finalV);
           const idx = (y * w + x) * 4;
           data[idx] = c.r; data[idx+1] = c.g; data[idx+2] = c.b; data[idx+3] = 255;
        } else {
           const idx = (y * w + x) * 4;
           data[idx]=30; data[idx+1]=30; data[idx+2]=30; data[idx+3]=255; 
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
    if (crosshair) {
        ctx.strokeStyle = 'white'; ctx.lineWidth = 1; ctx.setLineDash([2,2]);
        ctx.beginPath(); ctx.moveTo(crosshair.x, 0); ctx.lineTo(crosshair.x, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, crosshair.y); ctx.lineTo(w, crosshair.y); ctx.stroke();
        ctx.setLineDash([]);
    }
    drawMarker(ctx, w, h);
  }, [effectiveTargetLuminance, crosshair, drawMarker, alg, useGamma]);

  useEffect(() => { draw(); }, [draw]);

  const handlePointer = (e) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      const safeX = Math.max(0, Math.min(x, canvas.width));
      const safeY = Math.max(0, Math.min(y, canvas.height));
      setCrosshair({x: safeX, y: safeY});
      const w = canvas.width; const h = canvas.height;
      const hVal = (safeX / w) * 360;
      const sVal = (1 - safeY/h); 
      const rgbMax = hsvToRgb(hVal, sVal * 100, 100);
      const lMax = getLuminance(rgbMax.r, rgbMax.g, rgbMax.b, alg, useGamma);
      if (lMax >= effectiveTargetLuminance * 0.99) {
          const ratio = effectiveTargetLuminance / (lMax + 0.0001);
          const vDec = useGamma ? Math.pow(ratio, 1/2.2) : ratio;
          const finalV = Math.min(100, vDec * 100);
          if (e.buttons === 1) { onPickColor({ h: hVal, s: sVal*100, v: finalV }); }
      }
  };

  return (
    <div className="w-full relative group">
       <canvas 
         ref={canvasRef} width={240} height={120} 
         className="w-full h-[120px] rounded border border-white/10 cursor-crosshair touch-none"
         onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); handlePointer(e); }}
         onPointerMove={handlePointer}
         onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
         onPointerLeave={() => setCrosshair(null)}
       />
       
       {/* 底部控制栏 */}
       <div className="flex justify-end items-center mt-1 px-1">
           <div className="flex items-center gap-2">
               {/* 1. 说明按钮 (放在左侧) */}
               <div 
                   ref={tipTriggerRef}
                   onMouseEnter={handleTipEnter}
                   onMouseLeave={() => setShowTip(false)}
                   className="flex items-center cursor-help text-gray-500 hover:text-gray-300 transition-colors p-1"
               >
                   <AlertCircle size={10} />
               </div>

               {/* 2. Gamma 开关 (放在右侧) */}
               <button 
                 onClick={() => setUseGamma(!useGamma)}
                 className={`flex items-center gap-1.5 text-[9px] px-1.5 py-0.5 rounded transition-colors ${useGamma ? 'bg-teal-500/10 text-teal-500 border border-teal-500/30' : 'bg-white/5 text-gray-500 border border-transparent hover:text-gray-300'}`}
                 title={useGamma ? t("Gamma 校正: 开启", "Gamma: ON") : t("Gamma 校正: 关闭", "Gamma: OFF ")}
               >
                   <div className={`w-1.5 h-1.5 rounded-full ${useGamma ? 'bg-teal-500 shadow-[0_0_4px_rgba(20,184,166,0.6)]' : 'bg-gray-600'}`} />
                   <span>Gamma 2.2</span>
               </button>
           </div>

           {/* 3. Portal 渲染浮层 (自适应位置 + 不被遮挡) */}
           {showTip && createPortal(
               <div 
                   className="fixed z-[9999] w-64 p-3 bg-[#1a1a1a] text-gray-200 text-[11px] rounded-lg border border-white/10 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100 pointer-events-none"
                   style={{ 
                       // 使用 JS 计算出的绝对坐标
                       top: tipPos.top, 
                       left: tipPos.left, 
                       // 仅在垂直方向使用 transform，避免水平偏移造成问题
                       transform: `translateY(${tipPos.goUp ? '-100%' : '0'})` 
                   }}
               >
                   <p className="mb-2 leading-relaxed">
                       <span className="text-teal-400 font-bold">{t("开启", "ON")}</span>：
                       {t("(推荐)模拟人眼物理亮度 (Rec.601标准)，色彩过渡更自然，但会与灰度滤镜产生一些差别。", "(Rec.)Physically accurate luminance (Rec.601). More natural gradients, but differs slightly from simple grayscale filters.")}
                   </p>
                   <p className="leading-relaxed">
                       <span className="text-gray-400 font-bold">{t("关闭", "OFF")}</span>：
                       {t("直接计算数值亮度 (所见即所得)，适合匹配无色彩管理的绘图软件，与灰度滤镜算法一致。", "Raw numerical brightness (WYSIWYG). Matches paint software without color management. Consistent with grayscale filter.")}
                   </p>
               </div>,
               document.body
           )}
       </div>
    </div>
  );
};

// --- 滑块组件 ---
export const SliderItem = React.memo(({ label, val, min=0, max=100, type, channel, currentVals, setVal, getGradient }) => (
    <div className="flex items-center gap-2 h-5">
        <span className="w-3 text-[9px] font-bold opacity-40 uppercase text-center">{label}</span>
        <div className="flex-1 h-1.5 rounded-full relative bg-gray-200 dark:bg-white/10 overflow-visible flex items-center">
            <div className="absolute inset-0 rounded-full" style={{ background: getGradient(type, channel, currentVals) }} />
            <input 
              type="range" min={min} max={max} step={1}
              value={val ?? 0} 
              onInput={(e) => setVal(Number(e.target.value))}
              className="w-full h-full absolute inset-0 opacity-0 cursor-pointer z-20 touch-none" 
            />
            <div 
               className="absolute h-3 w-3 bg-white rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.3)] border border-gray-100 pointer-events-none z-10 transition-transform duration-75"
               style={{ left: `calc(${((val - min) / (max - min)) * 100}% - 6px)` }}
            />
        </div>
        <span className="w-6 text-[9px] font-mono text-right opacity-60">{Math.round(val)}</span>
    </div>
));

export const ColorSliders = ({ r, g, b, onChange, isDark, mode, setMode, panelConfig, setPanelConfig }) => {
    // [需求3] 状态管理：菜单显示状态
    const [showMenu, setShowMenu] = useState(false);
    const { sliderMultiMode, activeSliderModes } = panelConfig;

    const getGradient = useCallback((type, channel, currentVals) => {
      try {
        // 辅助：将归一化(0-1)的 culori 颜色对象转为 CSS 字符串
        const toCss = (c) => {
            if (!c) return 'transparent';
            const r = Math.max(0, Math.min(255, Math.round(c.r * 255)));
            const g = Math.max(0, Math.min(255, Math.round(c.g * 255)));
            const b = Math.max(0, Math.min(255, Math.round(c.b * 255)));
            return `rgb(${r},${g},${b})`;
        };

        if (type === 'RGB') {
            const {r,g,b} = currentVals;
            if (channel === 'r') return `linear-gradient(to right, rgb(0,${g},${b}), rgb(255,${g},${b}))`;
            if (channel === 'g') return `linear-gradient(to right, rgb(${r},0,${b}), rgb(${r},255,${b}))`;
            if (channel === 'b') return `linear-gradient(to right, rgb(${r},${g},0), rgb(${r},${g},255))`;
        }
        
        if (type === 'HSV') {
            const {h,s,v} = currentVals;
            // H 色相条保持全光谱
            if (channel === 'h') return `linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)`;
            
            // 修复：S 和 V 使用 RGB 转换来计算两端颜色
            if (channel === 's') {
                const start = hsvToRgb(h, 0, v);
                const end = hsvToRgb(h, 100, v);
                return `linear-gradient(to right, ${rgbToHex(start.r,start.g,start.b)}, ${rgbToHex(end.r,end.g,end.b)})`;
            }
            if (channel === 'v') {
                const end = hsvToRgb(h, s, 100);
                return `linear-gradient(to right, black, ${rgbToHex(end.r,end.g,end.b)})`;
            }
        }

        // [修复] CMYK 动态渐变 (使用本地算法替代 culori，防止未注册导致无渐变)
        if (type === 'CMYK') {
            const { c, m, y, k } = currentVals || {c:0, m:0, y:0, k:0}; 
            
            // 计算起点(0%)和终点(100%)的 RGB 值
            const s = cmykToRgb(
                channel === 'c' ? 0 : c,
                channel === 'm' ? 0 : m,
                channel === 'y' ? 0 : y,
                channel === 'k' ? 0 : k
            );
            const e = cmykToRgb(
                channel === 'c' ? 100 : c,
                channel === 'm' ? 100 : m,
                channel === 'y' ? 100 : y,
                channel === 'k' ? 100 : k
            );

            return `linear-gradient(to right, rgb(${s.r},${s.g},${s.b}), rgb(${e.r},${e.g},${e.b}))`;
        }

        // [修复] LAB 动态渐变
        if (type === 'LAB') {
            const { l, a, b } = currentVals;
            const base = { mode: 'lab', l, a, b };
            let startCol, endCol;

            if (channel === 'l') {
                startCol = culoriRgb({ ...base, l: 0 });   // 黑
                endCol = culoriRgb({ ...base, l: 100 }); // 白 (在当前色相下)
            } else if (channel === 'a') {
                startCol = culoriRgb({ ...base, a: -128 }); // 绿端
                endCol = culoriRgb({ ...base, a: 127 });  // 红端
            } else if (channel === 'b') {
                startCol = culoriRgb({ ...base, b: -128 }); // 蓝端
                endCol = culoriRgb({ ...base, b: 127 });  // 黄端
            }
            return `linear-gradient(to right, ${toCss(startCol)}, ${toCss(endCol)})`;
        }
        return 'none';
      } catch (e) { 
        // 发生错误时返回 none，防止白屏
        return 'none'; 
      }
    }, []);

    const updateRGB = (k, v) => onChange({ r: k==='r'?v:r, g: k==='g'?v:g, b: k==='b'?v:b });

    const toggleMode = (m) => {
        if (!sliderMultiMode) {
            setMode(m);
        } else {
            // 多选逻辑
            const newModes = activeSliderModes.includes(m) 
                ? activeSliderModes.filter(x => x !== m) 
                : [...activeSliderModes, m];
            setPanelConfig(s => ({ ...s, activeSliderModes: newModes }));
        }
    };

    // 渲染单个滑块组的逻辑封装
    const renderSliderGroup = (type) => {
        if (type === 'RGB') {
            return (
                 <div className="space-y-1 py-1">
                     <SliderItem label="R" val={r} max={255} type="RGB" channel="r" currentVals={{r,g,b}} setVal={v => updateRGB('r', v)} getGradient={getGradient} />
                     <SliderItem label="G" val={g} max={255} type="RGB" channel="g" currentVals={{r,g,b}} setVal={v => updateRGB('g', v)} getGradient={getGradient} />
                     <SliderItem label="B" val={b} max={255} type="RGB" channel="b" currentVals={{r,g,b}} setVal={v => updateRGB('b', v)} getGradient={getGradient} />
                 </div>
            );
        }
        if (type === 'HSV') {
             const hsv = rgbToHsv(r,g,b);
             const setHsv = (k, v) => {
                 const newHsv = { ...hsv, [k]: v };
                 onChange(hsvToRgb(newHsv.h, newHsv.s, newHsv.v));
             };
             return (
                <div className="space-y-1 py-1">
                    <SliderItem label="H" val={hsv.h} max={360} type="HSV" channel="h" currentVals={hsv} setVal={v => setHsv('h',v)} getGradient={getGradient} />
                    <SliderItem label="S" val={hsv.s} max={100} type="HSV" channel="s" currentVals={hsv} setVal={v => setHsv('s',v)} getGradient={getGradient} />
                    <SliderItem label="V" val={hsv.v} max={100} type="HSV" channel="v" currentVals={hsv} setVal={v => setHsv('v',v)} getGradient={getGradient} />
                </div>
             );
        }
        if (type === 'CMYK') {
             let c=0, m=0, y=0, k=0;
             try {
                 if(culoriCmyk) {
                    const cmykObj = culoriCmyk({ mode: 'rgb', r: r/255, g: g/255, b: b/255 });
                    if(cmykObj) { c=cmykObj.c*100; m=cmykObj.m*100; y=cmykObj.y*100; k=cmykObj.k*100; }
                 } else {
                    const temp = rgbToCmyk(r,g,b);
                    c=temp.c; m=temp.m; y=temp.y; k=temp.k;
                 }
             } catch(e) { const temp = rgbToCmyk(r,g,b); c=temp.c; m=temp.m; y=temp.y; k=temp.k; }
             
             const setCmyk = (key, val) => {
                try {
                     if(culoriRgb) {
                         const newCmyk = { mode: 'cmyk', c: c/100, m: m/100, y: y/100, k: k/100, [key]: val/100 };
                         const newRgb = culoriRgb(newCmyk);
                         if (newRgb) {
                            onChange({ r: Math.round(newRgb.r*255), g: Math.round(newRgb.g*255), b: Math.round(newRgb.b*255) });
                            return;
                         }
                     }
                     throw new Error("Culori failed");
                } catch(e) {
                     const current = {c, m, y, k, [key]: val};
                     onChange(cmykToRgb(current.c, current.m, current.y, current.k));
                }
             };
             return (
                <div className="space-y-1 py-1">
                    <SliderItem label="C" val={c} max={100} type="CMYK" channel="c" currentVals={{c,m,y,k}} setVal={v=>setCmyk('c',v)} getGradient={getGradient} />
                    <SliderItem label="M" val={m} max={100} type="CMYK" channel="m" currentVals={{c,m,y,k}} setVal={v=>setCmyk('m',v)} getGradient={getGradient} />
                    <SliderItem label="Y" val={y} max={100} type="CMYK" channel="y" currentVals={{c,m,y,k}} setVal={v=>setCmyk('y',v)} getGradient={getGradient} />
                    <SliderItem label="K" val={k} max={100} type="CMYK" channel="k" currentVals={{c,m,y,k}} setVal={v=>setCmyk('k',v)} getGradient={getGradient} />
                </div>
             );
        }
        if (type === 'LAB') {
             const lab = rgbToLab(r, g, b);
             const setLab = (key, val) => {
                 const newLab = { mode: 'lab', l: lab.l, a: lab.a, b: lab.b, [key]: val };
                 const newRgb = culoriRgb(newLab);
                 if (newRgb) {
                    onChange({
                        r: Math.max(0, Math.min(255, Math.round(newRgb.r * 255))),
                        g: Math.max(0, Math.min(255, Math.round(newRgb.g * 255))),
                        b: Math.max(0, Math.min(255, Math.round(newRgb.b * 255)))
                    });
                 }
             };
             return (
                 <div className="space-y-1 py-1">
                     <SliderItem label="L" val={lab.l} min={0} max={100} type="LAB" channel="l" currentVals={lab} setVal={v => setLab('l', v)} getGradient={getGradient} />
                     <SliderItem label="A" val={lab.a} min={-128} max={128} type="LAB" channel="a" currentVals={lab} setVal={v => setLab('a', v)} getGradient={getGradient} />
                     <SliderItem label="B" val={lab.b} min={-128} max={128} type="LAB" channel="b" currentVals={lab} setVal={v => setLab('b', v)} getGradient={getGradient} />
                 </div>
             )
        }
        return null;
    };

    return (
        // 去掉外层 p-4 和 border，因为 App.jsx 的容器已经有了
        <div className="space-y-2">
             {/* 顶部控制栏 */}
             <div className="flex gap-1 text-[10px] font-bold border-b border-gray-500/10 pb-1 items-center relative">
                 {/* 菜单触发器 */}
                 <div className="relative">
                     <button 
                        onClick={() => setShowMenu(!showMenu)}
                        className={`p-1 rounded hover:bg-black/10 transition-colors ${showMenu ? 'bg-black/10' : ''}`}
                     >
                         <ChevronDown size={10} />
                     </button>
                     
                     {/* 下拉菜单 */}
                     {showMenu && (
                         <>
                             <div className="fixed inset-0 z-[50]" onClick={() => setShowMenu(false)} />
                             <div className={`absolute top-full left-0 mt-1 w-32 p-1 rounded-lg border shadow-xl z-[51] backdrop-blur-xl ${isDark ? 'bg-[#2a2a2a]/90 border-white/20' : 'bg-white/90 border-gray-200'}`}>
                                 <div 
                                    className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-black/10 mb-1 border-b border-white/5"
                                    onClick={() => setPanelConfig(s => ({ ...s, sliderMultiMode: !sliderMultiMode }))}
                                 >
                                     <div className={`w-3 h-3 border rounded flex items-center justify-center ${sliderMultiMode ? 'bg-blue-500 border-blue-500' : 'border-gray-500'}`}>
                                         {sliderMultiMode && <Check size={8} className="text-white" />}
                                     </div>
                                     <span className="font-normal opacity-80">多选模式 (Multi)</span>
                                 </div>
                                 
                                 {/* 仅在多选模式下显示这些复选框 */}
                                 {sliderMultiMode && ['RGB', 'HSV', 'CMYK', 'LAB'].map(m => (
                                     <div 
                                        key={m}
                                        className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-black/10"
                                        onClick={() => toggleMode(m)}
                                     >
                                         <div className={`w-3 h-3 border rounded flex items-center justify-center ${activeSliderModes.includes(m) ? 'bg-slate-500 border-slate-500' : 'border-gray-500'}`}>
                                             {activeSliderModes.includes(m) && <Check size={8} className="text-white" />}
                                         </div>
                                         <span className="opacity-70">{m}</span>
                                     </div>
                                 ))}
                             </div>
                         </>
                     )}
                 </div>

                 {/* 标签栏：单选时显示所有Tab，多选时显示"Custom" */}
                 {!sliderMultiMode ? (
                     ['RGB', 'HSV', 'CMYK', 'LAB'].map(m => (
                         <button key={m} onClick={() => setMode(m)} className={`flex-1 py-0.5 rounded transition-colors ${mode===m ? 'bg-slate-500 text-white shadow' : 'opacity-40 hover:bg-black/5 hover:opacity-100'}`}>
                             {m}
                         </button>
                     ))
                 ) : (
                     <div className="flex-1 text-center py-0.5 opacity-50 italic">Multi-View</div>
                 )}
             </div>
             
             {/* 滑块内容渲染 */}
             <div className="space-y-3">
                 {sliderMultiMode ? (
                     // 多选模式：遍历 activeSliderModes
                     activeSliderModes.length > 0 ? (
                         activeSliderModes.map(m => (
                             <div key={m} className="animate-in fade-in slide-in-from-left-2">
                                 {/* 只有在多选且多于1个时才显示小标题区分 */}
                                 {activeSliderModes.length > 1 && <div className="text-[9px] font-bold opacity-30 px-1">{m}</div>}
                                 {renderSliderGroup(m)}
                             </div>
                         ))
                     ) : (
                         <div className="text-center text-[9px] opacity-30 py-2">No active sliders</div>
                     )
                 ) : (
                     // 单选模式
                     renderSliderGroup(mode)
                 )}
             </div>
        </div>
    );
};

// --- 屏幕监视画布 ---
export const ScreenCanvas = ({ isDark, filterId, lang }) => {
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const t = (zh, en) => lang === 'zh' ? zh : en;
    const [stream, setStream] = useState(null);
    const [isDocked, setIsDocked] = useState(true);
    const [filterEnabled, setFilterEnabled] = useState(false);

    const startCapture = async () => {
        try {
            const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            setStream(s);
            if (videoRef.current) videoRef.current.srcObject = s;
        } catch (e) { console.error("Capture failed", e); }
    };

    const stopCapture = () => {
        if (stream) stream.getTracks().forEach(t => t.stop());
        setStream(null);
    };

    useEffect(() => {
        let animationFrameId; // 追踪 ID
        let isActive = true;  // 追踪挂载状态

        if (stream && videoRef.current) {
            videoRef.current.play();
            const loop = () => {
                if (!isActive || !videoRef.current || !canvasRef.current) return;
                const ctx = canvasRef.current.getContext('2d');
                ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);
                animationFrameId = requestAnimationFrame(loop);
            };
            animationFrameId = requestAnimationFrame(loop);
        }
        
        return () => {
            isActive = false;
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
        };
    }, [stream]);

    const containerStyle = isDocked 
        ? "w-full h-48 relative rounded-xl overflow-hidden border border-white/10 bg-black"
        : "fixed top-20 left-20 w-64 h-48 z-50 rounded-xl overflow-hidden shadow-2xl border border-white/20 bg-black cursor-move resize";

    return (
        <div className="space-y-3 p-4 h-full flex flex-col">
            <div className="flex justify-between items-center">
                 <h2 className="text-sm font-bold">{t('屏幕监视', 'Screen Monitor')}</h2>
                 <div className="flex gap-2">
                     {!stream ? (
                         <button onClick={startCapture} className="px-3 py-1.5 bg-gradient-to-r from-blue-500 to-blue-600 hover:shadow-lg hover:shadow-blue-500/30 text-white rounded-lg text-xs font-medium transition-all transform active:scale-95">
                            {t('选择区域', 'Select Area')}
                         </button>
                     ) : (
                         <button onClick={stopCapture} className="px-3 py-1.5 bg-red-500/10 border border-red-500/50 text-red-500 hover:bg-red-500 hover:text-white rounded-lg text-xs font-medium transition-all">
                            {t('停止', 'Stop')}
                         </button>
                     )}
                 </div>
            </div>

            {stream ? (
                <div className={containerStyle} style={{ filter: filterEnabled ? `url(#${filterId})` : 'none' }}>
                    <video ref={videoRef} autoPlay playsInline muted className="hidden" />
                    <canvas ref={canvasRef} width={300} height={200} className="w-full h-full object-cover" />
                    <div className="absolute bottom-2 right-2 flex gap-1">
                        <button onClick={() => setFilterEnabled(!filterEnabled)} className="p-1.5 bg-black/60 rounded text-white hover:bg-white/20" title={t('应用滤镜','Apply Filter')}>
                            {filterEnabled ? <Layers size={12} className="text-slate-400"/> : <Layers size={12}/>}
                        </button>
                        <button onClick={() => setIsDocked(!isDocked)} className="p-1.5 bg-black/60 rounded text-white hover:bg-white/20" title={t('切换停靠','Dock/Float')}>
                            {isDocked ? <Maximize2 size={12}/> : <Minimize2 size={12}/>}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="flex-1 rounded-xl border border-dashed border-white/20 flex flex-col items-center justify-center text-xs opacity-50">
                    <Crop size={32} className="mb-2"/>
                    <span>{t('点击“选择区域”拾取窗口', 'Click Select Area')}</span>
                </div>
            )}
            <div className="text-[10px] opacity-40">
                {t('* 浏览器限制：必须选择特定窗口或屏幕', '* Browser limit: Must select specific window/screen')}
            </div>
        </div>
    );
};

// --- 区域选择遮罩 ---
export const RegionSelector = ({ onConfirm, onCancel }) => {
    const [startPos, setStartPos] = useState(null);
    const [currentPos, setCurrentPos] = useState(null);

    const getRect = () => {
        if (!startPos || !currentPos) return null;
        const x = Math.min(startPos.x, currentPos.x);
        const y = Math.min(startPos.y, currentPos.y);
        const w = Math.abs(currentPos.x - startPos.x);
        const h = Math.abs(currentPos.y - startPos.y);
        return { x, y, w, h };
    };

    return (
        <div 
            className="fixed inset-0 z-[9999] cursor-crosshair bg-black/10"
            onMouseDown={(e) => setStartPos({ x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => startPos && setCurrentPos({ x: e.clientX, y: e.clientY })}
            onMouseUp={() => {
                const rect = getRect();
                if (rect && rect.w > 10 && rect.h > 10) onConfirm(rect);
                else onCancel();
                setStartPos(null);
            }}
        >
            <div className="absolute inset-0 bg-black/50 pointer-events-none" 
                 style={getRect() ? { clipPath: `polygon(0% 0%, 0% 100%, 100% 100%, 100% 0%, 0% 0%, ${getRect().x}px ${getRect().y}px, ${getRect().x + getRect().w}px ${getRect().y}px, ${getRect().x + getRect().w}px ${getRect().y + getRect().h}px, ${getRect().x}px ${getRect().y + getRect().h}px, ${getRect().x}px ${getRect().y}px)` } : {}} 
            />
            {getRect() && (
                <div 
                    className="absolute border-2 border-slate-500 bg-transparent pointer-events-none"
                    style={{ left: getRect().x, top: getRect().y, width: getRect().w, height: getRect().h }}
                >
                    <div className="absolute -top-6 left-0 text-white text-xs bg-teal-700 px-1 rounded">
                        {Math.round(getRect().w)} x {Math.round(getRect().h)}
                    </div>
                </div>
            )}
            <div className="absolute top-4 left-1/2 -translate-x-1/2 text-white bg-black/70 px-4 py-1 rounded-full text-xs pointer-events-none">
                按住鼠标左键框选区域 / 点击取消
            </div>
        </div>
    );
};

// --- 视频预览小组件 (修复版) ---
const VideoPreview = ({ source }) => {
    const [img, setImg] = useState(null);
    const [status, setStatus] = useState('Loading...');

    useEffect(() => {
        let active = true;
        const loop = async () => {
            if(!active) return;
            try {
                let data = null;
                if (source.type === 'native-app') {
                    try {
                        data = await invoke('capture_window_thumbnail', { appName: source.label });
                    } catch (err) {
                        if (active) { setImg(null); setStatus('最小化/Hidden'); }
                        setTimeout(loop, 2000); return;
                    }
                } else {
                    const captureRect = source.crop;
                    data = await invoke('capture_region', { 
                        x: captureRect.x, y: captureRect.y, 
                        w: captureRect.w, h: captureRect.h 
                    });
                }
                if(active) { setImg(data); setStatus(''); }
            } catch(e) { if(active) setStatus('Error'); }
            setTimeout(loop, 1500); 
        };
        loop();
        return () => { active = false; };
    }, [source]);

    // 动态样式: 灰度 + 镜像
    const imgStyle = {
        filter: source.isGray ? 'grayscale(100%)' : 'none',
        transform: source.isMirror ? 'scaleX(-1)' : 'none',
    };

    return (
        <div className="w-full h-full bg-black flex items-center justify-center pointer-events-none overflow-hidden relative">
            {img ? (
                <img src={img} className="w-full h-full object-contain transition-all duration-300" style={imgStyle} />
            ) : (
                <span className="text-[9px] text-gray-500 bg-white/10 px-2 py-1 rounded">{status}</span>
            )}
            
            {/* [修复5] 最小化提示遮罩 */}
            {!img && status.includes('最小化') && (
                <div className="absolute inset-0 bg-gray-900 flex flex-col items-center justify-center text-gray-400 p-2 text-center">
                    <span className="text-xl font-bold mb-1">－</span>
                    <span className="text-[10px] leading-tight">源窗口已最小化<br/>无法预览</span>
                </div>
            )}
        </div>
    );
};



// --- 多源屏幕管理器 ---
export const ScreenPanel = ({ isDark, lang, sources, setSources }) => {
    const t = (zh, en) => lang === 'zh' ? zh : en;
    const [appTree, setAppTree] = useState([]); // [Issue 3] 改为树状结构
    const [expandedApps, setExpandedApps] = useState({}); // 展开状态
    const [showAppPicker, setShowAppPicker] = useState(false);
    const [wgcSupported, setWgcSupported] = useState(true);

    const loadApps = async () => {
        try {
            const tree = await invoke('get_app_windows_tree');
            setAppTree(tree);
            setShowAppPicker(true);
        } catch (e) { console.error(e); }
    };
    
    const toggleExpand = (appName, e) => {
        e.stopPropagation();
        setExpandedApps(prev => ({...prev, [appName]: !prev[appName]}));
    };


    // 创建隐藏窗口 (WGC 准备)
    const createHiddenPip = async (src) => {
        const label = `monitor-${src.id}`;
        // 传递更多元数据
        let params = `?mode=mag&id=${src.id}&type=${src.type}&label=${encodeURIComponent(src.label)}`;
        
        let initW = 400, initH = 300;
        if (src.crop && src.crop.w > 0 && src.crop.h > 0) {
            params += `&x=${src.crop.x}&y=${src.crop.y}&w=${src.crop.w}&h=${src.crop.h}`;
            initW = src.crop.w;
            initH = src.crop.h;
        }
    
        try {
            // 创建时直接 Hidden
            new WebviewWindow(label, {
                url: `index.html${params}`,
                skipTaskbar: true, // 不在任务栏显示
                title: src.label || 'Monitor',
                width: initW, 
                height: initH,
                minWidth: 50, 
                minHeight: 50,
                transparent: true, // 必须透明，否则 WebView 背景会遮挡 WGC 画面
                backgroundColor: "#00000000", // 完全透明背景
                alwaysOnTop: true,
                decorations: false,
                shadow: true,
                visible: false // 初始隐藏，等待唤醒
            });
        } catch (e) {
            console.error('Window creation failed:', e);
        }
    };

    useEffect(() => {
        invoke('get_os_build_version').then(ver => {
            if (ver < 18362) {
                setWgcSupported(false);
                console.warn("System build", ver, "too low for WGC");
            }
        });
    }, []);

    useEffect(() => {
        // 1. 区域选择监听
        const unlistenRegion = listen('region-selected', async (event) => {
            if (event.payload.purpose !== 'monitor') return;
            const rect = event.payload;
            const newSource = {
                id: Date.now(),
                type: 'region',
                crop: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }, 
                label: `Region ${Math.round(rect.w)}x${Math.round(rect.h)}`
            };
            setSources(prev => [...prev, newSource]);
            openPip(newSource, false);
        });

        // 2. 状态变更监听
        const unlistenState = listen('monitor-state-changed', (e) => {
            setSources(prev => prev.map(s => {
                if (`monitor-${s.id}` === e.payload.label) {
                    return { ...s, isGray: e.payload.isGray };
                }
                return s;
            }));
        });

        // 3. 可见性变更监听
        const unlistenVis = listen('monitor-visibility-changed', (e) => {
             setSources(prev => prev.map(s => {
                if (`monitor-${s.id}` === e.payload.label) {
                    return { ...s, active: e.payload.visible };
                }
                return s;
            }));
        });

        // 4. 配置更新监听
        const unlistenConfigUpdate = listen('update-source-config', (e) => {
            const { id, newConfig } = e.payload;
            setSources(prev => prev.map(s => {
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

        // 统一清理
        return () => {
            unlistenRegion.then(f => f());
            unlistenState.then(f => f());
            unlistenVis.then(f => f());
            unlistenConfigUpdate.then(f => f());
        };
    }, []);

    const handleRegionCapture = async () => {
        new WebviewWindow('selector-monitor', {
            url: 'index.html?mode=monitor',
            transparent: true, fullscreen: true, alwaysOnTop: true, 
            skipTaskbar: true, decorations: false, resizable: false,
            visible: false // 修复: 初始隐藏，防止白屏
        });
    };

    const ensurePipWindow = async (src) => {
        const label = `monitor-${src.id}`;
        
        const win = await WebviewWindow.getByLabel(label);
        
        if (win) {
            try {
                // [修复 Issue 3] 强制状态同步，不单纯依赖 isVisible
                // 使用 src.active 作为更可靠的逻辑判断 (因为 isVisible 是异步且可能在动画中滞后)
                const shouldShow = !src.active;
                
                if (!shouldShow) {
                    // 隐藏
                    await invoke('pause_wgc_session', { label });
                    await win.hide();
                    await win.setSkipTaskbar(true);
                    emit('monitor-visibility-changed', { label, visible: false });
                } else {
                    // 唤醒：[关键] 强制在主进程调用 Show，确保窗口可见
                    await win.setSkipTaskbar(false);
                    // 如果窗口被最小化了，先还原
                    if (await win.isMinimized()) await win.unminimize();
                    
                    await win.show();
                    await win.setFocus();
                    
                    // 发送事件通知子窗口重启 WGC 会话
                    await emit('pip-wake', { target: label });
                    emit('monitor-visibility-changed', { label, visible: true });
                }
            } catch (e) {
                console.error("Toggle window failed:", e);
            }
        } else {
            // 如果不存在，创建
            openPip(src, true); 
        }
    };

    const openPip = async (src, startVisible = false) => {
        if (!wgcSupported) {
            alert("您的 Windows 版本过低 (需 Win10，Build 18362+)，不支持高性能画中画模式。");
            return;
        }
        const label = `monitor-${src.id}`;
        // [Issue 3] 传递 targetId (HWND) 到子窗口 URL
        let params = `?mode=mag&id=${src.id}&type=${src.type}&label=${encodeURIComponent(src.label)}&tid=${src.targetId || 0}`;
        if (src.crop) {
            params += `&x=${src.crop.x}&y=${src.crop.y}&w=${src.crop.w}&h=${src.crop.h}`;
        }
        
        new WebviewWindow(label, {
            url: `index.html${params}`,
            skipTaskbar: !startVisible, 
            title: src.label || 'Monitor',
            width: src.crop ? src.crop.w : 400, 
            height: src.crop ? src.crop.h : 300,
            minWidth: 50, minHeight: 50,
            transparent: true, // 关键：开启透明
            backgroundColor: "#00000000", // 关键：背景透明
            alwaysOnTop: true,
            decorations: false, // 无边框，我们自己画UI
            shadow: true,
            visible: false // 强制初始不可见，等待 ready 后手动 show
        });
        
        // 如果 startVisible 为 true，则在创建后稍作延时再显示，防止白屏
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
    };
    
    // [Issue 3] 修改：支持传入具体窗口信息，或者仅传 AppName (自动取最大的)
    const addAppSource = async (appGroup, specificWindow = null) => {
        setShowAppPicker(false);
        try {
            let label = appGroup.app_name;
            let crop = { x: 0, y: 0, w: 400, h: 300 };
            
            if (specificWindow) {
                // 如果选了特定子窗口，直接用它的尺寸，但 label 还是用 App 名以便后端查找 Handle (后端目前按名查找)
                // *注意*：目前的后端 get_window_hwnd 是按进程名找窗口的，如果要支持多窗口，后端逻辑其实不够完美。
                // 可以先用该尺寸初始化裁剪框。
                // 如果选了特定窗口，在前端记录它的 rect，并在 WGC 启动时作为 crop 参数。
                // 由于后端 get_window_hwnd 是遍历并返回第一个匹配尺寸的，我们这里传入 specificWindow 的 handle 最好。
                // 但 `start_wgc_session` 接受 `target_id`。
                
                label = specificWindow.title !== "Untitled Window" ? specificWindow.title : appGroup.app_name;
                
                // 直接使用该窗口的 HWND 作为 target_id
                const newSource = {
                    id: Date.now() + Math.floor(Math.random() * 1000),
                    type: 'native-app',
                    label: label, // UI显示名
                    // 这里存储具体的 HWND，后续传递给后端
                    targetId: specificWindow.hwnd, 
                    crop: { x: 0, y: 0, w: specificWindow.width, h: specificWindow.height }
                };
                
                setSources(prev => [...prev, newSource]);
                openPip(newSource, false);
                return;
            } 
            
            // 默认逻辑 (取第一个/最大的)
            const mainWin = appGroup.windows[0];
            if (mainWin) {
                crop = { x: 0, y: 0, w: mainWin.width, h: mainWin.height };
                const newSource = {
                    id: Date.now() + Math.floor(Math.random() * 1000),
                    type: 'native-app',
                    label: appGroup.app_name,
                    targetId: mainWin.hwnd, // 直接用 Handle
                    crop: crop
                };
                setSources(prev => [...prev, newSource]);
                openPip(newSource, false);
            }
        } catch (e) {
            console.error(e);
        }
    };

    return (
        <div className={`h-full flex flex-col p-4 space-y-4 ${isDark ? 'bg-[#1a1a1a]' : 'bg-gray-100'}`}>
            <div className="flex justify-between items-center shrink-0">
                <h2 className="text-xs font-bold opacity-70 uppercase tracking-wider">{t('监视器', 'Monitors')}</h2>
                <div className="flex gap-2">
                    <div className="relative">
                        <button onClick={loadApps} className="flex items-center gap-1 px-2.5 py-1.5 bg-teal-700/20 text-slate-400 hover:bg-teal-700 hover:text-white border border-slate-500/30 rounded-lg text-xs font-medium transition active:scale-95">
                            <Monitor size={12}/> {t('选择进程源', 'Pick App')}
                        </button>
                        {showAppPicker && (
                            <>
                                <div className="fixed inset-0 z-[9998]" onClick={() => setShowAppPicker(false)}></div>
                                <div className="fixed top-[150px] left-1/2 -translate-x-1/2 w-64 max-h-[300px] overflow-y-auto bg-[#252525] border border-white/20 rounded-xl shadow-2xl z-[9999] custom-scrollbar p-2">
                                    <div className="flex justify-between items-center px-2 pb-2 mb-2 border-b border-white/10">
                                        <span className="text-xs font-bold text-white">选择进程 (Select App)</span>
                                        <button onClick={() => setShowAppPicker(false)}><X size={12} className="text-white/50 hover:text-white"/></button>
                                    </div>
                                    {appTree.map(group => (
                                        <div key={group.app_name} className="mb-1">
                                            <div className="flex items-center w-full rounded hover:bg-slate-600 transition group">
                                                {/* 主按钮：默认添加主窗口 */}
                                                <button onClick={() => addAppSource(group)} className="flex-1 text-left px-3 py-2 text-xs text-gray-300 group-hover:text-white truncate">
                                                    {group.app_name}
                                                </button>
                                                {/* 展开按钮：如果有多个窗口 */}
                                                {group.windows.length > 1 && (
                                                    <button onClick={(e) => toggleExpand(group.app_name, e)} className="px-2 py-2 text-white/30 hover:text-white">
                                                        <span className={`block text-[10px] transform transition-transform ${expandedApps[group.app_name] ? 'rotate-180' : 'rotate-0'}`}>▼</span>
                                                    </button>
                                                )}
                                            </div>
                                            {/* 子列表 */}
                                            {expandedApps[group.app_name] && (
                                                <div className="pl-4 pr-1 py-1 space-y-1 bg-black/20 rounded-b border-l-2 border-white/10 ml-2">
                                                    {group.windows.map((win, idx) => (
                                                        <button key={idx} onClick={() => addAppSource(group, win)} className="w-full text-left px-2 py-1.5 text-[10px] text-gray-400 hover:bg-white/10 hover:text-teal-300 rounded flex justify-between items-center">
                                                            <span className="truncate flex-1 mr-2">{win.title}</span>
                                                            <span className="font-mono opacity-50 shrink-0">{win.width}x{win.height}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                    <button onClick={handleRegionCapture} className="flex items-center gap-1 px-3 py-1.5 bg-slate-500/20 text-slate-400 hover:bg-slate-500 hover:text-white border border-slate-500/30 rounded-lg text-xs font-medium transition active:scale-95">
                        <Crop size={12}/> {t('添加区域', 'Region')}
                    </button>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar grid grid-cols-1 gap-3 content-start pb-10">
                {sources.length === 0 ? (
                    <div className="col-span-2 flex flex-col items-center justify-center h-48 border-2 border-dashed border-gray-500/20 rounded-xl opacity-30 text-xs text-center">
                        <Layers size={32} className="mb-2"/>
                        <span>{t('暂无画面，请点击上方添加', 'No sources added.')}</span>
                    </div>
                ) : (
                    sources.map(src => (
                        <div key={src.id} className="relative bg-black rounded-lg overflow-hidden border border-white/10 group aspect-video">
                            <VideoPreview source={src} />
                            
                            {/* 状态指示点 (左上角) */}
                            {src.active && (
                                <div className="absolute top-1 left-1 w-2 h-2 bg-green-500 rounded-full shadow-md z-20 group-hover:opacity-0 transition-opacity" title="运行中" />
                            )}

                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-between p-2">
                                <span className="text-[10px] text-white truncate font-mono bg-black/30 px-1 rounded self-start">
                                    {src.label}
                                </span>
                                
                                <div className="flex justify-end gap-2 items-center">

                                    <button 
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            const newVal = !src.isMirror;
                                            setSources(prev => prev.map(s => s.id === src.id ? {...s, isMirror: newVal} : s));
                                            invoke('update_wgc_mirror', { label: `monitor-${src.id}`, mirror: newVal }).catch(()=>{});
                                        }}
                                        className={`p-1.5 rounded transition ${src.isMirror ? 'bg-indigo-600 text-white' : 'bg-white/10 text-white hover:bg-white/20'}`}
                                        title="镜像 (Mirror)"
                                    >
                                        <span className="text-[10px] font-bold">⇄</span>
                                    </button>

                                    {/* 灰度同步按钮 */}
                                    <button 
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            const newVal = !src.isGray;
                                            // 乐观更新本地状态
                                            setSources(prev => prev.map(s => s.id === src.id ? {...s, isGray: newVal} : s));
                                            // 发送指令给子窗口
                                            emit('sync-gray', { target: `monitor-${src.id}`, value: newVal });
                                        }}
                                        className={`p-1.5 rounded transition ${src.isGray ? 'bg-purple-600 text-white' : 'bg-white/10 text-white hover:bg-white/20'}`}
                                        title="同步灰度滤镜"
                                    >
                                        <Layers size={12}/>
                                    </button>

                                    {/* 唤醒/显示/隐藏 切换 */}
                                    <button 
                                        onClick={async () => {
                                            // 切换逻辑：如果 active 则隐藏，否则唤醒
                                            const label = `monitor-${src.id}`;
                                            // 这里做一个简单的状态切换假设，或者再次调用 ensurePipWindow
                                            // ensurePipWindow 内部已经有 toggle 逻辑
                                            ensurePipWindow(src);
                                            // 手动更新状态以获得即时反馈 (ensurePipWindow 内部涉及异步)
                                            setSources(prev => prev.map(s => s.id === src.id ? {...s, active: !s.active} : s));
                                        }} 
                                        className={`p-1.5 rounded transition text-white shadow-sm ${src.active ? 'bg-green-600 hover:bg-green-500' : 'bg-blue-600 hover:bg-blue-500'}`} 
                                        title={src.active ? "隐藏画中画" : "唤醒画中画"}
                                    >
                                        {src.active ? <Minimize2 size={12}/> : <Maximize2 size={12}/>}
                                    </button>
                                    
                                    <div className="w-[1px] h-3 bg-white/20 mx-0.5"></div>

                                    {/* 删除按钮 */}
                                    <button onClick={(e) => {
                                        e.preventDefault(); e.stopPropagation();
                                        setSources(prev => prev.filter(x => x.id !== src.id));
                                        emit('destroy-pip', { label: `monitor-${src.id}` });
                                    }} className="p-1.5 bg-red-600 text-white hover:bg-red-500 rounded transition shadow-sm" title="彻底删除">
                                        <X size={12}/>
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};