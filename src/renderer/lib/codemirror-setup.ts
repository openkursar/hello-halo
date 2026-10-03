/**
 * CodeMirror 6 Configuration Module
 *
 * Provides a unified setup for CodeMirror with:
 * - Language support (lazy-loaded)
 * - Reading-optimized extensions (line numbers, folding, search)
 * - Light editing support (history for undo/redo)
 * - Theme integration with Halo's CSS variables
 *
 * Design philosophy: Reader-first, not IDE-first
 * - Virtual scrolling for large files
 * - Code folding for navigation
 * - Search (Cmd+F) for finding
 * - No autocomplete, no linting (not needed for viewing)
 */

import { EditorState, Extension, Compartment, Transaction } from '@codemirror/state'
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  scrollPastEnd,
} from '@codemirror/view'
import {
  defaultHighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
  LanguageSupport,
} from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'

// Language imports (will be lazy-loaded)
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { php } from '@codemirror/lang-php'
import { vue } from '@codemirror/lang-vue'
import { svelte } from '@replit/codemirror-lang-svelte'
import { StreamLanguage } from '@codemirror/language'
import { haloTheme } from './codemirror-theme'

// Legacy mode languages (for less common languages)
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { haskell } from '@codemirror/legacy-modes/mode/haskell'
import { kotlin, csharp, scala, dart, objectiveC } from '@codemirror/legacy-modes/mode/clike'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf'
import { cmake } from '@codemirror/legacy-modes/mode/cmake'
import { groovy } from '@codemirror/legacy-modes/mode/groovy'
// Additional legacy modes for 99% coverage
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { clojure } from '@codemirror/legacy-modes/mode/clojure'
import { erlang } from '@codemirror/legacy-modes/mode/erlang'
import { julia } from '@codemirror/legacy-modes/mode/julia'
import { oCaml, fSharp, sml } from '@codemirror/legacy-modes/mode/mllike'
import { fortran } from '@codemirror/legacy-modes/mode/fortran'
import { pascal } from '@codemirror/legacy-modes/mode/pascal'
import { vb } from '@codemirror/legacy-modes/mode/vb'
import { vbScript } from '@codemirror/legacy-modes/mode/vbscript'
import { octave } from '@codemirror/legacy-modes/mode/octave'
import { scheme } from '@codemirror/legacy-modes/mode/scheme'
import { commonLisp } from '@codemirror/legacy-modes/mode/commonlisp'
import { sass } from '@codemirror/legacy-modes/mode/sass'
import { stylus } from '@codemirror/legacy-modes/mode/stylus'
import { pug } from '@codemirror/legacy-modes/mode/pug'
import { coffeeScript } from '@codemirror/legacy-modes/mode/coffeescript'
import { elm } from '@codemirror/legacy-modes/mode/elm'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { r } from '@codemirror/legacy-modes/mode/r'
import { d as dLang } from '@codemirror/legacy-modes/mode/d'
import { crystal } from '@codemirror/legacy-modes/mode/crystal'
import { verilog } from '@codemirror/legacy-modes/mode/verilog'
import { vhdl } from '@codemirror/legacy-modes/mode/vhdl'
import { tcl } from '@codemirror/legacy-modes/mode/tcl'
import { puppet } from '@codemirror/legacy-modes/mode/puppet'
import { nsis } from '@codemirror/legacy-modes/mode/nsis'

// ============================================
// Language Support
// ============================================

/**
 * Language registry - maps file extensions and language names to CodeMirror language support
 */
const languageMap: Record<string, () => LanguageSupport | Extension> = {
  // JavaScript/TypeScript
  javascript: () => javascript(),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),

  // Web
  html: () => html(),
  htm: () => html(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),

  // Web frameworks
  vue: () => vue(),
  svelte: () => svelte(),

  // Data formats
  json: () => json(),
  jsonc: () => json(),
  yaml: () => yaml(),
  yml: () => yaml(),
  xml: () => xml(),
  svg: () => xml(),

  // Systems programming
  rust: () => rust(),
  rs: () => rust(),
  go: () => go(),
  c: () => cpp(),
  cpp: () => cpp(),
  'c++': () => cpp(),
  h: () => cpp(),
  hpp: () => cpp(),
  java: () => java(),
  php: () => php(),

  // Scripting
  python: () => python(),
  py: () => python(),
  sql: () => sql(),
  markdown: () => markdown(),
  md: () => markdown(),

  // Shell
  bash: () => StreamLanguage.define(shell),
  sh: () => StreamLanguage.define(shell),
  shell: () => StreamLanguage.define(shell),
  zsh: () => StreamLanguage.define(shell),

  // Other languages (legacy modes)
  ruby: () => StreamLanguage.define(ruby),
  rb: () => StreamLanguage.define(ruby),
  swift: () => StreamLanguage.define(swift),
  toml: () => StreamLanguage.define(toml),
  dockerfile: () => StreamLanguage.define(dockerFile),
  diff: () => StreamLanguage.define(diff),
  patch: () => StreamLanguage.define(diff),

  // Scripting languages (legacy modes)
  lua: () => StreamLanguage.define(lua),
  perl: () => StreamLanguage.define(perl),
  pl: () => StreamLanguage.define(perl),
  pm: () => StreamLanguage.define(perl),
  haskell: () => StreamLanguage.define(haskell),
  hs: () => StreamLanguage.define(haskell),
  groovy: () => StreamLanguage.define(groovy),

  // C-like languages (legacy modes)
  kotlin: () => StreamLanguage.define(kotlin),
  kt: () => StreamLanguage.define(kotlin),
  kts: () => StreamLanguage.define(kotlin),
  csharp: () => StreamLanguage.define(csharp),
  cs: () => StreamLanguage.define(csharp),
  scala: () => StreamLanguage.define(scala),
  dart: () => StreamLanguage.define(dart),
  objectivec: () => StreamLanguage.define(objectiveC),
  m: () => StreamLanguage.define(objectiveC), // Objective-C

  // R language (proper support)
  r: () => StreamLanguage.define(r),
  rmd: () => StreamLanguage.define(r),

  // Config languages (legacy modes)
  ini: () => StreamLanguage.define(properties),
  conf: () => StreamLanguage.define(properties),
  properties: () => StreamLanguage.define(properties),
  protobuf: () => StreamLanguage.define(protobuf),
  proto: () => StreamLanguage.define(protobuf),
  cmake: () => StreamLanguage.define(cmake),
  makefile: () => StreamLanguage.define(shell),

  // Git/Docker ignore files (shell-like)
  gitignore: () => StreamLanguage.define(shell),

  // Windows/PowerShell
  powershell: () => StreamLanguage.define(powerShell),
  ps1: () => StreamLanguage.define(powerShell),
  psm1: () => StreamLanguage.define(powerShell),
  psd1: () => StreamLanguage.define(powerShell),

  // Functional languages
  clojure: () => StreamLanguage.define(clojure),
  clj: () => StreamLanguage.define(clojure),
  cljs: () => StreamLanguage.define(clojure),
  cljc: () => StreamLanguage.define(clojure),
  edn: () => StreamLanguage.define(clojure),
  erlang: () => StreamLanguage.define(erlang),
  erl: () => StreamLanguage.define(erlang),
  hrl: () => StreamLanguage.define(erlang),
  elixir: () => StreamLanguage.define(erlang), // Elixir is Erlang-like
  ex: () => StreamLanguage.define(erlang),
  exs: () => StreamLanguage.define(erlang),
  elm: () => StreamLanguage.define(elm),

  // ML-like languages (F#, OCaml, SML)
  fsharp: () => StreamLanguage.define(fSharp),
  fs: () => StreamLanguage.define(fSharp),
  fsi: () => StreamLanguage.define(fSharp),
  fsx: () => StreamLanguage.define(fSharp),
  ocaml: () => StreamLanguage.define(oCaml),
  ml: () => StreamLanguage.define(oCaml),
  mli: () => StreamLanguage.define(oCaml),
  sml: () => StreamLanguage.define(sml),

  // Scientific computing
  julia: () => StreamLanguage.define(julia),
  jl: () => StreamLanguage.define(julia),
  fortran: () => StreamLanguage.define(fortran),
  f: () => StreamLanguage.define(fortran),
  f90: () => StreamLanguage.define(fortran),
  f95: () => StreamLanguage.define(fortran),
  for: () => StreamLanguage.define(fortran),
  matlab: () => StreamLanguage.define(octave),
  octave: () => StreamLanguage.define(octave),

  // Pascal/Delphi
  pascal: () => StreamLanguage.define(pascal),
  pas: () => StreamLanguage.define(pascal),
  delphi: () => StreamLanguage.define(pascal),
  dpr: () => StreamLanguage.define(pascal),

  // Visual Basic
  vb: () => StreamLanguage.define(vb),
  vbs: () => StreamLanguage.define(vbScript),
  vbscript: () => StreamLanguage.define(vbScript),
  bas: () => StreamLanguage.define(vb),

  // Lisp/Scheme
  scheme: () => StreamLanguage.define(scheme),
  scm: () => StreamLanguage.define(scheme),
  rkt: () => StreamLanguage.define(scheme), // Racket
  lisp: () => StreamLanguage.define(commonLisp),
  lsp: () => StreamLanguage.define(commonLisp),
  cl: () => StreamLanguage.define(commonLisp),

  // CSS preprocessors & template engines
  sass: () => StreamLanguage.define(sass),
  stylus: () => StreamLanguage.define(stylus),
  styl: () => StreamLanguage.define(stylus),
  pug: () => StreamLanguage.define(pug),
  jade: () => StreamLanguage.define(pug),

  // Alt-JS languages
  coffeescript: () => StreamLanguage.define(coffeeScript),
  coffee: () => StreamLanguage.define(coffeeScript),

  // Server config
  nginx: () => StreamLanguage.define(nginx),

  // Systems languages
  d: () => StreamLanguage.define(dLang),
  crystal: () => StreamLanguage.define(crystal),
  cr: () => StreamLanguage.define(crystal),

  // Hardware description
  verilog: () => StreamLanguage.define(verilog),
  v: () => StreamLanguage.define(verilog),
  sv: () => StreamLanguage.define(verilog),
  vhdl: () => StreamLanguage.define(vhdl),
  vhd: () => StreamLanguage.define(vhdl),

  // DevOps/Config
  tcl: () => StreamLanguage.define(tcl),
  puppet: () => StreamLanguage.define(puppet),
  pp: () => StreamLanguage.define(puppet),
  nsis: () => StreamLanguage.define(nsis),
  nsh: () => StreamLanguage.define(nsis),
}

/**
 * Get language support for a given language name or file extension
 */
export function getLanguageSupport(language?: string): Extension | null {
  if (!language) return null

  const normalizedLang = language.toLowerCase().replace(/^\./, '')
  const languageFactory = languageMap[normalizedLang]

  if (languageFactory) {
    try {
      return languageFactory()
    } catch (err) {
      console.warn(`[codemirror-setup] Failed to load language: ${language}`, err)
      return null
    }
  }

  return null
}

// ============================================
// Compartments for Dynamic Configuration
// ============================================

/**
 * Compartment for read-only mode toggle
 */
export const readOnlyCompartment = new Compartment()

/**
 * Compartment for language (can be changed dynamically)
 */
export const languageCompartment = new Compartment()

/**
 * Compartment for theme (can be changed dynamically)
 */
export const themeCompartment = new Compartment()

// ============================================
// Base Extensions
// ============================================

/**
 * Reading-focused extensions - these are always active
 */
export function getBaseExtensions(): Extension[] {
  return [
    // Core display
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),

    // Navigation aids
    foldGutter({
      closedText: '▸',
      openText: '▾',
    }),
    highlightActiveLine(),

    // Search (Cmd/Ctrl + F)
    search({
      top: true, // Show search panel at top
    }),
    highlightSelectionMatches(),

    // Editing basics (even in read-only, for selection)
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),

    // Scroll past end for comfortable reading
    scrollPastEnd(),

    // History for undo/redo (when editable)
    history(),

    // Syntax highlighting
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

    // Keymaps
    keymap.of([
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      indentWithTab,
    ]),

    // Indent on input (when editable)
    indentOnInput(),
  ]
}

// ============================================
// EditorState Factory
// ============================================

export interface CreateEditorStateOptions {
  /** Initial document content */
  doc: string
  /** Language for syntax highlighting */
  language?: string
  /** Read-only mode (default: true) */
  readOnly?: boolean
  /** Additional extensions */
  extensions?: Extension[]
}

/**
 * Create a new EditorState with Halo's default configuration
 */
export function createEditorState(options: CreateEditorStateOptions): EditorState {
  const { doc, language, readOnly = true, extensions = [] } = options

  const languageExt = getLanguageSupport(language)

  return EditorState.create({
    doc,
    extensions: [
      // Base extensions
      ...getBaseExtensions(),

      // Compartmentalized configurations
      readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
      languageCompartment.of(languageExt || []),
      themeCompartment.of(haloTheme), // Always use haloTheme

      // Additional extensions
      ...extensions,
    ],
  })
}

// ============================================
// Editor Configuration Helpers
// ============================================

/**
 * Toggle read-only mode on an EditorView
 */
export function setReadOnly(view: EditorView, readOnly: boolean): void {
  view.dispatch({
    effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
  })
}

/**
 * Change the language of an EditorView
 */
export function setLanguage(view: EditorView, language?: string): void {
  const languageExt = getLanguageSupport(language)
  view.dispatch({
    effects: languageCompartment.reconfigure(languageExt || []),
  })
}

/**
 * Change the theme of an EditorView
 */
export function setTheme(view: EditorView, theme: Extension): void {
  view.dispatch({
    effects: themeCompartment.reconfigure(theme),
  })
}

/**
 * Get the current document content
 */
export function getContent(view: EditorView): string {
  return view.state.doc.toString()
}

/**
 * Replace the entire document with content that came from outside the editor
 * (a disk refresh, a revert). The replacement is not an edit the user made, so
 * it stays out of undo history: undoing it would restore stale text, and each
 * whole-document inverse kept there costs the full old document in memory.
 */
export function setContent(view: EditorView, content: string): void {
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: content,
    },
    annotations: Transaction.addToHistory.of(false),
  })
}

/**
 * Check if document has been modified
 */
export function hasChanges(view: EditorView, originalContent: string): boolean {
  return view.state.doc.toString() !== originalContent
}
