import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { app } from 'electron'

export function defaultDownloadFolder(): string {
  return app.getPath('music')
}

export async function downloadFolderStatus(saved: string | null) {
  const folder = saved || defaultDownloadFolder()
  return {
    folderLabel: saved ? basename(folder) || 'Корневая папка' : 'Музыка Windows',
    folderAvailable: await isDownloadFolderAvailable(folder),
    usesDefaultFolder: !saved,
  }
}

async function isDownloadFolderAvailable(folder: string): Promise<boolean> {
  try {
    if (!(await stat(folder)).isDirectory()) return false
    await access(folder, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function requireDownloadFolder(saved: string | null): Promise<string> {
  const folder = saved || defaultDownloadFolder()
  if (await isDownloadFolderAvailable(folder)) return folder
  throw new Error('Папка загрузок недоступна. Выберите другой каталог в разделе «Настройки → Импорт и файлы».')
}
