import { getShell, getShellSize, shellScreenStyle } from '../appearance/shellRegistry'
import { ShellArtwork } from './ShellArtwork'
import { PixelPet } from '../Pet'

export function ShellPreview({ shellId, color, petId, petName, customPetImage }: { shellId: string; color: string; petId: string; petName: string; customPetImage?: string | null }) {
  const shell = getShell(shellId)
  const size = getShellSize(shell, 73, 100)
  return <div className="shell-preview-device" style={size}>
    <ShellArtwork shellId={shell.id} color={color} />
    <div className="shell-preview-screen" style={shellScreenStyle(shell)}><PixelPet petId={petId} name={petName} customPetImage={customPetImage} /></div>
  </div>
}
