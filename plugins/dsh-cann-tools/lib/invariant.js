export const ERROR_CODES = {
    /** python CLI 非零退出（message 携带官方错误码时原样保留） */
    PYTHON_EXIT: 'CANN_E_PYTHON_EXIT',
    /** python 输出非合法 JSON */
    BAD_OUTPUT: 'CANN_E_BAD_OUTPUT',
    /** 转发超时 */
    TIMEOUT: 'CANN_E_TIMEOUT',
    /** 白名单拒绝（C11） */
    DENIED: 'CANN_E_DENIED',
    /** 事件写入失败（contained，不影响工具结果） */
    EVENT_WRITE: 'CANN_E_EVENT_WRITE',
};
export function toolError(code, message, hint) {
    return { code, message, hint };
}
//# sourceMappingURL=invariant.js.map