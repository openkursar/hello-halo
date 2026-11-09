#!/usr/bin/env tsx
/**
 * swe-eval CLI root — Commander.js entry point.
 */

import { Command } from 'commander'
import { runCommand } from './run.ts'
import { evalCommand } from './eval.ts'
import { statusCommand } from './status.ts'
import { reportCommand } from './report.ts'

const program = new Command()
  .name('swe-eval')
  .description('SWE-Bench Verified evaluation harness for Agent SDK')
  .version('1.0.0')

program.addCommand(runCommand)
program.addCommand(evalCommand)
program.addCommand(statusCommand)
program.addCommand(reportCommand)

program.parseAsync(process.argv)
