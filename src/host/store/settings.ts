// store/settings.mjs —— 插件设置键值对（user.db 的 settings 表）。
//
// 从 lib/store.mjs 拆出来的最小职责：设置的读 / 写 / 删。
// 设置是「随用户数据走」的（模型选择等），所以放 user.db 而不是插件 config：
// config 只能改 cordis.patch.yml 再重启，设置页要改完立刻生效。
// 三个函数都对失败静默（读返回 null、写返回 false），不让设置故障拖垮学习流程。

import type { DatabaseSync } from 'node:sqlite'

/** 设置读写用到的最小 Store 能力（lib/store.mjs 的 Store 满足它）。 */
export interface SettingsStoreLike {
  open(): boolean
  db?: DatabaseSync | null
}

/**
 * 读一个插件设置。不存在（或库没打开）返回 null，不抛错。
 */
export function getSetting(store: SettingsStoreLike, key: string): string | null {
  if (!store.open()) return null
  try {
    const row = store.db!.prepare('SELECT value FROM settings WHERE key = ?').get(String(key)) as
      { value: string | null } | undefined
    return row ? row.value : null
  } catch (err) {
    return null
  }
}

/** 写一个插件设置（覆盖同名旧值）。返回是否写成功。 */
export function setSetting(store: SettingsStoreLike, key: string, value: unknown): boolean {
  if (!store.open()) return false
  try {
    store
      .db!.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(String(key), String(value), Date.now())
    return true
  } catch (err) {
    return false
  }
}

/** 删除一个插件设置（回到默认行为）。 */
export function deleteSetting(store: SettingsStoreLike, key: string): boolean {
  if (!store.open()) return false
  try {
    store.db!.prepare('DELETE FROM settings WHERE key = ?').run(String(key))
    return true
  } catch (err) {
    return false
  }
}
