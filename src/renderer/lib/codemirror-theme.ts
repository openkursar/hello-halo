/**
 * CodeMirror Theme for Halo
 *
 * Creates a theme that matches Halo's CSS variable-based theme system.
 * The theme automatically adapts to light/dark mode via CSS variables.
 *
 * Design principles:
 * - Use Halo CSS variables (--background, --foreground, etc.)
 * - Syntax colors complement the base theme
 * - Comfortable reading experience (proper contrast, spacing)
 * - Visual consistency with highlight.js syntax-theme.css
 */

import { EditorView } from '@codemirror/view'
import { Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

// ============================================
// Editor Theme (Structure & Colors)
// ============================================

/** Monospace stack of the CodeMirror editors (files and diffs); Windows reaches Cascadia Mono or Consolas before Courier New. */
export const EDITOR_FONT_FAMILY = "'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, 'Cascadia Mono', Consolas, 'Courier New', monospace"

/**
 * Base editor theme using Halo CSS variables
 * Uses CSS variables that automatically adapt to light/dark mode
 */
export const haloEditorTheme = EditorView.theme(
  {
    // Main editor container
    '&': {
      height: '100%',
      fontSize: '13px',
      fontFamily: EDITOR_FONT_FAMILY,
      backgroundColor: 'hsl(var(--background))',
      color: 'hsl(var(--foreground))',
    },

    // Content area
    '.cm-content': {
      padding: '16px 0',
      caretColor: 'hsl(var(--primary))',
      fontFamily: 'inherit',
      lineHeight: '1.6',
    },

    // Scroller (virtual scrolling container)
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'inherit',
    },

    // Suppress the white corner box that appears at the intersection of
    // horizontal + vertical scrollbars in webkit browsers.
    '.cm-scroller::-webkit-scrollbar-corner': {
      backgroundColor: 'hsl(var(--background))',
    },

    // Cursor
    '&.cm-focused .cm-cursor': {
      borderLeftColor: 'hsl(var(--primary))',
      borderLeftWidth: '2px',
    },

    // Selection
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'hsl(var(--primary) / 0.2)',
    },

    // Gutters (line numbers, fold markers)
    '.cm-gutters': {
      backgroundColor: 'hsl(var(--background))',
      borderRight: '1px solid hsl(var(--border) / 0.5)',
      color: 'hsl(var(--muted-foreground) / 0.5)',
      fontFamily: 'inherit',
    },

    // Line numbers
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 12px 0 16px',
      minWidth: '40px',
      textAlign: 'right',
    },

    // Fold gutter
    '.cm-foldGutter .cm-gutterElement': {
      padding: '0 4px',
      cursor: 'pointer',
      color: 'hsl(var(--muted-foreground) / 0.4)',
      transition: 'color 0.15s ease',
    },

    '.cm-foldGutter .cm-gutterElement:hover': {
      color: 'hsl(var(--foreground))',
    },

    // Active line highlighting
    '.cm-activeLine': {
      backgroundColor: 'hsl(var(--muted) / 0.3)',
    },

    '.cm-activeLineGutter': {
      backgroundColor: 'hsl(var(--muted) / 0.3)',
      color: 'hsl(var(--foreground) / 0.7)',
    },

    // Matching brackets
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: 'hsl(var(--primary) / 0.2)',
      outline: '1px solid hsl(var(--primary) / 0.5)',
    },

    // Search panel container
    '.cm-panels': {
      backgroundColor: 'hsl(var(--card))',
      borderBottom: '1px solid hsl(var(--border))',
    },

    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid hsl(var(--border))',
    },

    // Search panel layout
    // Tailwind Preflight resets margin/padding/background on native elements,
    // so we must fully specify layout here instead of relying on browser defaults.
    '.cm-panel.cm-search': {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '4px',
      padding: '6px 8px',
      fontSize: '13px',
    },

    // Search panel labels (match case / regexp / by word)
    '.cm-panel.cm-search label': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      fontSize: '12px',
      color: 'hsl(var(--muted-foreground))',
      cursor: 'pointer',
      userSelect: 'none',
      whiteSpace: 'nowrap',
    },

    // Search panel checkboxes
    '.cm-panel.cm-search input[type=checkbox]': {
      margin: '0',
      cursor: 'pointer',
    },

    // Close button (positioned absolute by CM baseTheme)
    '.cm-panel.cm-search button[name=close]': {
      position: 'absolute',
      top: '6px',
      right: '8px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '20px',
      height: '20px',
      padding: '0',
      margin: '0',
      border: 'none',
      borderRadius: '4px',
      backgroundColor: 'transparent',
      color: 'hsl(var(--muted-foreground))',
      cursor: 'pointer',
      fontSize: '16px',
      lineHeight: '1',
    },

    '.cm-panel.cm-search button[name=close]:hover': {
      backgroundColor: 'hsl(var(--muted))',
      color: 'hsl(var(--foreground))',
    },

    // Replace row: break + fields flow onto a new flex line
    '.cm-panel.cm-search br': {
      width: '100%',
      height: '0',
      flexBasis: '100%',
    },

    // Search match highlights
    '.cm-searchMatch': {
      backgroundColor: 'hsl(48 96% 53% / 0.3)',
      outline: '1px solid hsl(48 96% 53% / 0.5)',
    },

    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: 'hsl(var(--primary) / 0.3)',
      outline: '1px solid hsl(var(--primary))',
    },

    // Search text input
    '.cm-textfield': {
      backgroundColor: 'hsl(var(--input))',
      border: '1px solid hsl(var(--border))',
      borderRadius: '4px',
      padding: '4px 8px',
      color: 'hsl(var(--foreground))',
      fontSize: '13px',
      lineHeight: '1.4',
      outline: 'none',
    },

    '.cm-textfield:focus': {
      borderColor: 'hsl(var(--ring))',
      boxShadow: '0 0 0 2px hsl(var(--ring) / 0.2)',
    },

    // Search action buttons (next / previous / all / replace / replace all)
    // appearance: none is required to disable native OS button chrome that
    // Tailwind Preflight enables via -webkit-appearance: button.
    '.cm-button': {
      WebkitAppearance: 'none',
      appearance: 'none',
      backgroundImage: 'none',
      backgroundColor: 'hsl(var(--secondary))',
      border: '1px solid hsl(var(--border))',
      borderRadius: '4px',
      padding: '4px 8px',
      color: 'hsl(var(--foreground))',
      fontSize: '12px',
      lineHeight: '1.4',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      transition: 'background-color 0.15s ease',
    },

    '.cm-button:hover': {
      backgroundColor: 'hsl(var(--muted))',
    },

    // Fold placeholder
    '.cm-foldPlaceholder': {
      backgroundColor: 'hsl(var(--muted))',
      border: '1px solid hsl(var(--border))',
      borderRadius: '3px',
      padding: '0 6px',
      margin: '0 4px',
      color: 'hsl(var(--muted-foreground))',
      cursor: 'pointer',
    },

    // Tooltip (hover info)
    '.cm-tooltip': {
      backgroundColor: 'hsl(var(--popover))',
      border: '1px solid hsl(var(--border))',
      borderRadius: '6px',
      boxShadow: '0 4px 12px hsl(0 0% 0% / 0.15)',
    },

    // Selection highlight matches
    '.cm-selectionMatch': {
      backgroundColor: 'hsl(var(--primary) / 0.15)',
    },

    // Highlight special chars
    '.cm-specialChar': {
      color: 'hsl(var(--destructive))',
    },

    // Trailing whitespace (when visible)
    '.cm-trailingSpace': {
      backgroundColor: 'hsl(var(--destructive) / 0.2)',
    },
  }
  // No { dark: true } - let CSS variables handle light/dark mode
)

// ============================================
// Syntax Highlighting Theme
// ============================================

/**
 * Syntax highlighting colors - uses CSS variables where possible
 * Hardcoded colors are from One Dark Pro palette, which works well in dark mode
 * and has acceptable contrast in light mode
 */
export const haloHighlightStyle = HighlightStyle.define([
  // Comments
  { tag: tags.comment, color: 'hsl(var(--muted-foreground) / 0.6)', fontStyle: 'italic' },
  { tag: tags.lineComment, color: 'hsl(var(--muted-foreground) / 0.6)', fontStyle: 'italic' },
  { tag: tags.blockComment, color: 'hsl(var(--muted-foreground) / 0.6)', fontStyle: 'italic' },
  { tag: tags.docComment, color: 'hsl(var(--muted-foreground) / 0.7)', fontStyle: 'italic' },

  // Keywords & control flow
  { tag: tags.keyword, color: '#c678dd' }, // Purple
  { tag: tags.controlKeyword, color: '#c678dd' },
  { tag: tags.operatorKeyword, color: '#c678dd' },
  { tag: tags.definitionKeyword, color: '#c678dd' },
  { tag: tags.moduleKeyword, color: '#c678dd' },

  // Variables & identifiers
  { tag: tags.variableName, color: '#e06c75' }, // Red
  { tag: tags.definition(tags.variableName), color: '#e06c75' },
  { tag: tags.local(tags.variableName), color: '#e06c75' },

  // Properties & attributes
  { tag: tags.propertyName, color: '#e06c75' },
  { tag: tags.attributeName, color: '#d19a66' }, // Orange
  { tag: tags.attributeValue, color: '#98c379' }, // Green

  // Functions
  { tag: tags.function(tags.variableName), color: '#61afef' }, // Blue
  { tag: tags.function(tags.propertyName), color: '#61afef' },

  // Types & classes
  { tag: tags.typeName, color: '#e5c07b' }, // Yellow
  { tag: tags.className, color: '#e5c07b' },
  { tag: tags.namespace, color: '#e5c07b' },

  // Strings
  { tag: tags.string, color: '#98c379' }, // Green
  { tag: tags.special(tags.string), color: '#56b6c2' }, // Cyan (template)
  { tag: tags.character, color: '#98c379' },
  { tag: tags.escape, color: '#56b6c2' },

  // Numbers & literals
  { tag: tags.number, color: '#d19a66' }, // Orange
  { tag: tags.integer, color: '#d19a66' },
  { tag: tags.float, color: '#d19a66' },
  { tag: tags.bool, color: '#d19a66' },
  { tag: tags.null, color: '#d19a66' },

  // Operators & punctuation
  { tag: tags.operator, color: '#56b6c2' }, // Cyan
  { tag: tags.compareOperator, color: '#56b6c2' },
  { tag: tags.arithmeticOperator, color: '#56b6c2' },
  { tag: tags.logicOperator, color: '#56b6c2' },
  { tag: tags.bitwiseOperator, color: '#56b6c2' },
  { tag: tags.derefOperator, color: '#56b6c2' },
  { tag: tags.punctuation, color: 'hsl(var(--foreground) / 0.7)' },
  { tag: tags.bracket, color: 'hsl(var(--foreground) / 0.7)' },
  { tag: tags.brace, color: 'hsl(var(--foreground) / 0.7)' },
  { tag: tags.paren, color: 'hsl(var(--foreground) / 0.7)' },
  { tag: tags.squareBracket, color: 'hsl(var(--foreground) / 0.7)' },
  { tag: tags.angleBracket, color: 'hsl(var(--foreground) / 0.7)' },

  // HTML/XML specific
  { tag: tags.tagName, color: '#e06c75' }, // Red
  { tag: tags.angleBracket, color: 'hsl(var(--foreground) / 0.5)' },
  { tag: tags.documentMeta, color: '#abb2bf' },

  // Regex
  { tag: tags.regexp, color: '#56b6c2' },
  { tag: tags.special(tags.regexp), color: '#c678dd' },

  // Markdown specific
  { tag: tags.heading, color: '#e06c75', fontWeight: 'bold' },
  { tag: tags.heading1, color: '#e06c75', fontWeight: 'bold', fontSize: '1.2em' },
  { tag: tags.heading2, color: '#e06c75', fontWeight: 'bold', fontSize: '1.1em' },
  { tag: tags.heading3, color: '#e06c75', fontWeight: 'bold' },
  { tag: tags.quote, color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: '#61afef', textDecoration: 'underline' },
  { tag: tags.url, color: '#61afef' },
  { tag: tags.monospace, fontFamily: 'inherit', backgroundColor: 'hsl(var(--muted) / 0.5)' },

  // Meta & annotations
  { tag: tags.meta, color: '#abb2bf' },
  { tag: tags.annotation, color: '#d19a66' },
  { tag: tags.processingInstruction, color: '#abb2bf' },

  // Labels
  { tag: tags.labelName, color: '#61afef' },

  // Invalid
  { tag: tags.invalid, color: 'hsl(var(--destructive))', textDecoration: 'underline wavy' },
])

// ============================================
// Combined Theme Extension
// ============================================

/**
 * Complete Halo theme for CodeMirror
 * Combines editor styling and syntax highlighting
 */
export const haloTheme: Extension = [
  haloEditorTheme,
  syntaxHighlighting(haloHighlightStyle),
]

/**
 * Light theme variant (same structure, CSS variables handle the colors)
 * The base haloTheme already uses CSS variables, so it works for both
 */
export const haloLightTheme = haloTheme

/**
 * Dark theme variant
 */
export const haloDarkTheme = haloTheme
