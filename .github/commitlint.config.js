// Conventional Commits 规则（SPEC §9）：type(scope): subject
// 允许的 type 与 dsh 插件/领域分层对应
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',       // 新功能
        'fix',        // 缺陷修复
        'docs',       // 文档（规范、ADR、README）
        'style',      // 代码格式（不影响逻辑）
        'refactor',   // 重构
        'perf',       // 性能优化
        'test',       // 测试
        'build',      // 构建/依赖
        'ci',         // CI 配置
        'chore',      // 杂项
        'revert',     // 回滚
      ],
    ],
    'subject-empty': [2, 'never'],
    // 中文主题允许，不做首字母大小写检查
    'subject-case': [0],
  },
};
