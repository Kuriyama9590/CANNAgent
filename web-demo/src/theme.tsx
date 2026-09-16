import { createContext, useContext } from 'react';

/** 全局明暗主题上下文（由 App 提供） */
export const ThemeCtx = createContext(false);

export const useDark = (): boolean => useContext(ThemeCtx);
