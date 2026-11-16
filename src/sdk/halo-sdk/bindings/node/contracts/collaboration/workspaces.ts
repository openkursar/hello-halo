export interface MemberWorkspace {
    cwd: string;
    gitRoot?: string;
    gitCommonDirectory?: string;
    checkout?: string;
    initialHead?: string;
}
