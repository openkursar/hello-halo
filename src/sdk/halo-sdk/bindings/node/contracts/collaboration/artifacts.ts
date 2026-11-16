export interface PublishedRefStore {
    listFindingsByEpoch(teamId: string, epochId: string): ReadonlyArray<{
        ref: string | null;
        authorAppId: string;
    }>;
    listTasksByEpoch(teamId: string, epochId: string): ReadonlyArray<{
        resultRef: string | null;
        assigneeAppId: string | null;
    }>;
}
export type PublishedArtifactResolution = {
    kind: 'unique';
    authorAppId: string;
} | {
    kind: 'none';
} | {
    kind: 'ambiguous';
    authorAppIds: string[];
};
