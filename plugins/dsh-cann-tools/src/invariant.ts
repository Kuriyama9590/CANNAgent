/**
 * 结构化错误码（SPEC §3.3）。TS 侧只做映射，不产生业务判断。
 * 官方编译/运行错误码（E1xx 等）由 Python 侧原样透传，见 forward.ts。
 */
export interface CannToolError {
  code: string
  message: string
  hint: string
}

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
} as const

export function toolError(code: string, message: string, hint: string): CannToolError {
  return { code, message, hint }
}
