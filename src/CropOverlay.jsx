import React, { useState, useEffect } from 'react';
import { RegionSelector } from './MyComponents';

export const CropOverlay = ({ isCropping, onConfirm, onCancel, sourceConfig, windowSize }) => {
    if (!isCropping || !sourceConfig) return null;

    return (
        <div className="absolute inset-0 z-[100]" onMouseDown={e => e.stopPropagation()}>
            <RegionSelector 
                onConfirm={(rect) => {
                    // 计算逻辑：将 UI 上的选区转换为相对于源画面的坐标
                    // 假设窗口当前显示的是完整的 sourceConfig 区域
                    const scaleX = sourceConfig.w / windowSize.width;
                    const scaleY = sourceConfig.h / windowSize.height;

                    const relativeRect = {
                        x: Math.round(rect.x * scaleX),
                        y: Math.round(rect.y * scaleY),
                        w: Math.round(rect.w * scaleX),
                        h: Math.round(rect.h * scaleY)
                    };
                    
                    // 最终坐标 = 源起点 + 相对位移
                    const finalConfig = {
                        ...sourceConfig,
                        x: sourceConfig.x + relativeRect.x,
                        y: sourceConfig.y + relativeRect.y,
                        w: relativeRect.w,
                        h: relativeRect.h
                    };
                    
                    onConfirm(finalConfig);
                }} 
                onCancel={onCancel} 
            />
            <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-teal-600 text-white text-[10px] px-2 py-1 rounded shadow-lg pointer-events-none whitespace-nowrap">
                二次裁剪: 框选保留区域
            </div>
        </div>
    );
};