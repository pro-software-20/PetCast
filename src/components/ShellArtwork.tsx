import { useEffect, useRef, useState } from 'react'
import { getShell } from '../appearance/shellRegistry'
import { ORIGINAL_SHELL_COLOR } from '../appearance/preferences'
import { prepareShellMask, recolorShell } from '../appearance/color'

type ShellSource = { image: HTMLImageElement; pixels: ImageData; mask: ReturnType<typeof prepareShellMask> }
const sources = new Map<string, Promise<ShellSource>>()
function readSource(id: string, url: string): Promise<ShellSource> {
  const cached = sources.get(id)
  if (cached) return cached
  const promise = new Promise<ShellSource>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = image.width; canvas.height = image.height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('Canvas unavailable')
        ctx.drawImage(image, 0, 0)
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
        resolve({ image, pixels, mask: prepareShellMask(pixels.data) })
      } catch (error) { reject(error) }
    }
    image.onerror = () => reject(new Error('Shell image unavailable'))
    image.src = url
  })
  sources.set(id, promise)
  void promise.catch(() => { if (sources.get(id) === promise) sources.delete(id) })
  return promise
}

export function ShellArtwork({ color, shellId = 'cat', className = '' }: { color: string; shellId?: string; className?: string }) {
  const shell = getShell(shellId)
  const ref = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false, frame = 0
    setFailed(false)
    void readSource(shell.id, shell.spriteUrl).then(source => {
      if (cancelled) return
      frame = requestAnimationFrame(() => {
        const canvas = ref.current, ctx = canvas?.getContext('2d')
        if (!canvas || !ctx || cancelled) return
        canvas.width = source.image.width; canvas.height = source.image.height
        if (color.toUpperCase() === ORIGINAL_SHELL_COLOR) ctx.drawImage(source.image, 0, 0)
        else {
          const data = ctx.createImageData(canvas.width, canvas.height)
          data.data.set(recolorShell(source.pixels.data, source.mask, color))
          ctx.putImageData(data, 0, 0)
        }
        canvas.dataset.renderedColor = color
      })
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [color, shell.id, shell.spriteUrl])
  return failed
    ? <img className={`shell-artwork ${className}`} src={shell.spriteUrl} alt={`${shell.name}外壳`} />
    : <canvas className={`shell-artwork ${className}`} ref={ref} role="img" aria-label={`${shell.name}外壳`} data-shell-id={shell.id} data-shell-color={color} />
}
