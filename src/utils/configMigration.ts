/**
 * Config migration utility - migrates config from old directories to ~/.ywcoder
 */

import { existsSync } from 'fs'
// 2026-04-30 新增 copyFile，用于迁移 ~/.claude.json → ~/.ywcoder/.config.json
import { copyFile, cp, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

interface MigrationResult {
  success: boolean
  from: string
  to: string
  message: string
}

/**
 * Detect which config directory is currently in use
 */
function detectCurrentConfigDir(): string | null {
  const newPath = join(homedir(), '.ywcoder')
  const legacyClaudePath = join(homedir(), '.claude')

  if (existsSync(newPath)) {
    return newPath
  }
  if (existsSync(legacyClaudePath)) {
    return legacyClaudePath
  }
  return null
}

/**
 * Check if there's an older config to migrate
 */
function findSourceConfigDir(): string | null {
  const legacyClaudePath = join(homedir(), '.claude')

  if (existsSync(legacyClaudePath)) {
    return legacyClaudePath
  }
  return null
}

/**
 * Migrate config from old directory to ~/.ywcoder
 * 2026-04-30 修复 ~/.claude.json → ~/.ywcoder/.config.json 的迁移遗漏
 */
export async function migrateConfig(): Promise<MigrationResult> {
  const targetDir = join(homedir(), '.ywcoder')

  // 2026-04-30 始终先确保目标目录存在，作为后续 JSON 迁移和目录迁移的共同前置
  // 取代原 try 块内的 mkdir 调用（避免重复创建）
  await mkdir(targetDir, { recursive: true })

  // 2026-04-30 步骤 1（独立）：迁移 ~/.claude.json → ~/.ywcoder/.config.json
  // 不依赖 ~/.claude 目录是否存在，覆盖以下场景：
  //   a. 官方 Claude Code 已卸载但 ~/.claude.json 残留
  //   b. 用户清理过 ~/.claude 目录但 JSON 配置还在
  // 仅在目标文件不存在时复制，防止覆盖已在 ywcoder 中单独修改过的配置
  const sourceClaudeJson = join(homedir(), '.claude.json')
  const targetConfigJson = join(targetDir, '.config.json')
  if (existsSync(sourceClaudeJson) && !existsSync(targetConfigJson)) {
    await copyFile(sourceClaudeJson, targetConfigJson)
    console.log(`✓ 迁移全局配置文件 ~/.claude.json → ~/.ywcoder/.config.json`)
  } else if (existsSync(targetConfigJson)) {
    console.log(`  ~/.ywcoder/.config.json 已存在，跳过（保留现有配置）`)
  }
  // 若 ~/.claude.json 不存在，静默跳过——用户可能从未用过 Claude Code

  // 步骤 2：目录迁移（保留原有逻辑，仅删除原 try 块内重复的 mkdir）
  const currentDir = detectCurrentConfigDir()
  const sourceDir = findSourceConfigDir()

  // If already using ~/.ywcoder, nothing to migrate
  if (currentDir === targetDir) {
    console.log('✓ Already using ~/.ywcoder')
    return {
      success: true,
      from: currentDir || '',
      to: targetDir,
      message: 'Already using the new config directory',
    }
  }

  // If no source config found, target dir is already created above
  if (!sourceDir) {
    console.log('✓ Created new config directory at ~/.ywcoder')
    return {
      success: true,
      from: '',
      to: targetDir,
      message: 'Created new config directory',
    }
  }

  // Migrate from source to target
  try {
    // 2026-04-30 已在函数顶部 mkdir，此处不再重复

    // Copy all files from source to target (don't overwrite existing files)
    await cp(sourceDir, targetDir, {
      recursive: true,
      force: false,
      preserveTimestamps: true,
    })

    console.log(`✓ Migrated config from ${sourceDir} to ~/.ywcoder`)
    console.log(`  You can now safely delete the old directory:`)
    console.log(`  rm -rf ${sourceDir}`)

    return {
      success: true,
      from: sourceDir,
      to: targetDir,
      message: 'Config migrated successfully',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`✗ Migration failed: ${message}`)

    return {
      success: false,
      from: sourceDir,
      to: targetDir,
      message: `Migration failed: ${message}`,
    }
  }
}

// CLI entry point
if (import.meta.main) {
  migrateConfig().then(result => {
    process.exit(result.success ? 0 : 1)
  })
}
