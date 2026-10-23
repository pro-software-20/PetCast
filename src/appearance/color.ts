export type Hsv = { h: number; s: number; v: number }
export function rgbToHsv(r: number, g: number, b: number): Hsv {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0
  if (d) { if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h = ((h * 60) % 360 + 360) % 360 }
  return { h, s: max ? d / max : 0, v: max }
}
export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return '#' + rgb.map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
}
export const hexToRgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
export const hexToHsv = (hex: string) => rgbToHsv(...hexToRgb(hex))
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2
  let h = 0, s = 0
  if (d) { s = d / (1 - Math.abs(2 * l - 1)); if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h = ((h * 60) % 360 + 360) % 360 }
  return [h, s, l]
}
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return rgb.map(n => Math.round((n + m) * 255)) as [number, number, number]
}
export type ShellPixel = { index: number; saturation: number; lightness: number }
export function prepareShellMask(pixels: Uint8ClampedArray): ShellPixel[] {
  const mask: ShellPixel[] = []
  for (let i = 0; i < pixels.length; i += 4) {
    const [r, g, b, a] = pixels.subarray(i, i + 4)
    if (a && r - g > 8 && r - b > 3) {
      const [h, s, l] = rgbToHsl(r, g, b)
      if ((h > 310 || h < 5) && s > .09) mask.push({ index: i, saturation: s, lightness: l })
    }
  }
  return mask
}
export function recolorShell(base: Uint8ClampedArray, mask: readonly ShellPixel[], color: string): Uint8ClampedArray {
  const output = new Uint8ClampedArray(base)
  const [h, s, l] = rgbToHsl(...hexToRgb(color))
  for (const p of mask) {
    const lightness = Math.max(.045, Math.min(.975, l + (p.lightness - .83) * .9))
    const rgb = hslToRgb(h, Math.min(1, s * (.5 + .5 * p.saturation)), lightness)
    output[p.index] = rgb[0]; output[p.index + 1] = rgb[1]; output[p.index + 2] = rgb[2]
  }
  return output
}
