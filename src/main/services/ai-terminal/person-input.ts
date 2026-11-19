/**
 * Whether keyboard-channel input to a pty came from a person.
 *
 * A viewer's xterm writes to the pty for two reasons: the person typed (or
 * clicked in a program that asked for mouse reports), or the terminal answered
 * a query the program sent — cursor position, device attributes, focus
 * changes, colour replies. Only the first means someone acted, so the second
 * kind is stripped and whatever remains counts. Mouse movement and button
 * releases are not acts either; a press is.
 */

const TERMINAL_REPLIES: RegExp[] = [
  /\x1b\[\d+;\d+R/g, // cursor position report
  /\x1b\[[?>=]?[\d;]*c/g, // device attributes
  /\x1b\[\d*n/g, // device status
  /\x1b\[[IO]/g, // focus in / out
  /\x1b\[\??[\d;]*\$y/g, // mode report
  /\x1b\[[\d;]*t/g, // window reports
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC replies (colours, clipboard queries)
  /\x1bP[^\x1b]*\x1b\\/g, // DCS replies
]

const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+([Mm])/g
const X10_MOUSE = /\x1b\[M([\s\S])[\s\S]{2}/g

const MOTION = 32
const RELEASE = 3

function withoutPassiveMouse(data: string): string {
  return data
    .replace(SGR_MOUSE, (report, button: string, kind: string) =>
      kind === 'm' || (Number(button) & MOTION) ? '' : report)
    .replace(X10_MOUSE, (report, code: string) => {
      const button = code.charCodeAt(0) - 32
      return (button & MOTION) || (button & 3) === RELEASE ? '' : report
    })
}

export function isPersonInput(data: string): boolean {
  let rest = withoutPassiveMouse(data)
  for (const reply of TERMINAL_REPLIES) rest = rest.replace(reply, '')
  return rest.length > 0
}
