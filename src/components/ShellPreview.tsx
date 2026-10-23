import { getShell, getShellSize, shellScreenStyle } from '../appearance/shellRegistry'
import { ShellArtwork } from './ShellArtwork'
import { PixelPet } from '../Pet'

export function ShellPreview({ shellId, color, petId, petName }: { shellId: string; color: string; petId: string; petName: string }) {
  const shell = getShell(shellId)
  const size = getShellSize(shell, 73, 100)
  return <div className="shell-preview-device" style={size}>
    <ShellArtwork shellId={shell.id} color={color} />
    <div className="shell-preview-screen" style={shellScreenStyle(shell)}><PixelPet petId={petId} name={petName} /></div>
  </div>
}
