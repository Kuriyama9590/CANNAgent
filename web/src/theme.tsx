import { createContext, useContext } from 'react';

/** 全局明暗主题上下文（由 App 提供） */
export const ThemeCtx = createContext(false);

export const useDark = (): boolean => useContext(ThemeCtx);

/** 主色：终端青（替代 AntD 默认蓝，明暗两套下都成立） */
export const ACCENT = '#06b6d4';
