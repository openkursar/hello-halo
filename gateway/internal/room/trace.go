package room

import "log/slog"

// Full-fidelity frame tracing. Off by default: a trace record carries the
// frame BODY, which for this relay means office members' message text. It is a
// deliberate, temporary diagnostic switch for a named office (or, with "*",
// everything) — never a mode to leave running.
//
// Existing logs answer "was a frame dropped". Tracing answers the question that
// silence cannot: whether a frame was ever offered at all, and if so, by whom,
// carrying what, addressed to whom.

// Bodies over this are cut. The true length is always recorded, so an oversized
// frame is still visible as oversized instead of burying the sequence around it.
const traceMaxPayloadBytes = 8 << 10

func (c *Config) traceEnabled(officeID string) bool {
	return c.Trace == "*" || (c.Trace != "" && c.Trace == officeID)
}

// traceIn records a frame as it arrives from a session, with its body.
func traceIn(log *slog.Logger, cfg *Config, officeID, from, to, msgType, kind string, payload []byte) {
	if !cfg.traceEnabled(officeID) {
		return
	}
	body, truncated := clipPayload(payload)
	log.Info("trace in",
		"office", officeID, "from", from, "to", to,
		"type", msgType, "kind", kind,
		"bytes", len(payload), "truncated", truncated, "payload", body)
}

// traceOut records where a frame went. The body is not repeated — the matching
// "trace in" already carries it, and the pair is what makes a hop readable.
func traceOut(log *slog.Logger, cfg *Config, officeID, route, to, kind string, bytes, recipients int) {
	if !cfg.traceEnabled(officeID) {
		return
	}
	log.Info("trace out",
		"office", officeID, "route", route, "to", to,
		"kind", kind, "bytes", bytes, "recipients", recipients)
}

func clipPayload(payload []byte) (string, bool) {
	if len(payload) > traceMaxPayloadBytes {
		return string(payload[:traceMaxPayloadBytes]), true
	}
	return string(payload), false
}
