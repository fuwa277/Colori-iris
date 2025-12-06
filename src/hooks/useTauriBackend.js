import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

/**
 * 处理与 Rust 后端的复杂交互：
 * 1. 启动全局热键监听
 * 2. 轮询当前颜色块的屏幕坐标 (用于 Rust 模拟点击)
 */
export const useTauriBackend = () => {
    const colorBlockRef = useRef(null);

    // 1. 启动全局热键监听 (只执行一次)
    useEffect(() => {
        invoke('start_global_hotkey_listener').catch(console.error);
    }, []);

    // 2. 坐标同步逻辑 (替代原本嵌在 JSX ref 中的代码)
    useEffect(() => {
        let syncInterval;

        const updateCoords = async () => {
            if (colorBlockRef.current) {
                try {
                    const rect = colorBlockRef.current.getBoundingClientRect();
                    const winPos = await appWindow.outerPosition();
                    
                    // Fix 7: 兼容 DPI 缩放 (DOM Rect 是逻辑像素，winPos 是物理像素)
                    const dpr = window.devicePixelRatio || 1;
                    const screenX = Math.round(winPos.x + (rect.left + rect.width / 2) * dpr);
                    const screenY = Math.round(winPos.y + (rect.top + rect.height / 2) * dpr);
                    
                    await invoke('update_sync_coords', { x: screenX, y: screenY });
                } catch (e) {
                    // 忽略窗口关闭或最小化时的错误
                }
            }
        };

        // 启动轮询
        syncInterval = setInterval(updateCoords, 1000);
        // 立即执行一次
        updateCoords();

        return () => clearInterval(syncInterval);
    }, []);

    return { colorBlockRef };
};