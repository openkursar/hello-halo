/**
 * ArtifactFilesTab - "Files" content for the space resource rail
 */

import { ArtifactTree } from './ArtifactTree'
import { useSpaceStore } from '../../stores/space.store'

interface ArtifactFilesTabProps {
  /** Receives the number of top-level entries once loaded, null before. */
  onItemsChange?: (count: number | null) => void
}

export function ArtifactFilesTab({ onItemsChange }: ArtifactFilesTabProps) {
  const spaceId = useSpaceStore(state => state.currentSpace?.id) ?? ''
  const workingDir = useSpaceStore(state => state.currentSpace?.workingDir) ?? ''

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Keyed by the folder too: a workspace pointed at another folder shows
          that folder's tree from the top, not the old one's open folders. */}
      <ArtifactTree key={`${spaceId}:${workingDir}`} spaceId={spaceId} onRootCountChange={onItemsChange} />
    </div>
  )
}
