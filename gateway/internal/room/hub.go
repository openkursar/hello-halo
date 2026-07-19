// Package room implements the relay star topology (§9.2): one room per
// office, the host as routing hub, the member admission gate, and the
// three-plane prioritized outbound queues.
package room

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/openkursar/hello-halo/gateway/internal/directory"
	"github.com/openkursar/hello-halo/gateway/internal/metrics"
	"github.com/openkursar/hello-halo/gateway/internal/session"
	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

// Hub owns all rooms and the discovery directory, and implements
// session.Handler: every post-auth frame is dispatched here.
type Hub struct {
	mu    sync.Mutex
	rooms map[string]*Room
	pins  map[string]*hostPin

	cfg     Config
	dir     *directory.Directory
	log     *slog.Logger
	metrics *metrics.Metrics
}

func NewHub(cfg Config, dir *directory.Directory, log *slog.Logger, m *metrics.Metrics) *Hub {
	cfg.fillDefaults()
	if log == nil {
		log = slog.Default()
	}
	if m == nil {
		m = metrics.New()
	}
	return &Hub{
		rooms:   make(map[string]*Room),
		pins:    make(map[string]*hostPin),
		cfg:     cfg,
		dir:     dir,
		log:     log,
		metrics: m,
	}
}

func (h *Hub) roomFor(officeID string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[officeID]
	if !ok {
		r = newRoom(officeID, h.cfg, h.log, h.metrics, h.removeRoom)
		h.rooms[officeID] = r
		h.metrics.RoomsActive.Store(int64(len(h.rooms)))
	}
	return r
}

func (h *Hub) lookupRoom(officeID string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.rooms[officeID]
}

func (h *Hub) removeRoom(officeID string) {
	h.mu.Lock()
	delete(h.rooms, officeID)
	h.metrics.RoomsActive.Store(int64(len(h.rooms)))
	h.mu.Unlock()
	if h.dir != nil {
		h.dir.DropOffice(officeID)
	}
}

// OnAuthenticated adds the session to its office's room as a pending member.
// A host session upgrades itself with gw:host-attach right after auth.
func (h *Hub) OnAuthenticated(s *session.Session) {
	h.metrics.SessionsActive.Add(1)
	h.roomFor(s.OfficeID()).addMember(s)
}

// OnClose cleans up room membership, pin state, and directory entries.
func (h *Hub) OnClose(s *session.Session) {
	if !s.Authenticated() {
		return
	}
	h.metrics.SessionsActive.Add(-1)
	if h.dir != nil {
		h.dir.Remove(s.OfficeID(), s.IdentityID())
	}
	h.releasePin(s.OfficeID(), s)
	if r := h.lookupRoom(s.OfficeID()); r != nil {
		r.onSessionClose(s)
	}
}

// hostPin records which identity an office is pinned to. Pins survive room
// disbands so a post-retention takeover is still observable (WARN + counter).
type hostPin struct {
	identity  string
	sess      *session.Session
	connected bool
	lostAt    time.Time
	// Highest authority term this pin has seen (v2-gw). 0 = pinned by a v1
	// attach that carried no term.
	term int64
}

// pinHost enforces room pinning (§9.2) with the v2-gw term lock: the first
// gw:host-attach pins the office to that identity; the same identity may
// always replace its own connection; a DIFFERENT identity takes over either
// immediately with a strictly HIGHER term (an election concluded — the term is
// opaque and only compared monotonically) or, term-less (v1), after the
// previous host has been disconnected for the full retention window. A stale
// term can never reclaim an elected-over room, connected or not.
func (h *Hub) pinHost(officeID string, s *session.Session, term int64) (ok bool, reason string) {
	identity := s.IdentityID()
	h.mu.Lock()
	defer h.mu.Unlock()
	pin, present := h.pins[officeID]
	if !present {
		h.pins[officeID] = &hostPin{identity: identity, sess: s, connected: true, term: term}
		return true, ""
	}
	if pin.identity == identity {
		pin.sess = s
		pin.connected = true
		if term > pin.term {
			pin.term = term
		}
		return true, ""
	}
	takeover := false
	switch {
	case term > pin.term:
		// A higher tenure won an election; the room follows the new authority
		// immediately — waiting out retention would strand the survivors.
		takeover = true
	case term != 0 && term <= pin.term:
		// A termed attach that LOST the tenure race (e.g. a resurrected old
		// authority): explicit stale-term rejection, even after retention.
		return false, wire.CodeStaleTerm
	case !pin.connected && time.Since(pin.lostAt) >= h.cfg.HostRetention:
		// v1 path: term-less takeover after the retention window.
		takeover = true
	}
	if !takeover {
		return false, wire.CodeHostConflict
	}
	h.log.Warn("host takeover: office re-pinned to a new identity",
		"office", officeID, "previous", pin.identity, "new", identity, "term", term)
	h.metrics.HostTakeoversTotal.Add(1)
	pin.identity = identity
	pin.sess = s
	pin.connected = true
	// The pin's term always follows the taker: a v2 taker proved `term`, and a
	// term-less v1 taker resets it to 0 — it never proved the previous holder's
	// tenure, and inheriting it would STALE_TERM-lock out a legitimate current
	// authority reattaching at that same term.
	pin.term = term
	return true, ""
}

// releasePin marks the pin disconnected when its holding session goes away
// (or when an attach fails after the pin was tentatively committed).
func (h *Hub) releasePin(officeID string, s *session.Session) {
	h.mu.Lock()
	defer h.mu.Unlock()
	pin := h.pins[officeID]
	if pin == nil || pin.sess != s {
		return
	}
	pin.sess = nil
	pin.connected = false
	pin.lostAt = time.Now()
}

// OnFrame dispatches one post-auth envelope.
func (h *Hub) OnFrame(s *session.Session, env *wire.Envelope) {
	switch env.Type {
	case wire.TypeFederation:
		h.handleFederation(s, env)
	case wire.TypeGwHostAttach:
		h.handleHostAttach(s, env)
	case wire.TypeGwEvict:
		h.handleEvict(s, env)
	case wire.TypeGwAnnounce:
		h.handleAnnounce(s, env)
	case wire.TypeGwLookup:
		h.handleLookup(s)
	default:
		// Unknown types are ignored silently (forward compatibility, §10).
	}
}

func (h *Hub) handleFederation(s *session.Session, env *wire.Envelope) {
	var hdr wire.FederationHeader
	if err := json.Unmarshal(env.Payload, &hdr); err != nil || hdr.Kind == "" {
		h.metrics.FramesRejectedTotal.Add(1)
		s.SendGwError(wire.CodeMalformed, "federation payload missing kind")
		return
	}
	if hdr.OfficeID != s.OfficeID() {
		h.metrics.FramesRejectedTotal.Add(1)
		s.SendGwError(wire.CodeMalformed, "officeId does not match session office")
		return
	}
	// Edge assertion (§9.1): a frame carrying fromNode must match the proven
	// session identity; violations are dropped and counted. Many frame kinds
	// (join-grant, stream-frames, turn-complete, roster, ...) carry no
	// fromNode — absence skips the assertion.
	if hdr.FromNode != "" && hdr.FromNode != s.IdentityID() {
		h.metrics.FramesRejectedTotal.Add(1)
		h.log.Warn("dropping frame with spoofed fromNode",
			"session", s.IdentityID(), "claimed", hdr.FromNode)
		return
	}

	r := h.roomFor(s.OfficeID())
	if r.isHost(s) {
		r.routeFromHost(s, &hdr, env)
	} else {
		r.routeFromMember(s, &hdr, env)
	}
}

func (h *Hub) handleHostAttach(s *session.Session, env *wire.Envelope) {
	var p wire.HostAttachPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.OfficeID == "" {
		s.SendGwError(wire.CodeMalformed, "gw:host-attach requires officeId")
		return
	}
	if p.OfficeID != s.OfficeID() {
		s.SendGwError(wire.CodeMalformed, "officeId does not match session office")
		return
	}
	if ok, reason := h.pinHost(s.OfficeID(), s, p.Term); !ok {
		s.SendGwError(reason, "office is pinned to another host identity")
		return
	}
	if !h.roomFor(s.OfficeID()).attachHost(s) {
		h.releasePin(s.OfficeID(), s)
	}
}

func (h *Hub) handleEvict(s *session.Session, env *wire.Envelope) {
	r := h.lookupRoom(s.OfficeID())
	if r == nil || !r.isHost(s) {
		s.SendGwError(wire.CodeNotAttached, "only the room host may evict")
		return
	}
	var p wire.EvictPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.NodeID == "" {
		s.SendGwError(wire.CodeMalformed, "gw:evict requires nodeId")
		return
	}
	r.evict(p.NodeID)
}

func (h *Hub) handleAnnounce(s *session.Session, env *wire.Envelope) {
	if h.dir == nil {
		return
	}
	var p wire.AnnouncePayload
	if err := json.Unmarshal(env.Payload, &p); err != nil || len(p.Endpoints) == 0 || p.Sig == "" {
		h.metrics.AnnounceRejectsTotal.Add(1)
		s.SendGwError(wire.CodeMalformed, "gw:announce requires endpoints and sig")
		return
	}
	if err := h.dir.Announce(s.OfficeID(), s.IdentityID(), s.PublicKey(), p); err != nil {
		h.metrics.AnnounceRejectsTotal.Add(1)
		s.SendGwError(err.Code, err.Detail)
		return
	}
	h.metrics.AnnouncesTotal.Add(1)
}

func (h *Hub) handleLookup(s *session.Session) {
	entries := []wire.DirectoryEntry{}
	if h.dir != nil {
		entries = h.dir.Lookup(s.OfficeID())
	}
	s.SendEnvelope(wire.NewEnvelope(wire.TypeGwDirectory, wire.DirectoryPayload{Entries: entries}))
}

// Shutdown closes every session in every room (graceful stop).
func (h *Hub) Shutdown() {
	h.mu.Lock()
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.rooms = make(map[string]*Room)
	h.metrics.RoomsActive.Store(0)
	h.mu.Unlock()
	for _, r := range rooms {
		r.closeAll()
	}
}
