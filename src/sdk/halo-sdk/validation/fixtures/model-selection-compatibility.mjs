import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const sdk = await import(pathToFileURL(resolve(process.argv[2])).href);
const inputs = {
  spawn_agent: { prompt: 'Keep the exact assignment.\nDo not change its scope.', name: 'reader' },
  team_send: { to: 'reader', message: ' Keep this input.\n' },
  team_read_board: { mine: true, status: 'in_progress' },
  team_read_member: { member: 'reader', before: 2 },
  team_post_finding: { content: 'Evidence', ref: 'report.txt' },
  team_read_artifact: { ref: 'report.txt' },
  team_post_task: { title: 'Verify', assignee: 'reader' },
  team_update_task: { taskId: 'task', status: 'done', note: 'Verified.' },
  team_stop: { to: 'reader' },
};
const rejected = ['model_profile', 'reasoning_effort', 'model', 'apiKey', 'caller', 'permissions'].map(field => {
  try { return { field, value: sdk.parseCollaborationInput('spawn_agent', { prompt: 'Work.', [field]: 'override' }) }; }
  catch (error) { return { field, error: { code: error.code, message: error.message } }; }
});
process.stdout.write(JSON.stringify({
  names: sdk.COLLABORATION_TOOL_NAMES,
  guidance: sdk.COLLABORATION_GUIDANCE,
  definitions: sdk.COLLABORATION_TOOL_NAMES.map(name => sdk.describeCollaborationTool(name)),
  parsed: Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, sdk.parseCollaborationInput(name, input)])),
  rejected,
}));
