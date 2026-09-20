/** C11 一致性：profiles/cann-whitelist.yml 必须覆盖全部领域工具（tool-table 增删未同步 → 失败） */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load as yamlLoad } from 'js-yaml'
import { TOOL_NAMES } from './tool-table.js'

interface PatchEntry { id?: string; insert?: PatchEntry[]; config?: { whitelist?: string[] } }

function loadWhitelist(): Set<string> {
  const file = resolve(import.meta.dirname, '../../../profiles/cann-whitelist.yml')
  const entries = yamlLoad(readFileSync(file, 'utf-8')) as PatchEntry[]
  // insert 形态（C2 F1）：{insert: [{id: 'cann-tools', config: {...}}]}
  const entry = entries.flatMap(e => e.insert ?? []).find(e => e.id === 'cann-tools')
  return new Set(entry?.config?.whitelist ?? [])
}

describe('C11 生产白名单一致性（docs/security.md §2）', () => {
  it('白名单覆盖全部领域工具', () => {
    const wl = loadWhitelist()
    for (const name of TOOL_NAMES) {
      expect(wl.has(name), `白名单缺少领域工具 ${name}`).toBe(true)
    }
  })

  it('knowledge / loop 工具在白名单', () => {
    const wl = loadWhitelist()
    for (const name of ['retrieve', 'experience_write', 'route']) {
      expect(wl.has(name)).toBe(true)
    }
  })

  it('bash 不在白名单（命令执行走任务包，D9）', () => {
    expect(loadWhitelist().has('bash')).toBe(false)
  })

  it('最小内置集：read/write/edit 在白名单', () => {
    const wl = loadWhitelist()
    for (const name of ['read', 'write', 'edit']) {
      expect(wl.has(name)).toBe(true)
    }
  })
})
