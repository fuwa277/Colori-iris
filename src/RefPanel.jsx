import React, { useState, useRef, useEffect } from 'react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core'; // Fix 8
// [修复 Issue 2] 移除缺失的前端插件引用
// import { readImage } from '@tauri-apps/plugin-clipboard-manager'; 
import { Copy, Crop, Image as ImageIcon } from 'lucide-react';

export const RefPanel = ({ isDark, t, refIgnoreMouse, setRefIgnoreMouse }) => {
    // 错误提示状态管理
    const [errorMsg, setErrorMsg] = useState(null);
    const timerRef = useRef(null);

    const showError = (msg) => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setErrorMsg(msg);
        // 3秒后自动消失
        timerRef.current = setTimeout(() => setErrorMsg(null), 3000);
    };

    // 组件卸载时清理定时器
    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

    return (
        <div className="flex flex-col h-full p-4 space-y-4 relative">
            {/* 自定义应用内错误提示 (替代 alert) */}
            {errorMsg && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[100] w-max max-w-[90%]">
                    <div className="bg-red-600/90 text-white text-[10px] px-3 py-2 rounded shadow-xl flex items-center gap-2 animate-in fade-in slide-in-from-top-2 border border-white/10 backdrop-blur-sm">
                        <span className="font-bold">!</span>
                        <span>{errorMsg}</span>
                    </div>
                </div>
            )}

            <div className={`p-4 rounded-xl border ${isDark?'bg-white/5 border-white/5':'bg-black/5 border-black/5'} flex items-center justify-between`}>
                <div className="flex flex-col max-w-[80%]">
                    <span className="text-xs font-bold">{t('鼠标穿透模式', 'Click-Through')}</span>
                    <span className="text-[9px] opacity-50 leading-tight mt-0.5">
                        {t('开启后窗口将完全忽略鼠标事件', 'Window ignores all events.')}
                        <br/>
                        {t('(需在面板关闭穿透以恢复控制)', '(Toggle off here to control)')}
                    </span>
                </div>
                <button onClick={() => setRefIgnoreMouse(!refIgnoreMouse)} className={`w-10 h-5 rounded-full relative transition-colors shrink-0 ${refIgnoreMouse ? 'bg-slate-500' : 'bg-gray-500/50'}`} title={t("切换所有参考窗口的鼠标穿透", "Toggle for all ref windows")}>
                    <div className={`absolute top-1 w-3 h-3 bg-white rounded-full shadow-sm transition-all ${refIgnoreMouse ? 'left-6' : 'left-1'}`} />
                </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <button onClick={async () => {
                        // [修复 Issue 2] 调用后端命令直接读取剪贴板并保存，无需前端插件
                        try {
                            const filePath = await invoke('save_clipboard_to_temp');
                            
                            // 读取图片尺寸以设置窗口比例 (前端读取一次 base64 获取尺寸)
                            // 虽然多了一次 IPC，但能保证窗口比例正确
                            const base64 = await invoke('read_image_as_base64', { path: filePath });
                            const img = new Image();
                            img.onload = () => {
                                const ratio = img.height / img.width;
                                const winW = 300; 
                                const winH = Math.round(winW * ratio);
                                
                                new WebviewWindow(`ref-clip-${Date.now()}`, {
                                    url: `index.html?path=${encodeURIComponent(filePath)}`, 
                                    title: 'Ref',
                                    width: winW, height: winH,
                                    decorations: false, transparent: true, alwaysOnTop: true, skipTaskbar: false
                                });
                            };
                            img.src = base64;

                        } catch(e) { 
                            console.error("Clipboard Action Failed:", e);
                            const errStr = String(e);
                            let displayMsg = "";
                            
                            // 双语错误匹配与翻译
                            // 如果错误信息包含 empty (为空) 或 not available (不可用)
                            if (errStr.toLowerCase().includes("empty") || errStr.toLowerCase().includes("not available")) {
                                displayMsg = t("剪贴板为空或非图片数据", "Clipboard is empty or contains no image");
                            } else {
                                // 其他错误，截取前50个字符防止提示条过长
                                const shortErr = errStr.length > 50 ? errStr.substring(0, 50) + "..." : errStr;
                                displayMsg = t("读取失败: ", "Error: ") + shortErr;
                            }
                            showError(displayMsg); 
                        }
                    }}
                    className={`h-24 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed transition active:scale-95 ${isDark ? 'border-white/10 hover:bg-white/5' : 'border-black/10 hover:bg-black/5'}`}
                >
                    <div className="p-2 rounded-full bg-slate-500/10 text-slate-500"><Copy size={20}/></div>
                    <span className="text-xs font-bold">{t('从剪贴板新建', 'From Clipboard')}</span>
                </button>

                <button onClick={() => {
                        // [修复] 动态 Label
                        new WebviewWindow(`selector-shot-${Date.now()}`, {
                            url: 'index.html?mode=screenshot',
                            transparent: true, fullscreen: true, alwaysOnTop: true, 
                            skipTaskbar: true, decorations: false, resizable: false,
                            visible: false
                        });
                    }}
                    className={`h-24 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed transition active:scale-95 ${isDark ? 'border-white/10 hover:bg-white/5' : 'border-black/10 hover:bg-black/5'}`}
                >
                    <div className="p-2 rounded-full bg-slate-500/10 text-purple-500"><Crop size={20}/></div>
                    <span className="text-xs font-bold">{t('截图参考', 'Screenshot Ref')}</span>
                </button>
            </div>

            {/* Fix 1: 改为点击上传 (Input File) */}
            <div 
                className={`h-24 rounded-xl border-2 border-dashed flex flex-col items-center justify-center transition-colors cursor-pointer ${isDark ? 'border-white/10 hover:border-slate-500/50 hover:bg-white/5' : 'border-black/10 hover:border-slate-500/50 hover:bg-black/5'}`}
                onClick={() => document.getElementById('ref-upload-input').click()}
            >
                <input 
                    type="file" 
                    id="ref-upload-input" 
                    className="hidden" 
                    accept="image/*"
                    onChange={(e) => {
                        const file = e.target.files[0];
                        if (file) {
                            const reader = new FileReader();
                            reader.onload = async (ev) => {
                                const dataUrl = ev.target.result;
                                // Fix 8: 写入临时文件，防止 LocalStorage 溢出
                                const filePath = await invoke('save_temp_image', { dataUrl });
                                
                                const img = new Image();
                                img.onload = () => {
                                    const ratio = img.height / img.width;
                                    const winW = 300; const winH = Math.round(winW * ratio);
                                    
                                    // [修复 Issue 1] 通过 URL 传递路径
                                    new WebviewWindow(`ref-file-${Date.now()}`, {
                                        url: `index.html?path=${encodeURIComponent(filePath)}`, 
                                        width: winW, height: winH,
                                        decorations: false, transparent: true, alwaysOnTop: true, skipTaskbar: false
                                    });
                                };
                                img.src = dataUrl;
                            };
                            reader.readAsDataURL(file);
                        }
                        // 重置 input 防止重复选择同一文件不触发
                        e.target.value = '';
                    }}
                />
                <div className="opacity-50"><ImageIcon size={24}/></div>
                <span className="text-[10px] mt-2 opacity-50">{t('点击上传图片新建参考', 'Click to Upload Ref')}</span>
            </div>
            <div className="text-[10px] opacity-40 text-center mt-2 px-4 space-y-1">
                <div>{t('提示: 开启穿透后，参考图将无法响应鼠标，请在此处关闭穿透以移动或缩放图片', 'Note: When Ignore Mouse is ON, use this switch to regain control.')}</div>
                <div>{t('滚轮: 缩放图片 | 右键: 拖拽图片 | 左键: 拖拽窗口', 'Wheel: Zoom | R-Click: Pan Image | L-Click: Drag Window')}</div>
            </div>
        </div>
    );
};