export interface AgentConventions {
    memoryFiles: readonly string[];
    memorySubdirs: readonly string[];
    agentDirs: readonly string[];
    configDirEnv: string;
    userConfigDirName: string;
}
