/**
 * Config migration utility - migrates config from old directories to ~/.ywcoder
 */

import { existsSync } from 'fs'
import { cp, mkdir, rename } from 'fs/promises'
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
  const openclaudePath = join(homedir(), '.openclaude')
  const legacyClaudePath = join(homedir(), '.claude')

  if (existsSync(newPath)) {
    return newPath
  }
  if (existsSync(openclaudePath)) {
    return openclaudePath
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
  const openclaudePath = join(homedir(), '.openclaude')
  const legacyClaudePath = join(homedir(), '.claude')

  // Prefer .openclaude over .claude if both exist
  if (existsSync(openclaudePath)) {
    return openclaudePath
  }
  if (existsSync(legacyClaudePath)) {
    return legacyClaudePath
  }
  return null
}

/**
 * Migrate config from old directory to ~/.ywcoder
 */
export async function migrateConfig(): Promise<MigrationResult> {
  const targetDir = join(homedir(), '.ywcoder')
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

  // If no source config found, create new directory
  if (!sourceDir) {
    await mkdir(targetDir, { recursive: true })
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
    // Create target directory if it doesn't exist
    await mkdir(targetDir, { recursive: true })

    // Copy all files from source to target
    const entries = await cp(sourceDir, targetDir, {
      recursive: true,
      force: false, // Don't overwrite existing files
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
