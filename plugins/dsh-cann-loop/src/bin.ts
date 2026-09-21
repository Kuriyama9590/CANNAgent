/**
 * `cann-loop-run <run_id>`——七阶段 session 编排驱动入口（独立进程，非 dsh 内命令）。
 *
 * 每阶段 spawn 一个 headless one-shot dsh session（阶段 prompt + manifest 注入）；
 * routing 分叉点开判定会话（route 工具在插件内注册并被该会话调用）。
 *
 * 环境变量：CANNAGENT_RUN_ID（必需）、CANNAGENT_WORKSPACE（转发给 python）、
 * DSH_BIN / DSH_PROFILE / DSH_CWD（launcher 覆盖）、CANN_LOOP_MAX_WALL_MIN / CANN_LOOP_MAX_TOKENS。
 */
import { DshHeadlessLauncher } from './launcher.js'
import { runLoop } from './orchestrator.js'
import { ForwardBridge } from './python-bridge.js'

async function main(): Promise<number> {
  const rid = process.env.CANNAGENT_RUN_ID
  if (!rid) {
    console.error('需要 CANNAGENT_RUN_ID（run 目录名；先用 python -m cannagent runs 创建）')
    return 2
  }
  const launcher = new DshHeadlessLauncher({
    bin: process.env.DSH_BIN,
    profile: process.env.DSH_PROFILE ?? 'cann',
    cwd: process.env.DSH_CWD,
  })
  const bridge = new ForwardBridge()
  const result = await runLoop(bridge.deps(launcher), {
    rid,
    budgets: {
      maxWallMin: process.env.CANN_LOOP_MAX_WALL_MIN
        ? Number(process.env.CANN_LOOP_MAX_WALL_MIN)
        : undefined,
      maxTokens: process.env.CANN_LOOP_MAX_TOKENS
        ? Number(process.env.CANN_LOOP_MAX_TOKENS)
        : undefined,
    },
  })
  console.log(`[cann-loop-run] ${result.status} final=${result.finalStage} `
    + `sessions=${result.sessions} rollovers=${result.rollovers}`)
  return result.status === 'completed' ? 0 : 1
}

main().then((code) => process.exit(code), (err) => {
  console.error('[cann-loop-run] fatal:', err)
  process.exit(3)
})
