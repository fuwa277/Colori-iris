// src/colorLogic.js
import { converter } from 'culori';

// 初始化转换器
const culoriLab = converter('lab');
const culoriRgb = converter('rgb');
const culoriCmyk = converter('cmyk');

// --- 核心算法库 ---
export const LUMA_ALGORITHMS = {
    'rec601':  { r: 0.299,  g: 0.587,  b: 0.114, name: 'Rec.601 (SDTV)' },
    'bt709':   { r: 0.2126, g: 0.7152, b: 0.0722, name: 'BT.709 (HDTV)' },
    'average': { r: 0.3333, g: 0.3333, b: 0.3333, name: 'Average (Linear)' }
};

// Gamma 2.2 correction functions
export const toLinear = (v) => Math.pow(v, 2.2);
export const toGamma = (v) => Math.pow(v, 1 / 2.2);

// Rec. 601 Luma (0-1)
export const getLuminance = (r, g, b, alg = 'rec601') => {
  // 鲁棒性修复：确保 coeffs 存在且包含 r,g,b
  let coeffs = LUMA_ALGORITHMS[alg];
  if (!coeffs || typeof coeffs.r !== 'number') coeffs = LUMA_ALGORITHMS['rec601'];
  
  const R = toLinear(r / 255);
  const G = toLinear(g / 255);
  const B = toLinear(b / 255);
  return coeffs.r * R + coeffs.g * G + coeffs.b * B;
};

// HSV/RGB conversions (Standard)
export const rgbToHsv = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (max === min) h = 0;
  else {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, v: v * 100 };
};

export const hsvToRgb = (h, s, v) => {
  let r, g, b;
  const i = Math.floor(h / 60);
  const f = h / 60 - i;
  const S = s / 100;
  const V = v / 100;
  const p = V * (1 - S);
  const q = V * (1 - f * S);
  const t = V * (1 - (1 - f) * S);
  switch (i % 6) {
    case 0: r = V; g = t; b = p; break;
    case 1: r = q; g = V; b = p; break;
    case 2: r = p; g = V; b = t; break;
    case 3: r = p; g = q; b = V; break;
    case 4: r = t; g = p; b = V; break;
    case 5: r = V; g = p; b = q; break;
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
};

const componentToHex = (c) => {
  const hex = Math.round(c).toString(16);
  return hex.length === 1 ? "0" + hex : hex;
};
export const rgbToHex = (r, g, b) => "#" + componentToHex(r) + componentToHex(g) + componentToHex(b);
export const hexToRgb = (hex) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : null;
};

// CMYK
export const rgbToCmyk = (r, g, b) => {
  if (r === 0 && g === 0 && b === 0) return { c: 0, m: 0, y: 0, k: 100 };
  
  let c = 1 - (r / 255);
  let m = 1 - (g / 255);
  let y = 1 - (b / 255);
  let k = Math.min(c, m, y);
  
  c = (c - k) / (1 - k) || 0;
  m = (m - k) / (1 - k) || 0;
  y = (y - k) / (1 - k) || 0;
  
  return { 
    c: Math.round(c * 100), 
    m: Math.round(m * 100), 
    y: Math.round(y * 100), 
    k: Math.round(k * 100) 
  };
};
// Inverse CMYK approximation
export const cmykToRgb = (c, m, y, k) => {
  c/=100; m/=100; y/=100; k/=100;
  const r = 255 * (1 - c) * (1 - k);
  const g = 255 * (1 - m) * (1 - k);
  const b = 255 * (1 - y) * (1 - k);
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
};

// LAB (Powered by Culori)
export const rgbToLab = (r, g, b) => {
  // culori 接收 0-1 的 RGB
  const lab = culoriLab({ mode: 'rgb', r: r/255, g: g/255, b: b/255 });
  // 返回标准 LAB 值 (L: 0-100, a/b: -128~128 approx)
  return { l: lab.l, a: lab.a, b: lab.b };
};

// 导出转换器供 Slider 使用
export { culoriLab, culoriRgb, culoriCmyk };