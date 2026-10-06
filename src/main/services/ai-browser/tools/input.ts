/**
 * Input Tools (5 tools)
 *
 * User interaction simulation: click, fill, hover, key press, file upload.
 *
 * browser_click — Click or drag-and-drop (absorbs browser_drag via dragTo param).
 * browser_fill — Single field or batch form fill (absorbs browser_fill_form via elements param).
 * browser_hover — Hover to reveal menus/tooltips.
 * browser_press_key — Keyboard keys and shortcuts.
 * browser_upload_file — File upload (single or multi-file).
 *
 * The original standalone browser_drag and browser_fill_form tools remain
 * in this file as unexported code for future extension/advanced mode.
 */

import fs from 'node:fs'
import { z } from 'zod'
import { tool } from '../../agent/resolved-sdk'
import type { BrowserContext } from '../context'
import { textResult, withTimeout, fillFormElement, TOOL_TIMEOUT } from './helpers'

export function buildInputTools(ctx: BrowserContext) {

const browser_click = tool(
  'browser_click',
  `Click on a page element identified by its uid from the latest browser_snapshot.

After clicking, the page often changes — new content loads, navigation occurs, modals appear. Always take a fresh browser_snapshot after clicking to see the updated state and get new valid UIDs.

If the click doesn't produce the expected result:
1. Re-snapshot to verify the element is still present and visible.
2. Check if the element is obscured by an overlay, modal, or cookie banner — close the obstruction first.
3. Try browser_hover first to trigger any prerequisite hover state.
4. Try browser_press_key with "Enter" after focusing the element.

For drag-and-drop operations, provide the dragTo parameter with the target element's uid.`,
  {
    uid: z.string().describe(
      'The uid of the element to click, from the most recent browser_snapshot.'
    ),
    dblClick: z.boolean().optional().describe(
      'Double-click instead of single click. Use for text selection or elements requiring double-click activation.'
    ),
    dragTo: z.string().optional().describe(
      'Target element uid for drag-and-drop. The element at uid is dragged onto the element at dragTo.'
    )
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page. Use browser_navigate first.', true)
    }

    try {
      // Drag-and-drop mode
      if (args.dragTo) {
        await withTimeout(
          ctx.dragElement(args.uid, args.dragTo),
          TOOL_TIMEOUT,
          'browser_click(drag)'
        )
        return textResult('Successfully dragged element to target.')
      }

      // Standard click
      await withTimeout(
        ctx.clickElement(args.uid, { dblClick: args.dblClick || false }),
        TOOL_TIMEOUT,
        'browser_click'
      )
      return textResult(
        args.dblClick
          ? 'Successfully double clicked on the element.'
          : 'Successfully clicked on the element.'
      )
    } catch (error) {
      return textResult(`Click failed on ${args.uid}: ${(error as Error).message}`, true)
    }
  }
)

const browser_fill = tool(
  'browser_fill',
  `Enter text into input fields, text areas, or select options from dropdown elements. Supports both single field and batch mode.

Single field: provide uid + value.
Batch fill: provide elements array — more efficient than multiple single calls for forms.

Behavior by element type:
- <input> (text, email, password, etc.): clears existing value, then types the new text.
- <textarea>: clears and types.
- <select> / combobox: selects the option matching the value text.

Typed text is read back from the field. When the field ends up holding something else (reformatted, cut short, refused, or appended to old text), the result reports what it holds instead of success.

After filling, the form is NOT automatically submitted. Use browser_click on the submit button, or browser_press_key with "Enter" if the form supports it.

If filling doesn't work (e.g., custom dropdowns that aren't real <select> elements):
1. browser_click on the dropdown to open it.
2. browser_snapshot to see the options.
3. browser_click on the desired option.`,
  {
    uid: z.string().optional().describe(
      'The uid of the element to fill, from the latest browser_snapshot. Required for single-field mode.'
    ),
    value: z.string().optional().describe(
      'The value to enter. For <select>/combobox, match the visible option text. Required for single-field mode.'
    ),
    elements: z.array(z.object({
      uid: z.string().describe('The uid of the element to fill.'),
      value: z.string().describe('Value for the element.')
    })).min(1).optional().describe(
      'Batch mode: array of { uid, value } objects to fill multiple fields at once. When provided, top-level uid and value are ignored.'
    )
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    // --- Batch mode ---
    if (args.elements && args.elements.length > 0) {
      const errors: string[] = []
      const unconfirmed: string[] = []

      for (const elem of args.elements) {
        try {
          const check = await withTimeout(
            fillFormElement(ctx, elem.uid, elem.value),
            TOOL_TIMEOUT,
            'browser_fill(batch)'
          )
          if (check.status === 'different') errors.push(`${elem.uid}: ${check.detail}`)
          else if (check.status === 'unreadable') unconfirmed.push(`${elem.uid}: ${check.detail}`)
        } catch (error) {
          errors.push(`${elem.uid}: ${(error as Error).message}`)
        }
      }

      const unconfirmedNote = unconfirmed.length > 0 ? `\n\nUnconfirmed:\n${unconfirmed.join('\n')}` : ''
      if (errors.length > 0) {
        return textResult(
          `Partially filled form (${args.elements.length - errors.length}/${args.elements.length} succeeded).\n\nErrors:\n${errors.join('\n')}${unconfirmedNote}`,
          errors.length === args.elements.length // isError only if ALL failed
        )
      }
      if (unconfirmed.length > 0) {
        return textResult(`Filled ${args.elements.length} form fields; ${unconfirmed.length} could not be read back.${unconfirmedNote}`)
      }

      return textResult(`Successfully filled ${args.elements.length} form fields.`)
    }

    // --- Single field mode ---
    if (!args.uid) {
      return textResult(
        'Provide uid + value for a single field, or elements array for batch mode.',
        true
      )
    }
    if (args.value === undefined) {
      return textResult('value is required when using single-field mode (uid provided).', true)
    }

    try {
      const check = await withTimeout(
        fillFormElement(ctx, args.uid, args.value),
        TOOL_TIMEOUT,
        'browser_fill'
      )
      if (check.status === 'different') return textResult(`Filled ${args.uid}, but ${check.detail}`, true)
      if (check.status === 'unreadable') return textResult(`Typed into ${args.uid}, but ${check.detail}`)
      return textResult('Successfully filled the element.')
    } catch (error) {
      return textResult(`Fill failed on ${args.uid}: ${(error as Error).message}`, true)
    }
  }
)

const browser_hover = tool(
  'browser_hover',
  `Move the mouse over an element without clicking. Use this to:
- Reveal dropdown menus or submenus that appear on hover.
- Trigger tooltips or popover content.
- Expose hidden action buttons (e.g., edit/delete icons that appear on row hover).

After hovering, take a browser_snapshot to see newly revealed content and get UIDs for elements that appeared.`,
  {
    uid: z.string().describe(
      'The uid of the element to hover over, from the latest browser_snapshot.'
    )
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      await withTimeout(
        ctx.hoverElement(args.uid),
        TOOL_TIMEOUT,
        'browser_hover'
      )
      return textResult('Successfully hovered over the element.')
    } catch (error) {
      return textResult(`Hover failed on ${args.uid}: ${(error as Error).message}`, true)
    }
  }
)

const browser_press_key = tool(
  'browser_press_key',
  `Press a keyboard key or key combination. Use for actions that browser_fill cannot handle:
- Submit forms: "Enter"
- Keyboard shortcuts: "Control+A", "Control+C", "Control+V"
- Navigation keys: "Tab", "Escape", "ArrowDown", "ArrowUp"
- Special actions: "Control+Shift+R" (hard reload), "Meta+K" (search)

Modifier keys: Control, Shift, Alt, Meta (Cmd on macOS). Combine with "+": "Control+A", "Control+Shift+T".

Prefer browser_fill for entering text into fields. Use press_key only for modifier keys, Enter, Escape, arrow keys, and keyboard shortcuts.`,
  {
    key: z.string().describe(
      'Key or combination to press. Examples: "Enter", "Tab", "Escape", "Control+A", "Control+Shift+R". Modifiers: Control, Shift, Alt, Meta.'
    )
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      await withTimeout(
        ctx.pressKey(args.key),
        TOOL_TIMEOUT,
        'browser_press_key'
      )
      return textResult(`Successfully pressed key: ${args.key}`)
    } catch (error) {
      return textResult(`Key press failed: ${(error as Error).message}`, true)
    }
  }
)

const browser_upload_file = tool(
  'browser_upload_file',
  `Upload files through a file input element or a button that opens a file chooser. Supports single file (string path) or multiple files (array of paths).

All files must exist on the local filesystem. After uploading, take a browser_snapshot to verify the upload was accepted — look for filename display, preview thumbnails, or status indicators.`,
  {
    uid: z.string().describe(
      'The uid of the file input element or the button that opens the file chooser.'
    ),
    filePath: z.union([z.string(), z.array(z.string()).min(1)])
      .describe('Local file path (string) or array of paths (string[]) to upload.')
  },
  async (args) => {
    if (!ctx.getActiveViewId()) {
      return textResult('No active browser page.', true)
    }

    try {
      // Normalize to array for uniform handling
      const filePaths = Array.isArray(args.filePath) ? args.filePath : [args.filePath]

      // Validate all files exist
      const missing = filePaths.filter(p => !fs.existsSync(p))
      if (missing.length > 0) {
        return textResult(`File(s) not found: ${missing.join(', ')}`, true)
      }

      const element = ctx.getElementByUid(args.uid)
      if (!element) {
        return textResult(`Element not found: ${args.uid}`, true)
      }

      await withTimeout(
        ctx.sendCDPCommand('DOM.setFileInputFiles', {
          backendNodeId: element.backendNodeId,
          files: filePaths
        }),
        TOOL_TIMEOUT,
        'browser_upload_file'
      )

      return filePaths.length === 1
        ? textResult(`Uploaded 1 file: ${filePaths[0]}`)
        : textResult(`Uploaded ${filePaths.length} files: ${filePaths.join(', ')}`)
    } catch (error) {
      return textResult(`Upload failed: ${(error as Error).message}`, true)
    }
  }
)

return [
  browser_click,
  browser_fill,
  browser_hover,
  browser_press_key,
  browser_upload_file
]

} // end buildInputTools
