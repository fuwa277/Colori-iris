import React from 'react';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Copy, Crop, Image as ImageIcon } from 'lucide-react';

export const RefPanel = ({ isDark, t, refIgnoreMouse, setRefIgnoreMouse }) => {
    return (
        <div className="flex flex-col h-full p-4 space-y-4">
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
                        try {
                            const clipboardItems = await navigator.clipboard.read();
                            for (const item of clipboardItems) {
                                if (item.types.some(type => type.startsWith('image/'))) {
                                    const blob = await item.getType(item.types.find(type => type.startsWith('image/')));
                                    const reader = new FileReader();
                                    reader.onload = (e) => {
                                        const dataUrl = e.target.result;
                                        const img = new Image();
                                        img.onload = () => {
                                            const ratio = img.height / img.width;
                                            const winW = 300; const winH = Math.round(winW * ratio);
                                            localStorage.setItem('ref-temp-img', dataUrl);
                                            new WebviewWindow(`ref-clip-${Date.now()}`, {
                                                url: 'index.html', title: 'Ref',
                                                width: winW, height: winH,
                                                decorations: false, transparent: true, alwaysOnTop: true, skipTaskbar: false
                                            });
                                        };
                                        img.src = dataUrl;
                                    };
                                    reader.readAsDataURL(blob);
                                    return;
                                }
                            }
                            alert(t("剪贴板中没有图片", "No image in clipboard"));
                        } catch(e) { alert(t("无法读取剪贴板", "Clipboard Error")); }
                    }}
                    className={`h-24 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed transition active:scale-95 ${isDark ? 'border-white/10 hover:bg-white/5' : 'border-black/10 hover:bg-black/5'}`}
                >
                    <div className="p-2 rounded-full bg-slate-500/10 text-slate-500"><Copy size={20}/></div>
                    <span className="text-xs font-bold">{t('从剪贴板新建', 'From Clipboard')}</span>
                </button>

                <button onClick={() => {
                        new WebviewWindow('selector-shot', {
                            url: 'index.html?mode=screenshot',
                            transparent: true, fullscreen: true, alwaysOnTop: true, 
                            skipTaskbar: true, decorations: false, resizable: false,
                            visible: false // 修复: 初始隐藏，防止白屏
                        });
                    }}
                    className={`h-24 flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed transition active:scale-95 ${isDark ? 'border-white/10 hover:bg-white/5' : 'border-black/10 hover:bg-black/5'}`}
                >
                    <div className="p-2 rounded-full bg-slate-500/10 text-purple-500"><Crop size={20}/></div>
                    <span className="text-xs font-bold">{t('截图参考', 'Screenshot Ref')}</span>
                </button>
            </div>

            <div className={`h-24 rounded-xl border-2 border-dashed flex flex-col items-center justify-center transition-colors ${isDark ? 'border-white/10 hover:border-slate-500/50 hover:bg-white/5' : 'border-black/10 hover:border-slate-500/50 hover:bg-black/5'}`}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={(e) => {
                    e.preventDefault(); e.stopPropagation();
                    const file = e.dataTransfer.files[0];
                    if (file && file.type.startsWith('image/')) {
                            const reader = new FileReader();
                            reader.onload = (ev) => {
                                const dataUrl = ev.target.result;
                                const img = new Image();
                                img.onload = () => {
                                    const ratio = img.height / img.width;
                                    const winW = 300; const winH = Math.round(winW * ratio);
                                    localStorage.setItem('ref-temp-img', dataUrl);
                                    new WebviewWindow(`ref-drop-${Date.now()}`, {
                                        url: 'index.html', width: winW, height: winH,
                                        decorations: false, transparent: true, alwaysOnTop: true, skipTaskbar: false
                                    });
                                };
                                img.src = dataUrl;
                            };
                            reader.readAsDataURL(file);
                    }
                }}
            >
                <div className="opacity-50"><ImageIcon size={24}/></div>
                <span className="text-[10px] mt-2 opacity-50">{t('拖拽图片到此处新建参考', 'Drag Image Here')}</span>
            </div>
            <div className="text-[10px] opacity-40 text-center mt-2 px-4 space-y-1">
                <div>{t('提示: 开启穿透后，参考图将无法响应鼠标，请在此处关闭穿透以移动或缩放图片', 'Note: When Ignore Mouse is ON, use this switch to regain control.')}</div>
                <div>{t('滚轮: 缩放图片 | 右键: 拖拽图片 | 左键: 拖拽窗口', 'Wheel: Zoom | R-Click: Pan Image | L-Click: Drag Window')}</div>
            </div>
        </div>
    );
};