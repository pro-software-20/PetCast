import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ipcMain, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import {
  CUSTOM_PET_MAX_DECODED_DIMENSION,
  CUSTOM_PET_MAX_DIMENSION,
  CUSTOM_PET_MAX_UPLOAD_BYTES,
  detectCustomPetImageType,
  toCustomPetBytes,
  type CustomPetAsset,
  type CustomPetResult,
} from './customPetProtocol.js'

const readAsset = (image: NativeImage, png: Buffer): CustomPetAsset => {
  const size = image.getSize()
  return {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: size.width,
    height: size.height,
    revision: createHash('sha256').update(png).digest('hex').slice(0, 16),
  }
}

export function registerCustomPetIpc(getWindow: () => BrowserWindow | null, userData: string, rendererUrl: string) {
  const directory = path.join(userData, 'custom-pet')
  const imagePath = path.join(directory, 'custom-pet.png')
  const authorized = (event: Electron.IpcMainInvokeEvent) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return false
    try {
      const actual = new URL(event.senderFrame.url), expected = new URL(rendererUrl)
      return actual.origin === expected.origin && actual.protocol === expected.protocol
        && actual.host === expected.host && actual.pathname === expected.pathname
    } catch { return false }
  }

  ipcMain.handle('custom-pet:read', async (event): Promise<CustomPetResult> => {
    if (!authorized(event)) return { ok: false, code: 'UNAVAILABLE', message: '无法读取自定义宠物。' }
    try {
      const png = await fs.readFile(imagePath)
      const image = nativeImage.createFromBuffer(png)
      if (image.isEmpty()) throw new Error('Invalid saved image')
      return { ok: true, asset: readAsset(image, png) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, asset: null }
      return { ok: false, code: 'UNAVAILABLE', message: '自定义宠物图片已损坏或暂时无法读取。' }
    }
  })

  ipcMain.handle('custom-pet:save', async (event, input: unknown): Promise<CustomPetResult> => {
    if (!authorized(event)) return { ok: false, code: 'UNAVAILABLE', message: '无法保存自定义宠物。' }
    const bytes = toCustomPetBytes(input)
    if (!bytes || bytes.byteLength === 0 || !detectCustomPetImageType(bytes)) {
      return { ok: false, code: 'INVALID_IMAGE', message: '请选择有效的 PNG、JPG 或 WebP 图片。' }
    }
    if (bytes.byteLength > CUSTOM_PET_MAX_UPLOAD_BYTES) {
      return { ok: false, code: 'TOO_LARGE', message: '图片不能超过 10 MB。' }
    }
    try {
      let image = nativeImage.createFromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      if (image.isEmpty()) return { ok: false, code: 'INVALID_IMAGE', message: '图片无法解析，请换一张后重试。' }
      const original = image.getSize()
      if (original.width < 16 || original.height < 16
        || original.width > CUSTOM_PET_MAX_DECODED_DIMENSION || original.height > CUSTOM_PET_MAX_DECODED_DIMENSION) {
        return { ok: false, code: 'INVALID_IMAGE', message: '图片尺寸需在 16 × 16 到 8192 × 8192 之间。' }
      }
      const longest = Math.max(original.width, original.height)
      if (longest > CUSTOM_PET_MAX_DIMENSION) {
        const scale = CUSTOM_PET_MAX_DIMENSION / longest
        image = image.resize({
          width: Math.max(1, Math.round(original.width * scale)),
          height: Math.max(1, Math.round(original.height * scale)),
          quality: 'best',
        })
      }
      const png = image.toPNG()
      if (!png.length) return { ok: false, code: 'INVALID_IMAGE', message: '图片转换失败，请换一张后重试。' }
      await fs.mkdir(directory, { recursive: true })
      const temporaryPath = path.join(directory, `custom-pet-${process.pid}-${Date.now()}.tmp`)
      await fs.writeFile(temporaryPath, png, { mode: 0o600 })
      await fs.rename(temporaryPath, imagePath).catch(async error => {
        await fs.unlink(temporaryPath).catch(() => undefined)
        throw error
      })
      return { ok: true, asset: readAsset(image, png) }
    } catch {
      return { ok: false, code: 'UNAVAILABLE', message: '保存图片失败，请检查磁盘空间后重试。' }
    }
  })

  ipcMain.handle('custom-pet:delete', async (event): Promise<CustomPetResult> => {
    if (!authorized(event)) return { ok: false, code: 'UNAVAILABLE', message: '无法删除自定义宠物。' }
    try {
      await fs.unlink(imagePath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      return { ok: true, asset: null }
    } catch {
      return { ok: false, code: 'UNAVAILABLE', message: '删除失败，请稍后重试。' }
    }
  })
}
