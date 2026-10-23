import { assetUrl } from './petRegistry'

export interface ShellDefinition {
  id: string
  name: string
  spriteUrl: string
  width: number
  height: number
  screen: { left: number; top: number; size: number }
  buttons: Array<{ left: number; top: number; size: number }>
}

// Geometry refers to the original artwork before its transparent margin is trimmed.
function defineShell(id: string, name: string, crop: readonly number[], screen: readonly number[], buttons: readonly (readonly number[])[]): ShellDefinition {
  const [x, y, right, bottom] = crop
  const width = right - x, height = bottom - y
  return {
    id, name, spriteUrl: assetUrl(`shells/${id}.png`), width, height,
    screen: { left: (screen[0] - x) / width * 100, top: (screen[1] - y) / height * 100, size: screen[2] / width * 100 },
    buttons: buttons.map(([cx, cy, diameter]) => ({ left: (cx - x) / width * 100, top: (cy - y) / height * 100, size: diameter / width * 100 })),
  }
}

export const SHELLS: readonly ShellDefinition[] = [
  defineShell('cat', '猫耳', [169,108,1083,1148], [416,454,424], [[471.5,970.5,108],[623.5,1004,108],[776.5,970.5,108]]),
  defineShell('dog', '垂耳狗', [107,128,1147,1135], [427,472,400], [[481,969.5,101],[626,1004,101],[771.5,969.5,101]]),
  defineShell('rabbit', '长耳兔', [196,38,1055,1215], [425,550,400], [[480,1049,101],[625,1082.5,103],[770,1048.5,101]]),
  defineShell('round', '圆形', [177,111,1076,1145], [422,432,408], [[467,952,107],[620.5,985.5,110],[780.5,952,108]]),
]

export const getShell = (id: string) => SHELLS.find(shell => shell.id === id) ?? SHELLS[0]
export function getShellSize(shell: ShellDefinition, maxWidth = 272.4423, maxHeight = 310) {
  const scale = Math.min(maxWidth / shell.width, maxHeight / shell.height)
  return { width: shell.width * scale, height: shell.height * scale }
}
export const shellScreenStyle = (shell: ShellDefinition) => ({ left: `${shell.screen.left}%`, top: `${shell.screen.top}%`, width: `${shell.screen.size}%` })
