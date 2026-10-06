/**
 * Whether a fill took. A page can block the select-all that clears a field,
 * reformat or cut the typed text, or refuse it, so what the element holds
 * afterwards is read back and compared; only a match counts as filled. Text is
 * typed only while the element holds focus, since typing goes wherever focus is.
 */

import type { FieldReadBack } from './types'

/**
 * Runs on the element to fill (`this`): selects its text for replacement and
 * returns 'ok', but only while focus is on it, inside it (a label's control, a
 * shadow root's input) or on the editing host or shadow host around it, and,
 * for an element in a frame, while every enclosing document has focus on the
 * frame that holds it: a frame nobody focused still reports its editable body
 * as active. Anywhere else ('elsewhere') the typed text would land in some
 * other field; under a frame from another site ('cross-origin-frame') that
 * cannot even be checked, so it is refused too.
 */
export const SELECT_IF_FOCUSED = `function () {
  var target = this;
  var doc = target.ownerDocument;
  function deepActive(d) {
    var a = d.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  function contains(outer, inner) {
    for (var node = inner; node; node = node.parentNode || node.host) if (node === outer) return true;
    return false;
  }
  for (var win = doc.defaultView; win && win.parent && win.parent !== win; win = win.parent) {
    var frame = win.frameElement;
    if (!frame) return 'cross-origin-frame';
    if (deepActive(frame.ownerDocument) !== frame) return 'elsewhere';
  }
  var active = deepActive(doc);
  var focused = !!active && (contains(target, active)
    || (contains(active, target) && (active.isContentEditable || target.getRootNode() !== doc)));
  if (!focused) return 'elsewhere';
  doc.execCommand('selectAll');
  return 'ok';
}`

/** Why a fill under a frame from another site typed nothing, and what to do instead. */
export const CROSS_ORIGIN_FRAME_REFUSED =
  'this field sits in a frame from another site, where its focus cannot be confirmed, so nothing was typed. Take a browser_snapshot and use an input that is not inside such a frame.'

/** Why a fill typed nothing, and how to find the field that does take the text. */
export const FOCUS_REFUSED =
  'focus stayed on another element, so nothing was typed. Take a browser_snapshot: if this field passed focus to another input (such as one in a popup it opened), fill that input; otherwise click this field, then fill it again.'

/**
 * Runs on the filled element (`this`) one task after the text went in, so
 * input handlers that reformat later have run too. Focus may have gone to a
 * field inside the element (a label's control, a shadow root's input); text in
 * a rich-text editor is read from its whole editing host, which select-all
 * replaced.
 */
export const READ_FILLED_VALUE = `function () {
  var target = this;
  function read() {
    var el = target;
    if (typeof el.value !== 'string' && !el.isContentEditable) {
      var active = el.ownerDocument.activeElement;
      while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
      for (var node = active; node; node = node.parentNode || node.host) {
        if (node === target) { el = active; break; }
      }
    }
    if (el.isContentEditable) {
      while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
      return { kind: 'editable', value: el.innerText };
    }
    if (typeof el.value === 'string') return { kind: 'field', value: el.value, secret: el.type === 'password' };
    return { kind: 'unreadable' };
  }
  return new Promise(function (resolve) {
    setTimeout(function () {
      try { resolve(read()); } catch (error) { resolve({ kind: 'unreadable' }); }
    }, 0);
  });
}`

export type FillCheck =
  | { status: 'match' }
  | { status: 'different'; detail: string }
  | { status: 'unreadable'; detail: string }

const QUOTE_LIMIT = 300

function quoted(text: string): string {
  const chars = Array.from(text)
  return chars.length > QUOTE_LIMIT
    ? `${JSON.stringify(chars.slice(0, QUOTE_LIMIT).join(''))}… (${chars.length} characters)`
    : JSON.stringify(text)
}

// Text areas report every line break as LF.
function fieldText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

// Rich-text editors add line breaks, non-breaking and zero-width spaces of their own.
function editableText(text: string): string {
  return text.replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim()
}

export function checkFill(expected: string, filled: FieldReadBack | undefined): FillCheck {
  if (!filled || filled.kind === 'unreadable' || typeof filled.value !== 'string') {
    return {
      status: 'unreadable',
      detail: 'this element has no value to read back, so what it holds is unconfirmed. Check it with browser_snapshot before submitting.',
    }
  }
  const normalize = filled.kind === 'editable' ? editableText : fieldText
  if (normalize(filled.value) === normalize(expected)) return { status: 'match' }
  // A password's text never goes back to the model.
  const holds = filled.kind === 'field' && filled.secret
    ? `the password field does not hold the requested text (it has ${Array.from(filled.value).length} characters, ${Array.from(expected).length} were requested)`
    : `the field reads ${quoted(filled.value)}, not the requested ${quoted(expected)}`
  return {
    status: 'different',
    detail: `${holds}. The page may have reformatted, cut short or refused the input, or kept earlier text. If this is only the page's formatting of the same value, the field is filled; otherwise fix it before submitting.`,
  }
}
