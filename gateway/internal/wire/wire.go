// Package wire defines the JSON envelope and gateway message vocabulary of the
// federation wire protocol (v2-gw). The gateway is a relay: it reads only the
// envelope routing fields (type/to and kind/officeId/fromNode of federation
// payloads) and never interprets business payloads.
//
// v2-gw adds (all guarded by explicit version negotiation on auth):
//   - a monotonic, opaque TERM on gw:host-attach — a higher term takes a room
//     over immediately (authority handover), a stale term is rejected;
//   - member-to-member relay of the ELECTION control frames while the room has
//     no host, so an office can elect a successor through the relay.
package wire

import "encoding/json"

// Envelope is the outer WebSocket message: { type, payload }.
// "to" is set only on host -> gateway federation frames (nil = broadcast).
// "error" is used by auth:failed and error frames (top-level, matching the
// TS node implementation).
type Envelope struct {
	Type string  `json:"type"`
	To   *string `json:"to,omitempty"`
	// From is stamped by the gateway on member→host forwards: the proven
	// session identity of the sender. Frames whose kind carries no fromNode
	// (presence-update uses nodeId; stream-frames/turn-complete carry none)
	// would otherwise lose their origin across the relay. The host treats it
	// as authoritative — the gateway already asserted it (§9.1/§9.2).
	From    string          `json:"from,omitempty"`
	Error   string          `json:"error,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// Wire protocol version negotiation. A client MAY declare wirePv on auth;
// declared-and-incompatible is rejected explicitly (auth:failed), never a
// silent mixed-version session. An absent wirePv is a v1 client: admitted, and
// simply never exercises the v2 vocabulary.
const (
	WirePvCurrent = 2
	WirePvMin     = 1
)

// Envelope types handled by the gateway.
const (
	TypeAuth          = "auth"
	TypeAuthChallenge = "auth:challenge"
	TypeAuthSuccess   = "auth:success"
	TypeAuthFailed    = "auth:failed"
	TypeFederation    = "federation"

	TypeGwHostAttach = "gw:host-attach"
	TypeGwAttached   = "gw:attached"
	TypeGwEvict      = "gw:evict"
	TypeGwHostLost   = "gw:host-lost"
	TypeGwAnnounce   = "gw:announce"
	TypeGwLookup     = "gw:lookup"
	TypeGwDirectory  = "gw:directory"
	TypeGwError      = "gw:error"
)

// Gateway error codes (gw:error { code, detail? }).
const (
	CodeHostConflict     = "HOST_CONFLICT"
	CodeHostUnreachable  = "HOST_UNREACHABLE"
	CodeNotAttached      = "NOT_ATTACHED"
	CodeAdmissionTimeout = "ADMISSION_TIMEOUT"
	CodeFrameTooLarge    = "FRAME_TOO_LARGE"
	CodeRateLimited      = "RATE_LIMITED"
	CodeBadSignature     = "BAD_SIGNATURE"
	CodeClockSkew        = "CLOCK_SKEW"
	CodeMalformed        = "MALFORMED"
	// A gw:host-attach carrying a term lower than (or equal to) the room's
	// pinned term — a resurrected old host cannot reclaim an elected-over room.
	CodeStaleTerm = "STALE_TERM"
	// Auth declared a wire protocol version outside the supported range.
	CodeVersionIncompatible = "VERSION_INCOMPATIBLE"
)

// GwError is the payload of a gw:error envelope.
type GwError struct {
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
}

// AuthPayload is the payload of an auth envelope (leg 1 and leg 2).
type AuthPayload struct {
	Token      string          `json:"token"`
	Federation bool            `json:"federation"`
	OfficeID   string          `json:"officeId"`
	Proof      json.RawMessage `json:"proof"`
	// Declared wire protocol version; 0 (absent) = v1 client.
	WirePv int `json:"wirePv,omitempty"`
}

// Proof is the device-key identity proof (§3.3).
type Proof struct {
	Method     string `json:"method"`
	IdentityID string `json:"identityId"`
	PublicKey  string `json:"publicKey"`
	Challenge  string `json:"challenge"`
	Signature  string `json:"signature"`
}

// FederationHeader is the subset of a federation payload the relay reads for
// routing and admission. The rest of the payload is opaque.
type FederationHeader struct {
	Kind     string `json:"kind"`
	OfficeID string `json:"officeId"`
	FromNode string `json:"fromNode"`
}

// HostAttachPayload is the payload of gw:host-attach.
type HostAttachPayload struct {
	OfficeID string `json:"officeId"`
	// Opaque monotonic authority tenure (v2-gw); 0 (absent) = v1 attach. See
	// Hub.pinHost for takeover semantics.
	Term int64 `json:"term,omitempty"`
}

// EvictPayload is the payload of gw:evict.
type EvictPayload struct {
	NodeID string `json:"nodeId"`
}

// AnnouncePayload is the payload of gw:announce (§9.3).
type AnnouncePayload struct {
	Endpoints   []string `json:"endpoints"`
	DisplayName string   `json:"displayName,omitempty"`
	TS          int64    `json:"ts"`
	Sig         string   `json:"sig"`
}

// DirectoryEntry is one entry of a gw:directory response.
type DirectoryEntry struct {
	NodeID      string   `json:"nodeId"`
	DisplayName string   `json:"displayName,omitempty"`
	Endpoints   []string `json:"endpoints"`
	TS          int64    `json:"ts"`
}

// DirectoryPayload is the payload of gw:directory.
type DirectoryPayload struct {
	Entries []DirectoryEntry `json:"entries"`
}

// electionKinds is the closed set of federation frame kinds the gateway will
// relay member-to-member while a room has NO host (v2-gw): exactly the
// authority-election control vocabulary, nothing else — business planes stay
// host-routed, and the gateway still never interprets payloads beyond `kind`.
var electionKinds = map[string]struct{}{
	"authority-claim":    {},
	"authority-confirm":  {},
	"authority-announce": {},
	"reject":             {},
	"catchup-request":    {},
	"catchup-response":   {},
}

// IsElectionKind reports whether a federation frame kind belongs to the
// election vocabulary eligible for hostless member-to-member relay.
func IsElectionKind(kind string) bool {
	_, ok := electionKinds[kind]
	return ok
}

// Plane is one of the three outbound priority planes (§5.3).
type Plane int

const (
	PlaneControl Plane = iota
	PlaneStream
	PlaneArtifact
	PlaneCount
)

func (p Plane) String() string {
	switch p {
	case PlaneControl:
		return "control"
	case PlaneStream:
		return "stream"
	case PlaneArtifact:
		return "artifact"
	}
	return "unknown"
}

// ClassifyPlane maps a federation frame kind to its outbound plane.
// Non-federation traffic is always control.
func ClassifyPlane(kind string) Plane {
	switch kind {
	case "stream-frames":
		return PlaneStream
	case "artifact-fetch", "artifact-bytes":
		return PlaneArtifact
	default:
		return PlaneControl
	}
}

// NewEnvelope marshals a payload into an envelope of the given type.
// Marshalling of gateway-owned payload structs cannot fail.
func NewEnvelope(msgType string, payload any) *Envelope {
	env := &Envelope{Type: msgType}
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			panic("wire: marshal gateway payload: " + err.Error())
		}
		env.Payload = raw
	}
	return env
}

// NewGwError builds a gw:error envelope.
func NewGwError(code, detail string) *Envelope {
	return NewEnvelope(TypeGwError, GwError{Code: code, Detail: detail})
}
