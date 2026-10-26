import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'

try {
  const { values } = parseArgs({ options: {
    directory: { type: 'string' }, repository: { type: 'string' }, name: { type: 'string' },
    labels: { type: 'string', default: 'acceptance' }, execute: { type: 'boolean', default: false },
  } })
  if (!values.directory) throw new Error('--directory must name a separately extracted official runner distribution.')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository ?? '')) throw new Error('--repository must be owner/repository.')
  if (!/^[A-Za-z0-9_.-]+$/.test(values.name ?? '')) throw new Error('--name must be a runner name containing letters, digits, dot, dash or underscore.')
  if (!/^[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*$/.test(values.labels)) throw new Error('--labels must be comma-separated labels without spaces.')
  if (process.platform === 'win32') throw new Error('This registration helper targets macOS/Linux. Configure a Windows interactive runner with GitHub’s Windows instructions.')
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error('Register from the dedicated test account, not root.')
  const directory = fs.realpathSync(values.directory)
  for (const file of ['.runner', '.credentials', '.service']) {
    if (fs.existsSync(path.join(directory, file))) throw new Error('This runner directory is already configured. Use a new directory; existing runners are never replaced.')
  }
  const config = path.join(directory, 'config.sh')
  if (!fs.existsSync(config)) throw new Error('The runner distribution is missing config.sh.')
  const args = ['--unattended', '--url', `https://github.com/${values.repository}`, '--name', values.name, '--labels', values.labels, '--work', '_work']
  if (!values.execute) {
    console.log(JSON.stringify({ executable: 'config.sh', args, account: 'current operating-system user', installsService: false }, null, 2))
    console.log('Preview only. Run in the dedicated account and add --execute after authorizing runner registration.')
  } else {
    let token = process.env.ACTIONS_RUNNER_INPUT_TOKEN
    if (!token) {
      const result = spawnSync('gh', ['api', '--method', 'POST', `repos/${values.repository}/actions/runners/registration-token`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (result.error || result.status !== 0) throw new Error('Could not obtain a runner registration token; repository runner-management permission is required.')
      token = JSON.parse(result.stdout).token
    }
    if (!token || /[\r\n\0]/.test(token)) throw new Error('Runner registration token is missing or invalid.')
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ACTIONS_RUNNER_INPUT_')))
    environment.ACTIONS_RUNNER_INPUT_TOKEN = token
    delete environment.GH_TOKEN
    delete environment.GITHUB_TOKEN
    const result = spawnSync(config, args, { cwd: directory, env: environment, stdio: 'inherit' })
    if (result.error || result.status !== 0) throw new Error(`Runner registration failed (${result.error?.message ?? result.status}).`)
    console.log('Dedicated runner registered. Start and validate it in the test account’s GUI session before installing its user service.')
  }
} catch (error) {
  console.error(`[Acceptance CI] ${error.message}`)
  process.exitCode = 1
}
