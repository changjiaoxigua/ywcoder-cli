/**
 * Config migration utility - migrates config from old directories to ~/.ywcoder
 */

import { existsSync } from 'fs'
// 2026-04-30 新增 copyFile，用于迁移 ~/.claude.json → ~/.ywcoder/.config.json
// 2026-05-14 新增 rename，用于双目录场景下把历史 ~/.ywcoder 备份为 ~/.ywcoder.bak.<timestamp>
import { copyFile, cp, mkdir, rename } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

interface MigrationResult {
  success: boolean
  from: string
  to: string
  message: string
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
 * 生成形如 2026-05-14T10-30-00 的本地时间戳，用作备份目录后缀。
 * 避免冒号/小数点（Windows 文件名不允许冒号）。
 */
function makeBackupTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/**
 * Migrate config from old directory to ~/.ywcoder
 * 2026-04-30 修复 ~/.claude.json → ~/.ywcoder/.config.json 的迁移遗漏
 * 2026-05-14 修复早期版本残留 ~/.ywcoder 导致目录迁移被跳过、且 ~/.claude 新状态被反向覆盖的问题
 */
export async function migrateConfig(): Promise<MigrationResult> {
  const targetDir = join(homedir(), '.ywcoder')

  // 2026-05-14 在 mkdir 之前先拍快照，避免后面把"我们自己刚创建的空目录"误判为"用户已经在新目录上"
  const targetExistedBefore = existsSync(targetDir)

  const sourceDir = findSourceConfigDir()

  // 2026-05-14 双目录场景：早期版本曾用过 ~/.ywcoder、后来又回到 ~/.claude 的用户。
  // ~/.claude 是当前在用的真实状态，~/.ywcoder 是历史残留；
  // 直接 cp(force:false) 会让"老配置赢"反向覆盖最新状态，
  // 因此先把历史 ~/.ywcoder 重命名为带时间戳的备份，再走干净的迁移流程。
  let backupDir: string | null = null
  if (targetExistedBefore && sourceDir) {
    backupDir = `${targetDir}.bak.${makeBackupTimestamp()}`
    try {
      await rename(targetDir, backupDir)
    } catch (error) {
      // 失败常见原因：备份名已存在、目录被其他进程占用、权限不足、Windows 上目标存在。
      // 不抛出，转为标准 MigrationResult，避免上层 CLI 进程崩出。
      const message = error instanceof Error ? error.message : String(error)
      console.error(`✗ 备份历史 ~/.ywcoder 失败：${message}`)
      console.error(`  目标备份路径：${backupDir}`)
      console.error(`  迁移已中止，~/.ywcoder 和 ~/.claude 均未改动`)
      return {
        success: false,
        from: sourceDir,
        to: targetDir,
        message: `Backup of existing ~/.ywcoder failed: ${message}`,
      }
    }
    console.log(`ℹ 检测到历史 ~/.ywcoder，已备份至 ${backupDir}`)
    console.log(`  （如确认无用可手动删除）`)
  }

  // 始终先确保目标目录存在，作为后续 JSON 迁移和目录迁移的共同前置
  await mkdir(targetDir, { recursive: true })

  // 步骤 1（独立）：迁移 ~/.claude.json → ~/.ywcoder/.config.json
  // 不依赖 ~/.claude 目录是否存在，覆盖以下场景：
  //   a. 官方 YwCoder 已卸载但 ~/.claude.json 残留
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
  // 若 ~/.claude.json 不存在，静默跳过——用户可能从未用过 YwCoder

  // 步骤 2：目录迁移
  // 注意：判断"是否已在新目录"用的是 mkdir 之前的快照（targetExistedBefore），
  // 而不是当下的存在性，否则会被本函数自己刚创建的空目录干扰。

  // 真·已经在新目录上：之前就有 ~/.ywcoder 且没有旧 ~/.claude
  if (targetExistedBefore && !sourceDir) {
    console.log('✓ 已在使用 ~/.ywcoder 配置目录')
    return {
      success: true,
      from: targetDir,
      to: targetDir,
      message: 'Already using the new config directory',
    }
  }

  // 既没有历史 ~/.ywcoder，也没有 ~/.claude：纯新装用户
  if (!sourceDir) {
    console.log('✓ 已创建新配置目录 ~/.ywcoder')
    return {
      success: true,
      from: '',
      to: targetDir,
      message: 'Created new config directory',
    }
  }

  // 走到这里有两种情形：
  //   a. 只有 ~/.claude（首次迁移）→ ~/.ywcoder 是本函数刚 mkdir 出来的空目录
  //   b. 双目录都有（已在上方重命名 ~/.ywcoder 为备份）→ ~/.ywcoder 也是本函数刚 mkdir 出来的空目录
  // 两种情形下目标都是空的（仅含步骤 1 写入的 .config.json），cp(force:false) 安全。
  try {
    await cp(sourceDir, targetDir, {
      recursive: true,
      force: false,
      preserveTimestamps: true,
    })

    console.log(`✓ 已将配置从 ${sourceDir} 迁移到 ~/.ywcoder`)
    if (backupDir) {
      console.log(`  历史目录已备份至：${backupDir}`)
      console.log(`  （如确认无用可手动删除）`)
    }
    console.log(`  你现在可以安全删除旧目录，根据使用的 shell 选择对应命令：`)
    console.log(`    Linux:        rm -rf ${sourceDir}`)
    console.log(`    PowerShell:   cmd /c rd /s /q "${sourceDir}"`)
    console.log(`    Windows cmd:  rmdir /s /q "${sourceDir}"`)

    return {
      success: true,
      from: sourceDir,
      to: targetDir,
      message: 'Config migrated successfully',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`✗ 迁移失败：${message}`)
    if (backupDir) {
      console.error(`  历史 ~/.ywcoder 已备份至：${backupDir}`)
      console.error(`  可手动还原：rm -rf "${targetDir}" && mv "${backupDir}" "${targetDir}"`)
    }

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
