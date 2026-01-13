/**
 * Accessibility Snapshot - Core a11y tree implementation
 *
 * Provides the foundation for AI Browser interactions by:
 * 1. Capturing the accessibility tree via CDP
 * 2. Converting it to a structured format with unique IDs
 * 3. Formatting it as text for AI consumption
 *
 * The snapshot allows AI to reference elements by UID without
 * needing to understand CSS selectors or DOM structure.
 */

import type { WebContents } from 'electron'
import type { AccessibilityNode, AccessibilitySnapshot } from './types'

// Counter for generating unique snapshot IDs
let snapshotCounter = 0

/**
 * CDP AXNode structure from Accessibility.getFullAXTree
 */
interface CDPAXNode {
  nodeId: string
  ignored: boolean
  ignoredReasons?: Array<{ name: string; value?: { type: string; value?: string } }>
  role?: { type: string; value: string }
  name?: { type: string; value: string; sources?: Array<{ type: string; value?: { type: string; value: string } }> }
  description?: { type: string; value: string }
  value?: { type: string; value: string | number | boolean }
  properties?: Array<{
    name: string
    value: { type: string; value: string | number | boolean }
  }>
  childIds?: string[]
  backendDOMNodeId?: number
  parentId?: string
  frameId?: string
}

/**
 * CDP AXTree response
 */
interface CDPAXTreeResponse {
  nodes: CDPAXNode[]
}

/**
 * Role names to include in the snapshot (interactive elements)
 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'gridcell',
  'columnheader',
  'rowheader',
])

/**
 * Roles to always include (structural/informational)
 */
const STRUCTURAL_ROLES = new Set([
  'heading',
  'img',
  'figure',
  'table',
  'list',
  'listitem',
  'navigation',
  'main',
  'article',
  'region',
  'banner',
  'contentinfo',
  'complementary',
  'form',
  'search',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'tooltip',
  'progressbar',
  'meter',
])

/**
 * Create an accessibility snapshot from a WebContents
 */
export async function createAccessibilitySnapshot(
  webContents: WebContents,
  verbose: boolean = false
): Promise<AccessibilitySnapshot> {
  const snapshotId = `snap_${++snapshotCounter}`
  const idToNode = new Map<string, AccessibilityNode>()
  let nodeIndex = 0

  // Ensure debugger is attached
  try {
    webContents.debugger.attach('1.3')
  } catch (e) {
    // Already attached
  }

  try {
    // Get the full accessibility tree via CDP
    const response = await webContents.debugger.sendCommand(
      'Accessibility.getFullAXTree'
    ) as CDPAXTreeResponse

    if (!response?.nodes || response.nodes.length === 0) {
      throw new Error('Empty accessibility tree')
    }

    // Build node lookup
    const cdpNodeMap = new Map<string, CDPAXNode>()
    for (const node of response.nodes) {
      cdpNodeMap.set(node.nodeId, node)
    }

    // Find root node (first non-ignored node without parent)
    const rootCDPNode = response.nodes.find(
      n => !n.ignored && !n.parentId
    ) || response.nodes[0]

    // Convert CDP nodes to our format
    const convertNode = (cdpNode: CDPAXNode): AccessibilityNode | null => {
      if (cdpNode.ignored) {
        // Process children even for ignored nodes
        const children: AccessibilityNode[] = []
        if (cdpNode.childIds) {
          for (const childId of cdpNode.childIds) {
            const childCDPNode = cdpNodeMap.get(childId)
            if (childCDPNode) {
              const childNode = convertNode(childCDPNode)
              if (childNode) {
                children.push(childNode)
              }
            }
          }
        }
        // Return children without wrapper if node is ignored
        if (children.length === 1) {
          return children[0]
        }
        // For multiple children, create a generic container
        if (children.length > 1) {
          const uid = `${snapshotId}_${nodeIndex++}`
          const node: AccessibilityNode = {
            uid,
            role: 'group',
            name: '',
            children,
            backendNodeId: cdpNode.backendDOMNodeId || 0,
          }
          idToNode.set(uid, node)
          return node
        }
        return null
      }

      const role = cdpNode.role?.value || 'generic'
      const name = cdpNode.name?.value || ''

      // Skip empty text nodes and generic containers in non-verbose mode
      if (!verbose) {
        const isInteractive = INTERACTIVE_ROLES.has(role)
        const isStructural = STRUCTURAL_ROLES.has(role)
        const hasName = name.trim().length > 0

        // Skip nodes that aren't interactive, structural, or named
        if (!isInteractive && !isStructural && !hasName && role === 'generic') {
          // Still process children
          const children: AccessibilityNode[] = []
          if (cdpNode.childIds) {
            for (const childId of cdpNode.childIds) {
              const childCDPNode = cdpNodeMap.get(childId)
              if (childCDPNode) {
                const childNode = convertNode(childCDPNode)
                if (childNode) {
                  children.push(childNode)
                }
              }
            }
          }
          if (children.length === 1) return children[0]
          if (children.length > 1) {
            const uid = `${snapshotId}_${nodeIndex++}`
            const node: AccessibilityNode = {
              uid,
              role: 'group',
              name: '',
              children,
              backendNodeId: cdpNode.backendDOMNodeId || 0,
            }
            idToNode.set(uid, node)
            return node
          }
          return null
        }
      }

      // Create the node
      const uid = `${snapshotId}_${nodeIndex++}`
      const node: AccessibilityNode = {
        uid,
        role,
        name,
        backendNodeId: cdpNode.backendDOMNodeId || 0,
        children: [],
      }

      // Extract value
      if (cdpNode.value?.value !== undefined) {
        node.value = String(cdpNode.value.value)
      }

      // Extract description
      if (cdpNode.description?.value) {
        node.description = cdpNode.description.value
      }

      // Extract properties
      if (cdpNode.properties) {
        for (const prop of cdpNode.properties) {
          switch (prop.name) {
            case 'focused':
              node.focused = prop.value.value === true
              break
            case 'checked':
              node.checked = prop.value.value === true || prop.value.value === 'true'
              break
            case 'disabled':
              node.disabled = prop.value.value === true
              break
            case 'expanded':
              node.expanded = prop.value.value === true
              break
            case 'selected':
              node.selected = prop.value.value === true
              break
            case 'required':
              node.required = prop.value.value === true
              break
            case 'level':
              node.level = Number(prop.value.value)
              break
          }
        }
      }

      // Process children
      if (cdpNode.childIds) {
        for (const childId of cdpNode.childIds) {
          const childCDPNode = cdpNodeMap.get(childId)
          if (childCDPNode) {
            const childNode = convertNode(childCDPNode)
            if (childNode) {
              node.children.push(childNode)
            }
          }
        }
      }

      // Register in lookup table
      idToNode.set(uid, node)

      return node
    }

    // Convert the tree
    const root = convertNode(rootCDPNode) || {
      uid: `${snapshotId}_0`,
      role: 'document',
      name: 'Empty page',
      children: [],
      backendNodeId: 0,
    }

    // Get page info
    const url = webContents.getURL()
    const title = webContents.getTitle()

    // Create snapshot object
    const snapshot: AccessibilitySnapshot = {
      root,
      snapshotId,
      timestamp: Date.now(),
      url,
      title,
      idToNode,
      format: function(verbose?: boolean): string {
        return formatSnapshot(this, verbose)
      }
    }

    return snapshot
  } finally {
    // Don't detach debugger - keep it attached for subsequent operations
  }
}

/**
 * Format accessibility snapshot as text for AI consumption
 * Format aligned with chrome-devtools-mcp: uid=X role "name" attributes
 */
function formatSnapshot(snapshot: AccessibilitySnapshot, verbose: boolean = false): string {
  const lines: string[] = []

  lines.push(`# Page: ${snapshot.title}`)
  lines.push(`URL: ${snapshot.url}`)
  lines.push('')

  const formatNode = (node: AccessibilityNode, indent: number = 0): void => {
    const prefix = '  '.repeat(indent)
    const attributes: string[] = []

    // Format: uid=X role "name" [attributes]
    // Aligned with chrome-devtools-mcp snapshotFormatter.ts
    attributes.push(`uid=${node.uid}`)

    // Role (use 'ignored' for 'none' role to match DevTools)
    if (node.role) {
      attributes.push(node.role === 'none' ? 'ignored' : node.role)
    }

    // Name in quotes
    if (node.name) {
      attributes.push(`"${node.name}"`)
    }

    // Boolean properties with their semantic meanings
    // Map matches chrome-devtools-mcp: disabled->disableable, expanded->expandable, etc.
    if (node.disabled !== undefined) {
      attributes.push('disableable')
      if (node.disabled) attributes.push('disabled')
    }
    if (node.expanded !== undefined) {
      attributes.push('expandable')
      if (node.expanded) attributes.push('expanded')
    }
    if (node.focused !== undefined) {
      attributes.push('focusable')
      if (node.focused) attributes.push('focused')
    }
    if (node.selected !== undefined) {
      attributes.push('selectable')
      if (node.selected) attributes.push('selected')
    }

    // Other boolean states
    if (node.checked) attributes.push('checked')
    if (node.required) attributes.push('required')

    // String/number attributes
    if (node.value !== undefined) {
      attributes.push(`value="${node.value}"`)
    }
    if (node.level !== undefined) {
      attributes.push(`level="${node.level}"`)
    }
    if (verbose && node.description) {
      attributes.push(`description="${node.description}"`)
    }

    lines.push(prefix + attributes.join(' '))

    // Process children
    for (const child of node.children) {
      formatNode(child, indent + 1)
    }
  }

  formatNode(snapshot.root)

  return lines.join('\n')
}

/**
 * Get element bounding box by backend node ID
 */
export async function getElementBoundingBox(
  webContents: WebContents,
  backendNodeId: number
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    // Ensure debugger is attached
    try {
      webContents.debugger.attach('1.3')
    } catch (e) {
      // Already attached
    }

    // Get the box model for the element
    const response = await webContents.debugger.sendCommand('DOM.getBoxModel', {
      backendNodeId
    }) as { model?: { content: number[] } }

    if (!response?.model?.content) {
      return null
    }

    // content is [x1, y1, x2, y2, x3, y3, x4, y4] - quad points
    const content = response.model.content
    const x = Math.min(content[0], content[2], content[4], content[6])
    const y = Math.min(content[1], content[3], content[5], content[7])
    const maxX = Math.max(content[0], content[2], content[4], content[6])
    const maxY = Math.max(content[1], content[3], content[5], content[7])

    return {
      x,
      y,
      width: maxX - x,
      height: maxY - y
    }
  } catch (error) {
    console.error('[Snapshot] Failed to get bounding box:', error)
    return null
  }
}

/**
 * Scroll element into view
 */
export async function scrollIntoView(
  webContents: WebContents,
  backendNodeId: number
): Promise<void> {
  try {
    // Ensure debugger is attached
    try {
      webContents.debugger.attach('1.3')
    } catch (e) {
      // Already attached
    }

    // Resolve to a RemoteObjectId for scrolling
    const resolveResponse = await webContents.debugger.sendCommand('DOM.resolveNode', {
      backendNodeId
    }) as { object?: { objectId?: string } }

    if (resolveResponse?.object?.objectId) {
      // Scroll into view using Runtime.callFunctionOn
      await webContents.debugger.sendCommand('Runtime.callFunctionOn', {
        objectId: resolveResponse.object.objectId,
        functionDeclaration: `function() {
          this.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        }`,
        awaitPromise: true
      })
    }
  } catch (error) {
    console.error('[Snapshot] Failed to scroll into view:', error)
  }
}

/**
 * Focus an element by backend node ID
 */
export async function focusElement(
  webContents: WebContents,
  backendNodeId: number
): Promise<void> {
  try {
    // Ensure debugger is attached
    try {
      webContents.debugger.attach('1.3')
    } catch (e) {
      // Already attached
    }

    await webContents.debugger.sendCommand('DOM.focus', {
      backendNodeId
    })
  } catch (error) {
    console.error('[Snapshot] Failed to focus element:', error)
  }
}
