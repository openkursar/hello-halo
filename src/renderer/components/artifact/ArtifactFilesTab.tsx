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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <ArtifactTree spaceId={spaceId} onRootCountChange={onItemsChange} />
    </div>
  )
}
