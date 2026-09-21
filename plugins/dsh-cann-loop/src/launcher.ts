/**
 * session 启动器（workflow §1：每个阶段 = 一次受控 loop 运行）。
 *
 * 真实现 DshHeadlessLauncher：spawn `dsh --profile <p> "<prompt>"`（headless one-shot：
 * 全新持久化 session、打印最终回答、退出——dsh README §命令表）。
 * 编排器（orchestrator.ts）经 SessionLauncher 接口驱动，测试注入假启动器。
 */
import { spawn } from 'node:child_process'
import type { Stage } from './state-machine.js'

export interface SessionResult {
  /** dsh 退出码 === 0 */
  ok: boolean
  /** headless 打印的最终回答 */
  output: string
  /** session 累计 token（headless 输出不含 usage 时为 null——滚转判定退化为估算） */
  tokensUsed: number | null
}

export interface LaunchOptions {
  /** stage 会话（带阶段工具集）或 routing 判定会话（唯一工具 route） */
  purpose: 'stage' | 'routing'
  stage: Stage | 'routing'
  /** 组装完成的完整 prompt（阶段 prompt 文件 + manifest 注入） */
  prompt: string
  /** 附加环境变量（CANNAGENT_* 经白名单转发的部分） */
  env?: Record<string, string>
}

export interface SessionLauncher {
  launch(opts: LaunchOptions): Promise<SessionResult>
}

export interface DshLauncherConfig {
  /** dsh 可执行文件（缺省 PATH 上的 dsh；Windows 下 npm 全局 bin） */
  bin?: string
  /** dsh profile（缺省 cann：项目 profiles/ 组合层） */
  profile?: string
  cwd?: string
  /** 单 session 超时（缺省 10min，workflow §3 单工具上限之外的整体护栏） */
  timeoutMs?: number
}

/** chars/4 的保守 token 估算（headless 无 usage 时的滚转判据，标注为估算） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export class DshHeadlessLauncher implements SessionLauncher {
  private readonly cfg: Required<Pick<DshLauncherConfig, 'profile' | 'timeoutMs'>> & DshLauncherConfig

  constructor(cfg: DshLauncherConfig = {}) {
    this.cfg = { profile: cfg.profile ?? 'cann', timeoutMs: cfg.timeoutMs ?? 600_000, ...cfg }
  }

  async launch(opts: LaunchOptions): Promise<SessionResult> {
    const bin = this.cfg.bin ?? 'dsh'
    const args = ['--profile', this.cfg.profile, opts.prompt]
    return await new Promise<SessionResult>((resolve) => {
      const child = spawn(bin, args, {
        cwd: this.cfg.cwd,
        env: { ...process.env, ...opts.env },
        shell: process.platform === 'win32',
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill(), this.cfg.timeoutMs)
      child.stdout.on('data', (d: Buffer) => { out += d.toString('utf-8') })
      child.stderr.on('data', (d: Buffer) => { err += d.toString('utf-8') })
      child.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, output: `${out}${err}\n[launcher] ${String(e)}`, tokensUsed: null })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const text = out || err
        resolve({
          ok: code === 0,
          output: text,
          tokensUsed: estimateTokens(opts.prompt + text),
        })
      })
    })
  }
}
