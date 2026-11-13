import type { SlashCommand } from '../types/config.js';
import type { Command, CommandBase, SlashCommandContext, SlashCommandResult } from '../commands/types.js';
import type { BuildSessionRegistryOptions } from '../commands/index.js';
import type { CommandRegistry as RegistryContract } from '../commands/registry.js';
import type { Message } from '../types/provider.js';
import { loadBinding, nativeError, parseNativeValue, stringifyNativeValue, type NativeValueHandle } from './binding.js';
import { builtinCommandMetadata } from './generated/commands.js';

interface CommandBinding {
  NativeCommandRegistry: new() => NativeValueHandle;
  commandValue(method: string, payload: string): string;
}
function binding(): CommandBinding { return loadBinding() as unknown as CommandBinding; }
function value<T>(method: string, args: unknown[]): T {
  try { return parseNativeValue(binding().commandValue(method, stringifyNativeValue(args))) as T; }
  catch (error) { throw nativeError(error); }
}
function metadata(command: Command, name = command.name): unknown { return { name, aliases: command.aliases }; }

export type CommandRegistry = RegistryContract;
export const CommandRegistry = class CommandRegistry {
  private readonly handle: NativeValueHandle;
  private readonly identities = new WeakMap<object, string>();
  private readonly references = new Map<string, { command: Command; count: number }>();
  private nextIdentity = 0;
  constructor(initial: readonly Command[] = []) {
    this.handle = new (binding().NativeCommandRegistry)();
    for (const command of initial) this.register(command);
  }
  private call<T>(method: string, args: unknown): T {
    try { return parseNativeValue(this.handle.call(method, stringifyNativeValue(args))) as T; }
    catch (error) { throw nativeError(error); }
  }
  private reference(command: Command): string {
    let id = this.identities.get(command);
    if (!id) { id = String(++this.nextIdentity); this.identities.set(command, id); }
    if (!this.references.has(id)) this.references.set(id, { command, count: 0 });
    return id;
  }
  private release(id: string | undefined): void {
    if (id === undefined) return;
    const reference = this.references.get(id);
    if (reference && --reference.count === 0) this.references.delete(id);
  }
  register(command: Command): void {
    const name = command.name;
    const previousId = this.call<string | undefined>('canonical', [name.toLowerCase()]);
    const previous = previousId === undefined ? undefined : metadata(this.references.get(previousId)!.command);
    const id = this.reference(command);
    try {
      const removed = this.call<string | undefined>('register', { reference: id, metadata: metadata(command, name), previous });
      this.references.get(id)!.count++; this.release(removed);
    } catch (error) {
      const retained = this.call<string[]>('list', []);
      for (const [id, reference] of this.references) {
        reference.count = retained.filter(value => value === id).length;
        if (reference.count === 0) this.references.delete(id);
      }
      throw error;
    }
  }
  unregister(name: string): boolean {
    const key = name.toLowerCase();
    const id = this.call<string | undefined>('canonical', [key]);
    if (id === undefined) return false;
    const removed = this.call<string | undefined>('unregister', { name: key, current: metadata(this.references.get(id)!.command) });
    this.release(removed); return true;
  }
  get(name: string): Command | undefined {
    const id = this.call<string | undefined>('get', [name.toLowerCase()]);
    return id === undefined ? undefined : this.references.get(id)!.command;
  }
  has(name: string): boolean { return this.get(name) !== undefined; }
  list(): readonly Command[] { return Object.freeze(this.call<string[]>('list', []).map(id => this.references.get(id)!.command)); }
  listUserInvocable(): readonly Command[] { return Object.freeze(filterUserInvocable(this.list())); }
  size(): number { return this.call('size', []); }
  clear(): void { this.call('clear', []); this.references.clear(); }
} as unknown as typeof RegistryContract;

async function executeBuiltin(name: string, args: string, context: SlashCommandContext): Promise<SlashCommandResult | Message[]> {
  const fields = value<string[]>('fields', [name]);
  const snapshot = Object.fromEntries(fields.map(field => [field,
    field === 'cost' ? context.getCostSnapshot() : field === 'commands'
      ? context.commands.map(command => ({ name: command.name, description: command.description, argumentHint: command.argumentHint }))
      : context[field as keyof SlashCommandContext]]));
  const plan = value<{ result: SlashCommandResult | Message[]; effects: Array<{ method: 'clearMessages' | 'compactSession' | 'setModel'; args: any[]; wait: boolean }> }>('builtin', [name, args, snapshot]);
  for (const effect of plan.effects) {
    const operation = (context[effect.method] as (...args: any[]) => unknown).apply(context, effect.args);
    if (effect.wait) await operation;
  }
  return plan.result;
}

export const BUILT_IN_COMMANDS: readonly Command[] = Object.freeze(builtinCommandMetadata.map(metadata => {
  const command = { ...metadata, ...('aliases' in metadata ? { aliases: [...metadata.aliases] } : {}) } as Command;
  const name = command.name;
  if (command.type === 'local') command.call = (args, context) => executeBuiltin(name, args, context) as Promise<SlashCommandResult>;
  else command.getPromptForCommand = (args, context) => executeBuiltin(name, args, context) as Promise<Message[]>;
  return command;
}));
export const BUILT_IN_COMMAND_NAMES: ReadonlySet<string> = Object.freeze(new Set(BUILT_IN_COMMANDS.flatMap(command => [command.name, ...(command.aliases ?? [])])));
export const globalRegistry: CommandRegistry = new CommandRegistry(BUILT_IN_COMMANDS);
export function getBuiltInCommands(): readonly Command[] { return BUILT_IN_COMMANDS; }
export function getCommandName(command: CommandBase): string { return command.name; }
export function isCommandEnabled(command: CommandBase): boolean { return command.isEnabled?.() ?? true; }
export function isCommand(input: unknown): input is Command {
  return value('isCommand', [input && typeof input === 'object' ? {
    name: (input as Command).name, description: (input as Command).description, type: (input as Command).type,
  } : input]);
}
export function filterUserInvocable(commands: readonly Command[]): Command[] {
  return commands.filter(command => value<boolean>('eligible', [{ userInvocable: command.userInvocable, isHidden: command.isHidden }]) && isCommandEnabled(command));
}
export function toSlashCommand(command: Command): SlashCommand {
  return value('slash', [{ name: command.name, description: command.description, argumentHint: command.argumentHint }]);
}
export function toSlashCommandList(commands: readonly Command[]): SlashCommand[] { return commands.map(toSlashCommand); }
export function normalizeUserCommands(input: ReadonlyArray<string | SlashCommand | Command> | undefined): Command[] {
  const snapshots = input?.map(entry => entry && typeof entry === 'object'
    ? { name: entry.name, description: entry.description, argumentHint: entry.argumentHint,
      type: (entry as Command).type, source: (entry as Command).source }
    : entry);
  const receipts = value<Array<{ index: number; kind: 'string' | 'copy' | 'wire'; value: Command }>>('normalize', [snapshots]);
  return receipts.map(receipt => {
    const original = input![receipt.index];
    if (receipt.kind === 'copy') return { ...(original as Command), source: receipt.value.source } as Command;
    if (receipt.kind === 'wire') return { ...receipt.value, argumentHint: (original as SlashCommand).argumentHint };
    return receipt.value;
  });
}
export function createSessionRegistry(commands: readonly Command[] = []): CommandRegistry {
  const registry = new CommandRegistry(BUILT_IN_COMMANDS); commands.forEach(command => registry.register(command)); return registry;
}
export function buildSessionRegistry(input?: BuildSessionRegistryOptions | ReadonlyArray<string | SlashCommand | Command>): CommandRegistry {
  const options: BuildSessionRegistryOptions = input == null ? {} : Array.isArray(input) ? { user: input } : input as BuildSessionRegistryOptions;
  const registry = createSessionRegistry(); options.skills?.forEach(command => registry.register(command));
  normalizeUserCommands(options.user).forEach(command => registry.register(command)); return registry;
}
export function resolveCommand(registry: CommandRegistry, name: string): Command | undefined { return registry.get(name); }
export function listUserInvocableSlashCommands(registry: CommandRegistry): SlashCommand[] { return toSlashCommandList(registry.listUserInvocable()); }
export function listUserInvocableNames(registry: CommandRegistry): string[] { return registry.listUserInvocable().map(getCommandName); }
