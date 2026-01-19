import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom'; // 新增
import { invoke } from '@tauri-apps/api/core';
import { AlertCircle, X, ChevronDown, Palette } from 'lucide-react';
import { HotkeyRecorder } from './MyComponents';

export const SettingsPanel = ({ 
    isDark, lang, setLang, settings, setSettings, 
    isGrayscale, setIsGrayscale, runningApps, 
    iccProfile, setIccProfile, t 
}) => {
    const [showAbout, setShowAbout] = useState(false);
    // [新增] 管理当前正在录制的组件ID，实现互斥
    const [activeRecorder, setActiveRecorder] = useState(null);
    
    // --- [新增] 多屏提示 Tooltip 逻辑 ---
    const [showMultiTip, setShowMultiTip] = useState(false);
    const [tipPos, setTipPos] = useState({ top: 0, left: 0 });
    const tipBtnRef = useRef(null);

    const handleTipEnter = () => {
        if (tipBtnRef.current) {
            const rect = tipBtnRef.current.getBoundingClientRect();
            // 简单计算：居中显示在按钮下方，稍微靠左一点防止溢出
            // 使用 fixed 定位，不受父容器滚动影响
            setTipPos({ 
                top: rect.bottom + 8, 
                left: Math.min(window.innerWidth - 220, Math.max(10, rect.left - 100)) // 智能限制左右边界
            });
            setShowMultiTip(true);
        }
    };
    // ----------------------------------

    // [新增] 智能更新热键，自动处理冲突
    const updateHotkey = (targetKey, newVal) => {
        setSettings(prev => {
            const next = { ...prev, [targetKey]: newVal };
            // 冲突检测：如果设置了新值（非清空），检查是否被其他键占用
            if (newVal) {
                const keysToCheck = ['hotkeyGray', 'hotkeyPick', 'hotkeyMonitor', 'hotkeyRegion', 'hotkeyRef', 'hotkeySyncKey', 'hotkeySyncPickKey'];
                keysToCheck.forEach(k => {
                    // 如果其他键的值等于当前设置的新值，则清空那个键（顶号逻辑）
                    if (k !== targetKey && next[k] === newVal) {
                        next[k] = ''; 
                    }
                });
            }
            return next;
        });
    };

    return (
        <div className="p-4 space-y-4 pb-10">
            
            {/* 顶部关于入口 */}
            <div className="flex justify-end -mb-2">
                <button 
                    onClick={() => setShowAbout(true)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all shadow-sm ${isDark ? 'bg-white/5 hover:bg-white/10 text-gray-300' : 'bg-black/5 hover:bg-black/10 text-gray-600'}`}
                >
                    <AlertCircle size={12} />
                    <span>{t('关于 Colori', 'About Colori')}</span>
                </button>
            </div>

            {/* 语言设置 */}
            <div className={`flex items-center justify-between p-3 rounded-xl ${isDark?'bg-white/5':'bg-black/5'}`}>
                <span className="text-xs">{t('语言', 'Language')}</span>
                <div className="flex bg-black/10 dark:bg-black/30 rounded-lg p-0.5">
                    <button onClick={() => setLang('zh')} className={`px-2 py-1 rounded text-[10px] transition ${lang === 'zh' ? 'bg-white shadow text-black' : 'opacity-40'}`}>中文</button>
                    <button onClick={() => setLang('en')} className={`px-2 py-1 rounded text-[10px] transition ${lang === 'en' ? 'bg-white shadow text-black' : 'opacity-40'}`}>EN</button>
                </div>
            </div>

            {/* 灰度模式设置 */}
            <div className={`p-3 rounded-xl ${isDark?'bg-white/5':'bg-black/5'} mb-4`}>
                <label className="text-xs opacity-70 block mb-2">{t('灰度模式', 'Grayscale Mode')}</label>
                <div className="flex gap-2">
                    <button onClick={() => setSettings({...settings, grayMode: 'system'})} className={`flex-1 py-1.5 rounded text-xs border transition ${settings.grayMode==='system' ? 'bg-slate-500 text-white border-slate-500 shadow-lg scale-[1.02]' : 'border-current opacity-40 hover:opacity-100'}`}>
                        {t('系统滤镜 (Win+Ctrl+C)', 'System Filter')}
                    </button>
                    <button onClick={() => setSettings({...settings, grayMode: 'custom'})} className={`flex-1 py-1.5 rounded text-xs border transition flex flex-col items-center justify-center leading-tight ${settings.grayMode==='custom' ? 'bg-slate-500 text-white border-slate-500 shadow-lg scale-[1.02]' : 'border-current opacity-40 hover:opacity-100'}`}>
                        <span>{t('灰度算法滤镜', 'Native Filter')}</span>
                        <span className="text-[9px] opacity-80">(Mag API)</span>
                    </button>
                </div>
                <div className="mt-2 text-[9px] opacity-40">
                    {settings.grayMode==='custom' ? t('(推荐)使用 Windows Magnification API 全屏灰度算法', '(Rec.)Uses Windows Mag API (Fix color drift by restart)') : t('触发 Windows 系统级快捷键 (Win+Ctrl+C)', 'Triggers Windows system shortcut')}
                </div>
            </div>

            {/* [需求1] 界面布局设置 */}
            <div className={`flex items-center justify-between p-3 rounded-xl mb-4 ${isDark?'bg-white/5':'bg-black/5'}`}>
                <div className="flex flex-col">
                    <span className="text-xs">{t('左手模式 (镜像布局)', 'Left-Handed Mode')}</span>
                    <span className="text-[9px] opacity-50">{t('开启后镜像显示色轮区域的按键排布', 'Mirror layout for right-handed pen display users')}</span>
                </div>
                <button onClick={() => setSettings({...settings, leftHanded: !settings.leftHanded})} className={`w-8 h-4 rounded-full flex items-center px-0.5 transition-colors ${settings.leftHanded ? 'bg-blue-500' : 'bg-gray-500/30'}`}>
                    <div className={`w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${settings.leftHanded ? 'translate-x-4' : 'translate-x-0'}`} />
                </button>
            </div>

            {/* 快捷键设置 */}
            <div className={`p-3 rounded-xl ${isDark?'bg-white/5':'bg-black/5'} space-y-2`}>
                <div className="flex justify-between items-center mb-1 pb-1 border-b border-gray-500/10">
                    <div className="flex items-center gap-2">
                        <label className="text-xs opacity-70 font-bold">{t('快捷键', 'Hotkeys')}</label>
                        {/* 帮助图标 */}
                        <div 
                            ref={tipBtnRef}
                            onMouseEnter={handleTipEnter}
                            onMouseLeave={() => setShowMultiTip(false)}
                            className="opacity-40 hover:opacity-100 cursor-help transition-opacity"
                        >
                            <AlertCircle size={10} />
                        </div>
                    </div>
                    
                    <div className="flex items-center gap-4">
                        <span className="text-[9px] opacity-40">{t('右键取消', 'R-Click Clear')}</span>
                        <span className="text-[9px] opacity-40 font-bold w-8 text-center">{t('全局', 'Global')}</span>
                    </div>
                </div>

                {/* Tooltip 渲染 (Portal 到 body，防止遮挡) */}
                {showMultiTip && createPortal(
                    <div 
                        className="fixed z-[9999] w-52 p-3 bg-[#1a1a1a] text-gray-200 text-[10px] rounded-lg border border-white/10 shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100 pointer-events-none"
                        style={{ top: tipPos.top, left: tipPos.left }}
                    >
                        <div className="font-bold text-teal-400 mb-1">{t('💡 多屏用户提示', '💡 Multi-Monitor Tip')}</div>
                        <div className="leading-relaxed opacity-90">
                            {t(
                                '进行屏幕取色、区域监控或截图参考时，请先将鼠标移至目标屏幕，再按下快捷键，即可在该屏幕触发。', 
                                'Hover mouse over the target screen BEFORE pressing hotkeys to capture content on that specific display.'
                            )}
                        </div>
                        {/* 小箭头装饰 (可选) */}
                        <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-[#1a1a1a] border-t border-l border-white/10 rotate-45"></div>
                    </div>,
                    document.body
                )}

                <div className="flex justify-between items-center text-xs h-7">
                    <span className="w-16 truncate">{t('黑白滤镜', 'Gray Filter')}</span>
                    <div className="flex-1 flex justify-end gap-3 items-center">
                        <HotkeyRecorder 
                            uniqueKey="hotkeyGray" activeRecorder={activeRecorder} onActivate={setActiveRecorder}
                            value={settings.hotkeyGray} onChange={(val) => updateHotkey('hotkeyGray', val)} 
                            placeholder="G" isDark={isDark} 
                        />
                        <div onClick={() => setSettings({...settings, globalGray: !settings.globalGray})} className={`w-8 h-4 rounded-full flex items-center px-0.5 cursor-pointer transition-colors ${settings.globalGray ? 'bg-slate-500' : 'bg-gray-500/30'}`}>
                            <div className={`w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${settings.globalGray ? 'translate-x-4' : 'translate-x-0'}`} />
                        </div>
                    </div>
                </div>

                <div className="flex justify-between items-center text-xs h-7">
                    <span className="w-16 truncate">{t('屏幕取色', 'Pick Color')}</span>
                    <div className="flex-1 flex justify-end gap-3 items-center">
                        <HotkeyRecorder 
                            uniqueKey="hotkeyPick" activeRecorder={activeRecorder} onActivate={setActiveRecorder}
                            value={settings.hotkeyPick} onChange={(val) => updateHotkey('hotkeyPick', val)} 
                            placeholder="SPACE" isDark={isDark} 
                        />
                        <div onClick={() => setSettings({...settings, globalPick: !settings.globalPick})} className={`w-8 h-4 rounded-full flex items-center px-0.5 cursor-pointer transition-colors ${settings.globalPick ? 'bg-slate-500' : 'bg-gray-500/30'}`}>
                            <div className={`w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${settings.globalPick ? 'translate-x-4' : 'translate-x-0'}`} />
                        </div>
                    </div>
                </div>

                <div className="flex justify-between items-center text-xs h-7">
                    <span className="w-16 truncate">{t('定点吸色', 'Monitor')}</span>
                    <div className="flex-1 flex justify-end gap-3 items-center">
                        <HotkeyRecorder 
                            uniqueKey="hotkeyMonitor" activeRecorder={activeRecorder} onActivate={setActiveRecorder}
                            value={settings.hotkeyMonitor} onChange={(val) => updateHotkey('hotkeyMonitor', val)} 
                            placeholder="F2" isDark={isDark} 
                        />
                        <div onClick={() => setSettings({...settings, globalMonitor: !settings.globalMonitor})} className={`w-8 h-4 rounded-full flex items-center px-0.5 cursor-pointer transition-colors ${settings.globalMonitor ? 'bg-slate-500' : 'bg-gray-500/30'}`}>
                            <div className={`w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${settings.globalMonitor ? 'translate-x-4' : 'translate-x-0'}`} />
                        </div>
                    </div>
                </div>

                <div className="flex justify-between items-center text-xs h-7">
                    <span className="w-16 truncate">{t('区域监控', 'Region Mon')}</span>
                    <div className="flex-1 flex justify-end gap-3 items-center">
                        <HotkeyRecorder 
                            uniqueKey="hotkeyRegion" activeRecorder={activeRecorder} onActivate={setActiveRecorder}
                            value={settings.hotkeyRegion} onChange={(val) => updateHotkey('hotkeyRegion', val)} 
                            placeholder="None" isDark={isDark} 
                        />
                        <div onClick={() => setSettings({...settings, globalRegion: !settings.globalRegion})} className={`w-8 h-4 rounded-full flex items-center px-0.5 cursor-pointer transition-colors ${settings.globalRegion ? 'bg-slate-500' : 'bg-gray-500/30'}`}>
                            <div className={`w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${settings.globalRegion ? 'translate-x-4' : 'translate-x-0'}`} />
                        </div>
                    </div>
                </div>

                <div className="flex justify-between items-center text-xs h-7">
                    <span className="w-16 truncate">{t('截图参考', 'Ref Capture')}</span>
                    <div className="flex-1 flex justify-end gap-3 items-center">
                        <HotkeyRecorder 
                            uniqueKey="hotkeyRef" activeRecorder={activeRecorder} onActivate={setActiveRecorder}
                            value={settings.hotkeyRef} onChange={(val) => updateHotkey('hotkeyRef', val)} 
                            placeholder="None" isDark={isDark} 
                        />
                        <div onClick={() => setSettings({...settings, globalRef: !settings.globalRef})} className={`w-8 h-4 rounded-full flex items-center px-0.5 cursor-pointer transition-colors ${settings.globalRef ? 'bg-slate-500' : 'bg-gray-500/30'}`}>
                            <div className={`w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${settings.globalRef ? 'translate-x-4' : 'translate-x-0'}`} />
                        </div>
                    </div>
                </div>

                <div className="flex justify-between items-center text-xs h-7">
                    <span className="w-16 truncate">{t('面板显隐', 'Toggle Main')}</span>
                    <div className="flex-1 flex justify-end gap-3 items-center">
                        <HotkeyRecorder 
                            uniqueKey="hotkeyShowHide" activeRecorder={activeRecorder} onActivate={setActiveRecorder}
                            value={settings.hotkeyShowHide} onChange={(val) => updateHotkey('hotkeyShowHide', val)} 
                            placeholder="None" isDark={isDark} 
                        />
                        <div onClick={() => setSettings({...settings, globalShowHide: !settings.globalShowHide})} className={`w-8 h-4 rounded-full flex items-center px-0.5 cursor-pointer transition-colors ${settings.globalShowHide ? 'bg-slate-500' : 'bg-gray-500/30'}`}>
                            <div className={`w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${settings.globalShowHide ? 'translate-x-4' : 'translate-x-0'}`} />
                        </div>
                    </div>
                </div>

                {/* [新增] 面板隐藏联动吸色 */}
                <div className="flex justify-end items-center gap-2 -mt-1 pr-11">
                    <span className="text-[9px] opacity-40">{t('隐藏时自动吸色', 'Sync on Hide')}</span>
                    <input 
                        type="checkbox" 
                        checked={settings.syncOnToggle || false}
                        onChange={(e) => setSettings({...settings, syncOnToggle: e.target.checked})}
                        title={t("通过快捷键隐藏面板时，会自动向目标软件发送一次吸色指令 (需配合下方应用同步设置)", "Trigger color sync macro automatically when hiding panel via hotkey.")}
                        className="w-3 h-3 rounded border-gray-500/30 accent-slate-500 cursor-pointer"
                    />
                </div>
                
                <div className={`mt-2 pt-2 border-t border-gray-500/10 space-y-3`}>
                    {/* [优化] 增加管理员权限提示 & 输入法警告 */}
                    <div className="bg-yellow-500/10 border border-yellow-500/20 rounded p-2 mb-2 flex flex-col gap-1.5">
                        <span className="text-[9px] text-yellow-500/80 flex gap-1 leading-tight">
                            ⚠️ {t('提示：如果吸色在 Photoshop 等软件中不生效，请尝试以“管理员身份运行”本软件。', 'Tip: Run as Administrator if sync fails in apps like Photoshop.')}
                        </span>
                        <span className="text-[9px] text-yellow-500/80 flex gap-1 leading-tight pl-3.5 opacity-90">
                            * {t('建议“目标软件取色键”避开有字母的快捷键，以免触发输入法。', 'Avoid letters or Modifier+Letter to prevent conflicts. ')}
                        </span>
                    </div>

                    <div className="flex justify-between items-center">
                        <div className="flex flex-col">
                            <span className="text-xs font-bold">{t('跨应用吸色同步', 'Auto-Dropper Sync')}</span>
                            <span className="text-[9px] opacity-50">{t('在目标软件按键时自动吸取当前色', 'Auto pick color into app')}</span>
                        </div>
                        <button onClick={() => setSettings({...settings, hotkeySyncEnabled: !settings.hotkeySyncEnabled})} className={`w-8 h-4 rounded-full flex items-center px-0.5 transition-colors ${settings.hotkeySyncEnabled ? 'bg-green-500' : 'bg-gray-500/30'}`}>
                            <div className={`w-3 h-3 bg-white rounded-full shadow-sm transition-transform duration-200 ${settings.hotkeySyncEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                        </button>
                    </div>

                    {settings.hotkeySyncEnabled && (
                        <div className="space-y-2 pl-2 border-l-2 border-gray-500/10">
                            <div className="flex justify-between items-center text-xs">
                                <span>{t('触发按键', 'Trigger Key')}</span>
                                <HotkeyRecorder 
                                    uniqueKey="hotkeySyncKey" activeRecorder={activeRecorder} onActivate={setActiveRecorder}
                                    value={settings.hotkeySyncKey} onChange={(val) => updateHotkey('hotkeySyncKey', val)} 
                                    placeholder="None" isDark={isDark} 
                                />
                            </div>
                            <div className="flex justify-between items-center text-xs">
                                <span>{t('目标软件屏幕拾色快捷键', 'Target Software Pick Key')}</span>
                                <HotkeyRecorder 
                                    uniqueKey="hotkeySyncPickKey" activeRecorder={activeRecorder} onActivate={setActiveRecorder}
                                    value={settings.hotkeySyncPickKey} onChange={(val) => updateHotkey('hotkeySyncPickKey', val)} 
                                    placeholder="None" isDark={isDark} 
                                />
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between items-center">
                                    <span className="text-xs opacity-70">{t('仅在以下应用中生效:', 'Only in App:')}</span>
                                    <button onClick={async () => {
                                        const apps = await invoke('get_running_apps');
                                        if(window.__TAURI__) {
                                            const { emit } = await import('@tauri-apps/api/event');
                                            emit('refresh-apps-list', apps);
                                        }
                                    }} className="text-[9px] text-blue-400 hover:underline cursor-pointer">{t('刷新', 'Refresh')}</button>
                                </div>
                                <select value={settings.hotkeySyncApp} onChange={(e) => setSettings({...settings, hotkeySyncApp: e.target.value})} className={`w-full text-[10px] p-1.5 rounded border ${isDark ? 'bg-[#2a2a2a] border-white/10' : 'bg-white border-black/10'}`}>
                                    <option value="">{t('全局生效 (不推荐)', 'Global (Any App)')}</option>
                                    {runningApps.map(app => (
                                        <option key={app} value={app}>{app}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    )}
                </div> 
            </div>

            {/* ICC 配置 */}
            <div className={`p-3 rounded-xl ${isDark?'bg-white/5':'bg-black/5'}`}>
                <div className="flex justify-between items-center mb-2">
                    <label className="text-xs opacity-70">{t('ICC 灰度配置', 'ICC Profile')}</label>
                    <label className="text-[9px] px-2 py-1 bg-slate-500/10 hover:bg-slate-500 hover:text-white rounded cursor-pointer transition">
                        {t('导入配置 (JSON)', 'Import JSON')}
                        <input type="file" accept=".json,.txt" className="hidden" onChange={(e) => {
                            const file = e.target.files[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = (ev) => {
                                try {
                                    const json = JSON.parse(ev.target.result);
                                    if (typeof json.r === 'number' && typeof json.g === 'number' && typeof json.b === 'number' && json.name) {
                                        // [新增] 持久化保存
                                        localStorage.setItem('colori_custom_icc', JSON.stringify(json));
                                        alert(t("导入成功 (即将刷新): " + json.name, "Imported: " + json.name));
                                        window.location.reload(); // 自动刷新
                                    } else {
                                        alert("Invalid JSON: r/g/b must be numbers.");
                                    }
                                } catch(err) { alert("Parse Error"); }
                            };
                            reader.readAsText(file);
                        }}/>
                    </label>
                </div>
                <div className="space-y-2">
                    <div className="relative">
                        <select value={iccProfile} onChange={(e) => setIccProfile(e.target.value)} className={`w-full appearance-none border rounded text-xs p-2 outline-none ${isDark ? 'bg-[#2a2a2a] border-white/10 text-white' : 'bg-white border-black/10 text-black'}`}>
                            <option value="rec601">Rec.601 (SDTV / Default)</option>
                            <option value="bt709">ITU-R BT.709 (HDTV)</option>
                            <option value="average">Linear Average (1/3)</option>
                            {/* [新增] 动态渲染自定义选项 */}
                            {(() => {
                                try {
                                    const c = JSON.parse(localStorage.getItem('colori_custom_icc'));
                                    if(c) return <option value="custom">{c.name} (Custom)</option>;
                                } catch(e){}
                            })()}
                        </select>
                    </div>
                </div>
            </div>

            {/* 关于弹窗 (修改版) */}
            {showAbout && (
                <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-8" onClick={() => setShowAbout(false)}>
                    <div 
                        className={`w-full max-w-sm max-h-[80vh] overflow-y-auto custom-scrollbar rounded-2xl shadow-2xl border ${isDark ? 'bg-[#1e1e1e] border-white/10 text-gray-200' : 'bg-white border-black/10 text-gray-800'} p-6 relative`}
                        onClick={e => e.stopPropagation()}
                    >
                        <button onClick={() => setShowAbout(false)} className="absolute top-4 right-4 opacity-50 hover:opacity-100 transition">
                            <X size={16} />
                        </button>

                        <div className="flex flex-col items-center mb-6">
                            {/* 修改：使用 Palette 图标，配色统一，尺寸缩小 */}
                            <div className="w-10 h-10 bg-gradient-to-tr from-blue-500 to-purple-500 rounded-xl shadow-lg mb-3 flex items-center justify-center text-white">
                                <Palette size={20} />
                            </div>
                            <h2 className="text-xl font-bold tracking-wide">Colori</h2>
                            <span className="text-[10px] opacity-50 font-mono mt-1">v1.1.1 (Offline)</span>
                        </div>

                        <div className="space-y-4">
                            {/* 声明 (修改版) */}
                            <div className={`p-5 rounded-xl ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
                                <div className="text-xs space-y-2 leading-relaxed opacity-80">
                                    <p>作者：<span className="font-bold">枣</span></p>
                                    <p>主页：<a href="#" className="text-blue-400 hover:underline break-all">https://github.com/fuwa277/Colori-iris</a></p>
                                    <div className="w-full h-[1px] bg-current opacity-10 my-3"></div>
                                    {/* 加粗免费声明，删除“仅供学习交流”，添加禁止盈利 */}
                                    <p><span className="font-bold text-sm">本软件为免费发布</span></p>
                                    <p className="text-red-400/90 font-bold text-sm">不得售卖此软件进行盈利</p>
                                    
                                    {/* 免责声明 */}
                                    <div className="mt-3 pt-3 border-t border-current/10">
                                        <p className="font-bold mb-1 opacity-70">免责声明 (Disclaimer):</p>
                                        <ul className="list-disc pl-3 space-y-1 opacity-60 text-[9px]">
                                            <li>请务必从官方渠道 (GitHub/小红书主页) 下载，非本人发布渠道获取的软件版本无法保证安全性，可能存在被篡改风险，后果由用户自行承担。</li>
                                            <li>严禁利用本软件从事任何违反法律法规的活动。</li>
                                        </ul>
                                    </div>

                                    <div className="mt-3 text-[10px] opacity-50">Design & Code by 枣. All Rights Reserved.</div>
                                </div>
                            </div>

                            {/* 使用说明 (修改颜色) */}
                            {/* 使用 slate-200/slate-800 模拟灰蓝色调，增加辨识度 */}
                            <div className={`rounded-xl overflow-hidden border ${isDark ? 'bg-slate-800/80 border-slate-600' : 'bg-slate-200/80 border-slate-300'}`}>
                                <details className="group">
                                    <summary className={`flex items-center justify-between p-3 cursor-pointer select-none transition-colors ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}>
                                        <span className={`text-xs font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>使用说明</span>
                                        <ChevronDown size={12} className="transform transition-transform group-open:rotate-180 opacity-50" />
                                    </summary>
                                    <div className={`px-3 pb-3 text-[10px] space-y-2 leading-relaxed border-t ${isDark ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-700'}`}>
                                        <p>1. <b className="text-teal-500">调色板</b>：支持 同灰度自由选色/RGB/HSV/CMYK/LAB 多模式切换，支持拖拽调节。</p>
                                        <p>2. <b className="text-teal-500">屏幕监视</b>：点击「选择进程源」可开启高性能画中画 (Win10+)，支持镜像与灰度预览。</p>
                                        <p>3. <b className="text-teal-500">定点吸色</b>：锁定屏幕坐标，实时监测像素颜色，该颜色会同步到监控色槽内方便选取。</p>
                                        <p>4. <b className="text-teal-500">灰度滤镜</b>：支持系统级 (Win+Ctrl+C) 与灰度算法滤镜 (Mag API) 两种去色模式，推荐灰度算法滤镜+Rec.601灰度配置，更符合人眼视觉。</p>
                                        <p>5. <b className="text-teal-500">参考图</b>：在此可创建多张参考图，具体说明请看参考页背景说明文字。</p>
                                    </div>
                                </details>
                            </div>
                        </div>

                        <div className="mt-6 text-center">
                            <span className="text-[9px] opacity-30">Designed for Designers & Developers</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};