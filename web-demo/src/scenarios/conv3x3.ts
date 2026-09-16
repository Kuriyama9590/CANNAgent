import { buildScenario, type RawEvent, type Scenario } from '../types';

/** 降级剧本：连续 3 次编译失败 → 降级等待人工 */
const raw: RawEvent[] = [
  { tsMin: 0, stage: 'identify', kind: 'stage_started', title: '开始算子识别' },
  {
    tsMin: 0.2,
    stage: 'identify',
    kind: 'tool_completed',
    title: '解析单算子规格',
    tool: {
      name: 'parse_spec',
      input: { file: 'task_conv3x3_fuse.yaml' },
      output: {
        算子: 'Conv3x3 + BN + ReLU（融合）',
        shape: '32×64×32×32 (NCHW)',
        dtype: 'fp16',
        目标: '+8% vs 官方实现',
      },
    },
  },
  {
    tsMin: 0.5,
    stage: 'identify',
    kind: 'stage_completed',
    title: '识别完成：单算子规格任务',
    severity: 'success',
  },

  { tsMin: 1, stage: 'strategy', kind: 'stage_started', title: '开始策略生成' },
  {
    tsMin: 1.5,
    stage: 'strategy',
    kind: 'tool_completed',
    title: 'RAG 检索融合先例',
    tool: {
      name: 'retrieve',
      input: { query: 'Conv3x3 im2col GEMM 融合 tiling', top_k: 3 },
      output: {
        hits: [
          { source: '经验库 #exp-0117', title: 'BN 推理态折叠', score: 0.90 },
          { source: 'CANN 文档', title: 'im2col 展开约束', score: 0.85 },
        ],
      },
    },
  },
  {
    tsMin: 3,
    stage: 'strategy',
    kind: 'tool_completed',
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
    tsMin: 5,
    stage: 'strategy',
    kind: 'stage_completed',
    title: '策略完成：方案#1 · 预期 +9%',
    severity: 'success',
  },

  { tsMin: 5.1, stage: 'implement', kind: 'stage_started', title: '开始代码编写' },
  {
    tsMin: 5.5,
    stage: 'implement',
    kind: 'tool_completed',
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
    tsMin: 7.5,
    stage: 'implement',
    kind: 'tool_failed',
    title: 'v1 编译失败：符号未定义',
    severity: 'error',
    detail: 'E102: undefined symbol GetTmpBuffer',
    tool: { name: 'build', output: { error: 'E102 undefined symbol GetTmpBuffer' } },
  },
  {
    tsMin: 8.2,
    stage: 'implement',
    kind: 'tool_completed',
    title: '定位：API 名称拼写错误',
    tool: { name: 'analyze_error', output: { root_cause: 'GetTmpBuffer 应为 GetTmpBufferMgr', fix: '修正 API 调用' } },
  },
  {
    tsMin: 9,
    stage: 'implement',
    kind: 'tool_completed',
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
    title: '第 2 次编译失败：寄存器溢出',
    severity: 'error',
    detail: 'E203: register spill 138%，展开因子过大',
    tool: { name: 'build', output: { error: 'E203 register spill 138%' } },
  },
  {
    tsMin: 11.2,
    stage: 'implement',
    kind: 'tool_completed',
    title: '定位：展开因子过大',
    tool: { name: 'analyze_error', output: { root_cause: 'UNROLL=8 导致寄存器溢出', fix: '降至 UNROLL=4' } },
  },
  {
    tsMin: 12,
    stage: 'implement',
    kind: 'tool_completed',
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
    title: '第 3 次编译失败：tile 形状非法',
    severity: 'warning',
    detail: 'E104: tiling H=7 不满足 16 对齐约束（连续第 3 次编译失败）',
    tool: { name: 'build', output: { error: 'E104 tiling H=7 violates ALIGN=16' } },
  },
  {
    tsMin: 14.5,
    stage: 'implement',
    kind: 'decision',
    title: '编译重试预算（3 次）已耗尽',
    severity: 'warning',
    detail: '小尺寸 shape 下 tiling 约束组合复杂，自动修复策略已用尽',
  },
  {
    tsMin: 15,
    stage: 'implement',
    kind: 'degrade',
    title: '已降级：连续 3 次编译失败，暂停等待人工介入',
    severity: 'error',
    detail: '建议人工检查 tiling 约束：H=7 时需 pad 至 16 或改用切分方案；相关经验 #exp-0044（tile 对齐）、#exp-0102（小尺寸切分）',
  },
  {
    tsMin: 15.2,
    stage: 'implement',
    kind: 'checkpoint',
    title: '检查点已保存：可从编码阶段断点恢复',
    detail: '现场完整保留（代码 v1 + 两轮 patch + 编译日志）',
  },
];

export const conv3x3Scenario: Scenario = buildScenario(
  {
    id: 'run-conv3x3',
    templateName: '单算子规格 · Conv3x3+BN+ReLU',
    templateDesc: '小尺寸融合编译连续失败 → 降级等待人工（演示降级态）',
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
  15.4 * 60_000,
);
