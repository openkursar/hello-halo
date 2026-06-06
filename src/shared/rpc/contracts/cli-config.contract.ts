/**
 * CLI-config RPC contract (passthrough — handler bodies preserved). Claude CLI
 * config-dir management + Skills/MCP migration.
 */
import { rawRpcMethod } from '../define'

export const cliConfigRpc = {
  cliConfigGetPaths: rawRpcMethod('cli-config:get-paths'),
  cliConfigScanSkills: rawRpcMethod('cli-config:scan-skills'),
  cliConfigMigrateSkills: rawRpcMethod('cli-config:migrate-skills'),
  cliConfigScanMcp: rawRpcMethod('cli-config:scan-mcp'),
  cliConfigMigrateMcp: rawRpcMethod('cli-config:migrate-mcp'),
  cliConfigSetConfigDir: rawRpcMethod('cli-config:set-config-dir'),
}
