import { buildScenario, type RawEvent, type Scenario } from '../types';

/**
 * 降级剧本（对齐 workflow.md 2026-09-17 修订版）：
 * 编译反复失败 → routing 判定会话分流（回 strategy 换路线 / 留 implement 修复）
 * → 墙钟预算耗尽（本任务 task.yaml 覆盖为 22min，小于缺省 90）→ 降级等待人工。
 * 无迭代次数上限：唯一的硬终止是墙钟。
 */
const raw: RawEvent[] = [
  // ── identify：规格校验（s1）────────────────────────────────
  {
    tsMin: 0,
    stage: 'identify',
    kind: 'session_started',
    sessionId: 's1-identify',
    title: 'identify 会话 · 规格校验',
    detail: '识别',
  },
  {
    tsMin: 0.15,
    stage: 'identify',
    kind: 'session_message',
    sessionId: 's1-identify',
    title: '思考',
    message: {
      part: 'thinking',
      content:
        '单算子规格任务：跳过图解析，直接校验 pattern / shape / dtype / 目标。注意特征图只有 32×32，属于小尺寸场景——tiling 约束会比常规 shape 苛刻，后面选方案时要留心 UB 容量。',
    },
  },
  {
    tsMin: 0.2,
    stage: 'identify',
    kind: 'tool_completed',
    sessionId: 's1-identify',
    title: '解析单算子规格',
    tool: {
      name: 'parse_spec',
      input: { file: 'task_conv3x3_fuse.yaml' },
      output: {
        算子: 'Conv3x3 + BN + ReLU（融合）',
        shape: '32×64×32×32 (NCHW)',
        dtype: 'fp16',
        目标: '+8% vs 官方实现',
        墙钟预算: '22 min（task.yaml 覆盖缺省 90）',
      },
    },
  },
  {
    tsMin: 0.35,
    stage: 'identify',
    kind: 'session_message',
    sessionId: 's1-identify',
    title: '输出',
    message: {
      part: 'text',
      content:
        '规格校验通过：Conv3x3+BN+ReLU 融合，NCHW 32×64×32×32，fp16，目标 +8%。本任务墙钟预算 22 分钟（小于缺省 90），时间余量紧，策略阶段要快。',
    },
  },
  {
    tsMin: 0.45,
    stage: 'identify',
    kind: 'session_ended',
    sessionId: 's1-identify',
    title: 'identify 完成（规格合法）',
  },
  {
    tsMin: 0.5,
    stage: 'identify',
    kind: 'stage_completed',
    title: '识别完成：单算子规格任务',
    severity: 'success',
  },

  // ── strategy：方案#1（s2）─────────────────────────────────
  {
    tsMin: 1,
    stage: 'strategy',
    kind: 'session_started',
    sessionId: 's2-strategy',
    title: 'strategy 会话 · 方案生成',
    detail: '策略',
  },
  {
    tsMin: 1.2,
    stage: 'strategy',
    kind: 'session_message',
    sessionId: 's2-strategy',
    title: '思考',
    message: {
      part: 'thinking',
      content:
        '小尺寸 32×32 特征图 + 3×3 卷积：im2col + 单 GEMM 是标准路线（K=27 展开后一次矩阵乘），BN 折叠入权重、ReLU 做 epilogue。风险在展开缓冲对 UB 的压力——先检索经验库确认有没有小尺寸下的翻车先例。',
    },
  },
  {
    tsMin: 1.5,
    stage: 'strategy',
    kind: 'tool_completed',
    sessionId: 's2-strategy',
    title: 'RAG 检索融合先例',
    tool: {
      name: 'retrieve',
      input: { query: 'Conv3x3 im2col GEMM 融合 tiling', top_k: 3 },
      output: {
        hits: [
          { source: '经验库 #exp-0117', title: 'BN 推理态折叠', score: 0.9 },
          { source: 'CANN 文档', title: 'im2col 展开约束', score: 0.85 },
        ],
      },
    },
  },
  {
    tsMin: 2.2,
    stage: 'strategy',
    kind: 'session_message',
    sessionId: 's2-strategy',
    title: '思考',
    message: {
      part: 'thinking',
      content:
        '检索没有直接命中"小尺寸 im2col 失败"的条目，文档只提示展开约束。先按方案#1（im2col 整体展开）走——若 UB/对齐约束真的互斥，routing 判定会把我拉回来换路线。',
    },
  },
  {
    tsMin: 3,
    stage: 'strategy',
    kind: 'tool_completed',
    sessionId: 's2-strategy',
    title: '生成融合方案 #1',
    tool: {
      name: 'strategy_gen',
      input: { pattern: 'Conv3x3+BN+ReLU', impl: 'im2col + GEMM 融合' },
      output: { plan: '方案#1', est_gain: '+9%', risk: '小尺寸下 UB 压力大' },
    },
    artifact: {
      tab: 'strategy',
      title: '优化策略文档 · 方案#1',
      data: {
        content: [
          '# Conv3x3 + BN + ReLU 融合优化策略（方案#1）',
          '',
          '## 目标',
          '- 单算子任务：32×64×32×32 fp16，目标 +8%',
          '',
          '## 融合方案',
          '- im2col 展开 + 单 GEMM（BN 折叠入权重，ReLU epilogue）',
          '- 风险：32×32 特征图下展开缓冲对 UB 压力大，需精细 tiling',
        ].join('\n'),
      },
    },
  },
  {
    tsMin: 4.2,
    stage: 'strategy',
    kind: 'session_message',
    sessionId: 's2-strategy',
    title: '输出',
    message: {
      part: 'text',
      content: '方案#1 定稿：im2col + GEMM，预期 +9%，主要风险是小尺寸下的 UB 压力。转入编码。',
    },
  },
  {
    tsMin: 4.6,
    stage: 'strategy',
    kind: 'session_ended',
    sessionId: 's2-strategy',
    title: 'strategy 完成',
  },
  {
    tsMin: 5,
    stage: 'strategy',
    kind: 'stage_completed',
    title: '策略完成：方案#1 · 预期 +9%',
    severity: 'success',
  },

  // ── implement v1：三次编译失败（s3）───────────────────────
  { tsMin: 5.1, stage: 'implement', kind: 'stage_started', title: '开始代码编写' },
  {
    tsMin: 5.15,
    stage: 'implement',
    kind: 'session_started',
    sessionId: 's3-impl-v1',
    title: 'implement 会话 · v1',
    detail: '编码',
  },
  {
    tsMin: 5.3,
    stage: 'implement',
    kind: 'session_message',
    sessionId: 's3-impl-v1',
    title: '思考',
    message: {
      part: 'thinking',
      content:
        '骨架设计：host 侧完成 BN 折叠（w·γ/σ，b−μγ/σ）→ kernel 内 im2col 按 kernel 窗口重排 → GEMM 主循环 → ReLU 在 Mmad 出口寄存器上直接做。先出完整骨架再过一遍 API 拼写。',
    },
  },
  {
    tsMin: 5.5,
    stage: 'implement',
    kind: 'tool_completed',
    sessionId: 's3-impl-v1',
    title: '生成融合算子 v1 代码',
    tool: { name: 'code_gen', input: { file: 'operator/conv3x3_fuse_v1.cpp', lines: 187 }, output: { status: 'generated' } },
    artifact: {
      tab: 'diff',
      title: '融合算子 v1 生成',
      data: {
        file: 'operator/conv3x3_fuse_v1.cpp（新增 187 行）',
        summary: 'im2col 展开 + GEMM + ReLU epilogue',
        diff: [
          '@@ operator/conv3x3_fuse_v1.cpp @@',
          '+ // im2col：3×3 展开至 GEMM 的 K 维',
          '+ __aicore__ inline void Im2col(const GlobalTensor<half>& x) {',
          '+   // 逐行搬入并按 kernel 窗口重排',
          '+ }',
        ].join('\n'),
      },
    },
  },
  {
    tsMin: 6.0,
    stage: 'implement',
    kind: 'session_message',
    sessionId: 's3-impl-v1',
    title: '输出',
    message: { part: 'text', content: 'v1 代码生成完毕（187 行），提交编译。' },
  },
  {
    tsMin: 7.5,
    stage: 'implement',
    kind: 'tool_failed',
    sessionId: 's3-impl-v1',
    title: 'v1 编译失败：符号未定义',
    severity: 'error',
    detail: 'E102: undefined symbol GetTmpBuffer',
    tool: { name: 'build', output: { error: 'E102 undefined symbol GetTmpBuffer' } },
  },
  {
    tsMin: 7.8,
    stage: 'implement',
    kind: 'session_message',
    sessionId: 's3-impl-v1',
    title: '思考',
    message: {
      part: 'thinking',
      content: 'E102 符号未定义——大概率是 API 名拼错，查 AscendC API 表确认正确名称。',
    },
  },
  {
    tsMin: 8.2,
    stage: 'implement',
    kind: 'tool_completed',
    sessionId: 's3-impl-v1',
    title: '定位：API 名称拼写错误',
    tool: { name: 'analyze_error', output: { root_cause: 'GetTmpBuffer 应为 GetTmpBufferMgr', fix: '修正 API 调用', 分类: '代码层' } },
  },
  {
    tsMin: 9,
    stage: 'implement',
    kind: 'tool_completed',
    sessionId: 's3-impl-v1',
    title: '修复 API 拼写',
    tool: { name: 'patch_code', input: { lines_changed: 1 } },
    artifact: {
      tab: 'diff',
      title: '修复 API 拼写',
      data: {
        file: 'operator/conv3x3_fuse_v1.cpp',
        summary: 'GetTmpBuffer → GetTmpBufferMgr',
        diff: [
          '@@ operator/conv3x3_fuse_v1.cpp @@',
          '- auto buf = pipe.GetTmpBuffer(LEN);',
          '+ auto buf = pipe.GetTmpBufferMgr(LEN);',
        ].join('\n'),
      },
    },
  },
  {
    tsMin: 10.5,
    stage: 'implement',
    kind: 'tool_failed',
    sessionId: 's3-impl-v1',
    title: '第 2 次编译失败：寄存器溢出',
    severity: 'error',
    detail: 'E203: register spill 138%，展开因子过大',
    tool: { name: 'build', output: { error: 'E203 register spill 138%' } },
  },
  {
    tsMin: 10.8,
    stage: 'implement',
    kind: 'session_message',
    sessionId: 's3-impl-v1',
    title: '思考',
    message: {
      part: 'thinking',
      content: 'E203 寄存器溢出 138%：UNROLL=8 展开太激进，小 tile 下寄存器不够分。降到 UNROLL=4 应该能过——这是参数问题，不是路线问题。',
    },
  },
  {
    tsMin: 11.2,
    stage: 'implement',
    kind: 'tool_completed',
    sessionId: 's3-impl-v1',
    title: '定位：展开因子过大',
    tool: { name: 'analyze_error', output: { root_cause: 'UNROLL=8 导致寄存器溢出', fix: '降至 UNROLL=4', 分类: '代码层' } },
  },
  {
    tsMin: 12,
    stage: 'implement',
    kind: 'tool_completed',
    sessionId: 's3-impl-v1',
    title: '降低展开因子',
    tool: { name: 'patch_code', input: { lines_changed: 1 } },
    artifact: {
      tab: 'diff',
      title: '降低展开因子',
      data: {
        file: 'operator/conv3x3_fuse_v1.cpp',
        summary: 'UNROLL 8 → 4',
        diff: [
          '@@ operator/conv3x3_fuse_v1.cpp @@',
          '- #define UNROLL 8',
          '+ #define UNROLL 4',
        ].join('\n'),
      },
    },
  },
  {
    tsMin: 13.5,
    stage: 'implement',
    kind: 'tool_failed',
    sessionId: 's3-impl-v1',
    title: '第 3 次编译失败：tile 形状非法',
    severity: 'warning',
    detail: 'E104: tiling H=7 不满足 16 对齐约束',
    tool: { name: 'build', output: { error: 'E104 tiling H=7 violates ALIGN=16' } },
  },
  {
    tsMin: 13.8,
    stage: 'implement',
    kind: 'session_message',
    sessionId: 's3-impl-v1',
    title: '思考',
    message: {
      part: 'thinking',
      content:
        '又是约束类错误，但和前两次不同根因：E104 是 32×32 特征图减去 kernel/stride 后有效 tile 高度 H=7，无法满足 16 对齐——这不是拼写或参数，是 shape 本身与 im2col 展开路线的结构性冲突。pad 到 16 会浪费一半以上算力，自动修复空间收窄了。',
    },
  },
  {
    tsMin: 14.2,
    stage: 'implement',
    kind: 'tool_completed',
    sessionId: 's3-impl-v1',
    title: '错误分类：约束组合冲突',
    tool: {
      name: 'analyze_error',
      output: {
        root_cause: 'H=7 与 ALIGN=16 冲突；pad 方案浪费 >50% 算力',
        分类: '路线不可行（倾向）',
        hint: '建议分块卷积直接计算，避免整体展开',
      },
    },
  },
  {
    tsMin: 14.5,
    stage: 'implement',
    kind: 'session_ended',
    sessionId: 's3-impl-v1',
    title: '会话收尾：v1 未建成，进入分叉点',
  },
  {
    tsMin: 14.6,
    stage: 'implement',
    kind: 'note',
    title: 'implement 会话结束且 build 未通过 → 触发 routing 判定（边集：implement | strategy）',
  },

  // ── routing 判定 #1：换路线（sr1）─────────────────────────
  {
    tsMin: 14.8,
    stage: 'implement',
    kind: 'session_started',
    sessionId: 'sr1-routing',
    title: 'routing 判定会话 · 分叉点 #1',
    detail: '判定',
  },
  {
    tsMin: 15,
    stage: 'implement',
    kind: 'session_message',
    sessionId: 'sr1-routing',
    title: '思考',
    message: {
      part: 'thinking',
      content:
        '证据盘点：E102（拼写，已修）、E203（参数，已修）都是代码层且修复有效；但 E104 是对齐约束，根因是 32×32 小特征图与 im2col 整体展开的结构性冲突——analyze_error 判类"路线不可行（倾向）"。继续在 implement 里修，只能 pad 浪费算力，即使编过也大概率达不到 +8% 目标。判：回 strategy 换路线。',
    },
  },
  {
    tsMin: 15.3,
    stage: 'implement',
    kind: 'tool_completed',
    sessionId: 'sr1-routing',
    title: 'route → strategy',
    severity: 'success',
    tool: {
      name: 'route',
      input: { next: 'strategy' },
      output: {
        next: 'strategy',
        reason: 'E104 对齐约束属路线级冲突（shape 结构性），代码层修复空间已收窄',
        evidence: { build_failures: 3, last_error: 'E104 ALIGN=16', 分类: '路线不可行（倾向）' },
        confidence: 'high',
      },
    },
  },
  {
    tsMin: 15.5,
    stage: 'implement',
    kind: 'session_ended',
    sessionId: 'sr1-routing',
    title: '判定完成',
  },
  {
    tsMin: 15.6,
    stage: 'implement',
    kind: 'decision',
    title: 'routing 判定 #1 → 回 strategy 重规划（路线不可行：im2col 展开与 32×32 对齐约束冲突）',
    severity: 'warning',
    detail: 'route(next=strategy, confidence=high)；已试路线清单将注入重规划上下文',
  },

  // ── strategy 重规划：方案#2（s4）──────────────────────────
  {
    tsMin: 15.8,
    stage: 'strategy',
    kind: 'session_started',
    sessionId: 's4-strategy-replan',
    title: 'strategy 会话 · 重规划',
    detail: '策略',
  },
  {
    tsMin: 16,
    stage: 'strategy',
    kind: 'session_message',
    sessionId: 's4-strategy-replan',
    title: '思考',
    message: {
      part: 'thinking',
      content:
        '上轮失败证据：im2col 整体展开在 32×32 下与 16 对齐互斥。换路线——不做展开，改分块卷积直接计算：3×3 窗口按 (H_tile=8, W_tile=16) 切分，配合双缓冲让搬入与计算重叠。tile 高度 8 满足对齐（8|16 可 pad 至 16 仅 2 倍冗余的 1/8 行）。预期收益略降但可行。',
    },
  },
  {
    tsMin: 16.3,
    stage: 'strategy',
    kind: 'tool_completed',
    sessionId: 's4-strategy-replan',
    title: '检索小尺寸切分先例',
    tool: {
      name: 'retrieve',
      input: { query: '小特征图 分块卷积 双缓冲 对齐', top_k: 3 },
      output: {
        hits: [
          { source: '经验库 #exp-0102', title: '小尺寸切分方案', score: 0.88 },
          { source: '经验库 #exp-0044', title: 'tile 对齐经验', score: 0.82 },
        ],
      },
    },
  },
  {
    tsMin: 17,
    stage: 'strategy',
    kind: 'tool_completed',
    sessionId: 's4-strategy-replan',
    title: '生成融合方案 #2',
    tool: {
      name: 'strategy_gen',
      input: { pattern: 'Conv3x3+BN+ReLU', impl: '分块卷积直接计算 + 双缓冲' },
      output: { plan: '方案#2', est_gain: '+7%', risk: '双缓冲调度复杂度' },
    },
    artifact: {
      tab: 'strategy',
      title: '优化策略文档 · 方案#2（重规划）',
      data: {
        content: [
          '# Conv3x3 + BN + ReLU 融合优化策略（方案#2 · 重规划）',
          '',
          '## 重规划原因',
          '- 方案#1（im2col 整体展开）在 32×32 特征图下与 ALIGN=16 约束冲突（E104），判路线不可行',
          '',
          '## 新方案',
          '- 分块卷积直接计算：3×3 窗口按 (8×16) tile 切分，不做 K 维展开',
          '- 双缓冲：输入 tile 搬入与 GEMM 计算重叠，掩盖搬运延迟',
          '- BN 折叠与 ReLU epilogue 沿用方案#1（与失败根因无关）',
          '',
          '## 预期',
          '- +7%（低于方案#1 估计的 +9%，但约束可行）',
        ].join('\n'),
      },
    },
  },
  {
    tsMin: 17.6,
    stage: 'strategy',
    kind: 'session_message',
    sessionId: 's4-strategy-replan',
    title: '输出',
    message: {
      part: 'text',
      content: '方案#2 定稿：分块卷积 + 双缓冲，预期 +7%。已将方案#1 记入 rejected（路线不可行）。',
    },
  },
  {
    tsMin: 18,
    stage: 'strategy',
    kind: 'session_ended',
    sessionId: 's4-strategy-replan',
    title: '重规划完成',
  },
  {
    tsMin: 18.1,
    stage: 'strategy',
    kind: 'stage_completed',
    title: '策略重规划完成：方案#2 · 预期 +7%',
    severity: 'success',
  },

  // ── implement v2：新错误 → routing #2 留在 implement（s5 / sr2）──
  {
    tsMin: 18.2,
    stage: 'implement',
    kind: 'stage_started',
    title: '开始 v2 编码（方案#2）',
  },
  {
    tsMin: 18.25,
    stage: 'implement',
    kind: 'iteration_started',
    title: '迭代 v2：分块卷积实现',
    iteration: 'v2',
  },
  {
    tsMin: 18.3,
    stage: 'implement',
    kind: 'session_started',
    sessionId: 's5-impl-v2',
    title: 'implement 会话 · v2',
    detail: '编码',
  },
  {
    tsMin: 18.45,
    stage: 'implement',
    kind: 'session_message',
    sessionId: 's5-impl-v2',
    title: '思考',
    message: {
      part: 'thinking',
      content:
        '按方案#2 重写计算主体：去掉 im2col，直接按 (8×16) tile 遍历 3×3 窗口累加；双缓冲用两个 UB 槽位乒乓。BN 折叠权重加载逻辑沿用 v1。',
    },
  },
  {
    tsMin: 18.5,
    stage: 'implement',
    kind: 'tool_completed',
    sessionId: 's5-impl-v2',
    title: '生成 v2 代码',
    tool: { name: 'code_gen', input: { file: 'operator/conv3x3_fuse_v2.cpp', lines: 243 }, output: { status: 'generated' } },
    artifact: {
      tab: 'diff',
      title: '融合算子 v2 生成（方案#2）',
      data: {
        file: 'operator/conv3x3_fuse_v2.cpp（新增 243 行）',
        summary: '分块卷积直接计算 + 双缓冲，去除 im2col 展开',
        diff: [
          '@@ operator/conv3x3_fuse_v2.cpp @@',
          '+ // 分块卷积：(8×16) tile 直接遍历 3×3 窗口',
          '+ __aicore__ inline void BlockedConv(const LocalTensor<half>& xTile, ...) {',
          '+   // 双缓冲：buf[parity] 搬入与计算重叠',
          '+ }',
        ].join('\n'),
      },
    },
  },
  {
    tsMin: 19.2,
    stage: 'implement',
    kind: 'tool_failed',
    sessionId: 's5-impl-v2',
    title: 'v2 编译失败：UB bank 冲突',
    severity: 'error',
    detail: 'E205: UB bank conflict，双缓冲槽位未按 32B 对齐',
    tool: { name: 'build', output: { error: 'E205 UB bank conflict (alignment 32B)' } },
  },
  {
    tsMin: 19.4,
    stage: 'implement',
    kind: 'session_message',
    sessionId: 's5-impl-v2',
    title: '思考',
    message: {
      part: 'thinking',
      content:
        'E205 是 buffer 布局对齐问题——双缓冲的两个槽位起始地址没按 32B 对齐。这是代码层单点错误，与路线无关，修一下就能过。不巧会话预算到了，收尾交给 routing 判定确认去向。',
    },
  },
  {
    tsMin: 19.6,
    stage: 'implement',
    kind: 'session_ended',
    sessionId: 's5-impl-v2',
    title: '会话收尾：v2 未建成，进入分叉点',
  },
  {
    tsMin: 19.8,
    stage: 'implement',
    kind: 'session_started',
    sessionId: 'sr2-routing',
    title: 'routing 判定会话 · 分叉点 #2',
    detail: '判定',
  },
  {
    tsMin: 19.95,
    stage: 'implement',
    kind: 'session_message',
    sessionId: 'sr2-routing',
    title: '思考',
    message: {
      part: 'thinking',
      content:
        'v2 的唯一错误 E205 是 buffer 对齐（代码层），且是方案#2 路线下的首次失败——没有同类错误复现，不构成路线信号。留 implement 修复，一行对齐补齐即可。',
    },
  },
  {
    tsMin: 20.15,
    stage: 'implement',
    kind: 'tool_completed',
    sessionId: 'sr2-routing',
    title: 'route → implement',
    severity: 'success',
    tool: {
      name: 'route',
      input: { next: 'implement' },
      output: {
        next: 'implement',
        reason: 'E205 属代码层对齐错误，方案#2 首败且无复现，修复路径明确',
        evidence: { build_failures: 1, last_error: 'E205 bank conflict', 分类: '代码层' },
        confidence: 'high',
      },
    },
  },
  {
    tsMin: 20.3,
    stage: 'implement',
    kind: 'session_ended',
    sessionId: 'sr2-routing',
    title: '判定完成',
  },
  {
    tsMin: 20.4,
    stage: 'implement',
    kind: 'decision',
    title: 'routing 判定 #2 → 留 implement 修复（E205 代码层，首败无复现）',
    severity: 'info',
    detail: 'route(next=implement, confidence=high)；下一会话注入 E205 上下文',
  },

  // ── 墙钟耗尽 → 降级（新规范：唯一硬终止）──────────────────
  {
    tsMin: 22,
    stage: 'implement',
    kind: 'degrade',
    title: '已降级：墙钟预算耗尽（22 / 22 min），v2 修复中途冻结',
    severity: 'error',
    detail:
      '本任务 task.yaml 将 max_wall_min 覆盖为 22（缺省 90）。现场完整保留：方案#2 代码 v2 + 待修的 E205 对齐问题 + 两轮 routing 判定记录。建议人工：重试（从检查点恢复，可调大预算）或放弃（归档 run 目录）。相关经验 #exp-0044（tile 对齐）、#exp-0102（小尺寸切分）',
  },
  {
    tsMin: 22.3,
    stage: 'implement',
    kind: 'checkpoint',
    title: '检查点已保存：可从 implement·v2 分叉点恢复',
    detail: '状态机位置 / 预算余量 0 / 最新 routing 判定（→implement）已入检查点',
  },
];

export const conv3x3Scenario: Scenario = buildScenario(
  {
    id: 'run-conv3x3',
    templateName: '单算子规格 · Conv3x3+BN+ReLU',
    templateDesc: '编译反复失败 → routing 判定换路线 → 墙钟耗尽降级等待人工（演示判定会话与降级态）',
    meta: {
      id: 'run-conv3x3',
      name: 'Conv3x3 融合（32×64×32×32）',
      taskType: 'operator',
      operator: 'Conv3x3 + BN + ReLU',
      shapeNote: 'NCHW 32×64×32×32 · fp16',
      targetGainPct: 8,
      startTimeLabel: '11:18',
    },
  },
  raw,
  22.4 * 60_000,
);
