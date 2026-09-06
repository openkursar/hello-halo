/**
 * Capability groups an agent navigates by. Deliberately decoupled from the
 * routes files: files are organised for whoever maintains them, groups are
 * organised for whoever is looking for a capability, and those two rarely
 * agree. Internal code names never appear here.
 *
 * `notHere` is what makes a wrong guess cheap — it redirects on the spot
 * instead of leaving the agent to conclude Halo cannot do the thing.
 */

import type { GroupId, GroupMeta } from './_meta-types'

export const GROUPS: Record<GroupId, GroupMeta> = {
  conversation: {
    title: 'conversation — talk to Halo, drive and inspect chat sessions',
    covers:
      'stop or cancel whatever Halo is currently doing, see what is still running, list and read conversations, rename, star and delete them',
    notHere: {
      'chatting with a digital human': 'digital-human',
      'files produced during a conversation': 'workspace',
      'which model this conversation uses': 'settings',
      'inbound messages from IM platforms': 'channels',
      'sending a notification out to the user': 'tool:notify_channel',
    },
    withheld: [
      'Start a new Halo turn, or answer a pending question on the user\'s behalf — the user does this by typing in the conversation.',
    ],
    noEndpoint: {
      'exporting a conversation to a file':
        'There is no export endpoint. Read it with GET /api/spaces/:spaceId/conversations/:conversationId and write the file yourself.',
    },
  },
  workspace: {
    title: 'workspace — spaces and the files they hold',
    covers:
      'create, rename, reorder and delete spaces, space settings and working directory, browse and read produced files and artifacts',
    notHere: {
      'documents indexed for retrieval': 'knowledge-base',
      'digital humans living in a space': 'digital-human',
      'stopping a running task': 'conversation',
      'running shell commands in the working directory': 'terminal',
    },
  },
  'digital-human': {
    title: 'digital-human — create, run and configure digital humans',
    covers:
      'install and uninstall, pause and resume, manual trigger, schedule and user config, chat with a digital human, run history and activity',
    notHere: {
      'binding a digital human to an IM chat': 'channels',
      'files a digital human produced': 'workspace',
      'installing from the app store': 'store',
      'knowledge a digital human reads': 'knowledge-base',
    },
  },
  'knowledge-base': {
    title: 'knowledge-base — document collections agents can search',
    covers:
      'create and delete collections, bind them to a space, import and remove documents, indexing progress and status',
    notHere: {
      'ordinary files in a space': 'workspace',
      'digital humans that read a collection': 'digital-human',
    },
  },
  channels: {
    title: 'channels — inbound IM channels and outbound notifications',
    covers:
      'connect and disconnect IM channels, bind a chat to a digital human, list bound sessions, configure and test outbound notification channels',
    notHere: {
      'the digital human on the other end of a channel': 'digital-human',
      'model providers and API keys': 'settings',
    },
    withheld: [
      'Pair a brand-new WeCom bot or WeChat personal account (QR-code pairing) — none of that flow is open to you. The user does the whole thing in Settings > Message Channels on the desktop app.',
    ],
  },
  settings: {
    title: 'settings — Halo version and model capability reference',
    covers: 'application version, model capability presets',
    notHere: {
      'per-space settings': 'workspace',
      'per-digital-human config': 'digital-human',
      'notification channel setup, IM accounts, bot binding': 'channels',
      'sending a notification': 'tool:notify_channel',
      'stopping something Halo is doing': 'conversation',
      'installing or updating store items': 'store',
      'knowledge collection settings': 'knowledge-base',
      'where a space keeps its files': 'workspace',
    },
    withheld: [
      'Add, edit or delete a model source, or change an API key — the user does this in Settings > AI Model.',
      'Change remote-access settings (port, token, tunnel) — the user does this in Settings > Remote Access, on the desktop app only; it is not in the remote web UI.',
      'Test or diagnose a configured MCP server connection — the user does this in Settings > Advanced.',
    ],
    noEndpoint: {
      'updating Halo itself':
        'Halo updates itself; there is no upgrade endpoint. /api/store/updates covers installed store items, not the app. Tell the user Halo updates on its own.',
    },
  },
  store: {
    title: 'store — browse and install from the app store',
    covers:
      'browse and search store listings, read a listing, install and uninstall store items, skills',
    notHere: {
      'configuring an installed digital human': 'digital-human',
      'knowledge collections': 'knowledge-base',
      'installing or removing a skill': 'tool:skill_manage',
    },
  },
  terminal: {
    title: 'terminal — interactive shell sessions',
    covers: 'create a session, write input, read output, close a session',
    notHere: {
      'reading files without a shell': 'workspace',
    },
    noEndpoint: {
      'running a command for yourself':
        'Use your own Bash tool. This API drives the terminal the user watches and types into; it is for handing a session to them, not for getting work done.',
    },
  },
}
