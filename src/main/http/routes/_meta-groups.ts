/**
 * Manual-page furniture for each capability group: where a wrong guess is
 * redirected, what this build withholds, and what has no endpoint at all.
 * Deliberately decoupled from the routes files: files are organised for
 * whoever maintains them, groups are organised for whoever is looking for a
 * capability, and those two rarely agree. Internal code names never appear
 * here.
 *
 * What a group *is* lives in `services/api-ref/groups.ts` — that half is read
 * while choosing a group, this half only once a page is open.
 *
 * `notHere` is what makes a wrong guess cheap — it redirects on the spot
 * instead of leaving the agent to conclude Halo cannot do the thing.
 */

import type { GroupId, GroupMeta } from './_meta-types'

export const GROUPS: Record<GroupId, GroupMeta> = {
  conversation: {
    notHere: {
      'chatting with a digital human': 'digital-human',
      'files produced during a conversation': 'workspace',
      'which model this conversation uses': 'settings',
      'inbound messages from IM platforms': 'channels',
      'sending a notification out to the user': 'tool:notify_channel',
    },
    withheld: [
      'Answer a pending question on the user\'s behalf — Halo stopped to ask precisely because it needed a person, so the user answers it in the conversation.',
      'Open or close a toolset. Reading which are open is fine; flipping one is the user\'s, and the request_toolset tool is how you ask them to.',
    ],
    noEndpoint: {
      'exporting a conversation to a file':
        'There is no export endpoint. Read it with GET /api/spaces/:spaceId/conversations/:conversationId and write the file yourself.',
    },
  },
  workspace: {
    notHere: {
      'documents indexed for retrieval': 'knowledge-base',
      'digital humans living in a space': 'digital-human',
      'stopping a running task': 'conversation',
      'running shell commands in the working directory': 'terminal',
    },
    withheld: [
      'Download a file, or a whole space, as bytes — those routes answer outside this API\'s JSON envelope, so they are closed to you. Read the file instead, or use your own file tools.',
    ],
  },
  'digital-human': {
    notHere: {
      'binding a digital human to an IM chat': 'channels',
      'files a digital human produced': 'workspace',
      'installing from the app store': 'store',
      'knowledge a digital human reads': 'knowledge-base',
    },
  },
  'knowledge-base': {
    notHere: {
      'ordinary files in a space': 'workspace',
      'digital humans that read a collection': 'digital-human',
    },
  },
  channels: {
    notHere: {
      'the digital human on the other end of a channel': 'digital-human',
      'model providers and API keys': 'settings',
    },
    withheld: [
      'Pair a brand-new WeCom bot or WeChat personal account (QR-code pairing) — none of that flow is open to you. The user does the whole thing in Settings > Message Channels on the desktop app.',
      'Create a channel instance, or set up a notification channel (SMTP for email, a webhook URL, a bot key) — the user does this in Settings > Message Channels. The only write path behind it replaces the whole configuration in one call, so a partial write would drop their other channels.',
    ],
  },
  settings: {
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
      'Add a model source, change an API key, or test one — all need the key in plaintext, so the user does it in Settings > AI Model rather than sending a secret into this conversation.',
      'Change any other setting — appearance, permissions, system behaviour. They share one write endpoint that replaces whole branches of the configuration at once, so it stays closed rather than risk dropping settings nobody asked you to touch. Settings, in the Halo app.',
      'Change remote-access settings (port, token, tunnel) — the user does this in Settings > Remote Access, on the desktop app only; it is not in the remote web UI.',
    ],
    noEndpoint: {
      'updating Halo itself':
        'Halo updates itself; there is no upgrade endpoint. /api/store/updates covers installed store items, not the app. Tell the user Halo updates on its own.',
    },
  },
  store: {
    notHere: {
      'configuring an installed digital human': 'digital-human',
      'knowledge collections': 'knowledge-base',
      'installing or removing a skill': 'tool:skill_manage',
    },
    withheld: [
      'Publish something to the store, or export a digital human definition to a file — the user does both in the Halo app. Publishing is public and cannot be taken back, and an exported definition carries whatever credentials the app holds.',
    ],
  },
  terminal: {
    notHere: {
      'reading files without a shell': 'workspace',
    },
    noEndpoint: {
      'running a command for yourself':
        'Use your own Bash tool. This API drives the terminal the user watches and types into; it is for handing a session to them, not for getting work done.',
    },
  },
}
