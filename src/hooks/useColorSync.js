import { useState, useEffect, useRef } from 'react';

export const useColorSync = (hex, activeSlot) => {
    // 从本地存储读取上次的同步状态，默认为 false
    const [isSyncing, setIsSyncing] = useState(() => {
        try {
            return JSON.parse(localStorage.getItem('colori_sync_enabled') || 'false');
        } catch { return false; }
    });

    // 记录上一次的颜色，避免重复写入
    const lastHex = useRef(hex);

    // 状态持久化
    useEffect(() => {
        localStorage.setItem('colori_sync_enabled', JSON.stringify(isSyncing));
    }, [isSyncing]);

    // 核心同步逻辑
    useEffect(() => {
        if (!isSyncing) return;

        // 只有当颜色真的改变时才写入剪贴板
        if (hex !== lastHex.current) {
            navigator.clipboard.writeText(hex).catch(err => {
                console.warn("Clipboard write failed:", err);
            });
            lastHex.current = hex;
        }
    }, [hex, activeSlot, isSyncing]);

    return { isSyncing, setIsSyncing };
};