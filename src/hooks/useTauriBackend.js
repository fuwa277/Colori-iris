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
                    // 直接调用后端获取当前物理坐标并更新，避免前端 DPI 计算误差
                    const pos = await invoke('get_mouse_pos');
                    await invoke('update_sync_coords', { x: pos[0], y: pos[1] });
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