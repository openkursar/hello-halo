package room

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/openkursar/hello-halo/gateway/internal/metrics"
	"github.com/openkursar/hello-halo/gateway/internal/session"
	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

// member is a joiner session and its admission state. Sessions start pending:
// their frames flow only toward the host until the gateway observes the host
// granting the join (§9.2 admission gate).
type member struct {
	sess       *session.Session
	admitted   bool
	admitTimer *time.Timer
}

// Room is one office's relay state: the host session (routing hub of the
// star topology) plus the joiner members keyed by proven node id.
type Room struct {
	officeID string

	mu           sync.Mutex
	host         *session.Session
	hostIdentity string
	members      map[string]*member
	retainTimer  *time.Timer
	disbanded    bool

	cfg     Config
	log     *slog.Logger
	metrics *metrics.Metrics
	onEmpty func(officeID string)
}

// Config carries room tunables (production defaults per §9.2).
type Config struct {
	AdmissionTimeout time.Duration
	HostRetention    time.Duration
}

func (c *Config) fillDefaults() {
	if c.AdmissionTimeout == 0 {
		c.AdmissionTimeout = 60 * time.Second
	}
	if c.HostRetention == 0 {
		c.HostRetention = 5 * time.Minute
	}
}

func newRoom(officeID string, cfg Config, log *slog.Logger, m *metrics.Metrics, onEmpty func(string)) *Room {
	return &Room{
		officeID: officeID,
		members:  make(map[string]*member),
		cfg:      cfg,
		log:      log.With("office", officeID),
		metrics:  m,
		onEmpty:  onEmpty,
	}
}

// addMember registers an authenticated session as a pending member. A second
// connection with the same identity replaces (closes) the old one.
func (r *Room) addMember(s *session.Session) {
	nodeID := s.IdentityID()
	r.mu.Lock()
	if r.disbanded {
		r.mu.Unlock()
		s.Close()
		return
	}
	if prev, ok := r.members[nodeID]; ok {
		prev.stopTimer()
		defer prev.sess.Close()
	}
	m := &member{sess: s}
	m.admitTimer = time.AfterFunc(r.cfg.AdmissionTimeout, func() {
		r.expireAdmission(nodeID, s)
	})
	r.members[nodeID] = m
	r.mu.Unlock()
	r.log.Debug("member pending", "node", nodeID)
}

func (m *member) stopTimer() {
	if m.admitTimer != nil {
		m.admitTimer.Stop()
		m.admitTimer = nil
	}
}

func (r *Room) expireAdmission(nodeID string, s *session.Session) {
	r.mu.Lock()
	m, ok := r.members[nodeID]
	if !ok || m.sess != s || m.admitted {
		r.mu.Unlock()
		return
	}
	delete(r.members, nodeID)
	r.mu.Unlock()
	r.log.Info("member admission timed out", "node", nodeID)
	s.CloseWithGwError(wire.CodeAdmissionTimeout, "not admitted within timeout")
}

// attachHost declares s the host for this room and reports whether the attach
// succeeded. Same identity replaces its own stale connection; a different
// identity is rejected here as a defense in depth (the hub's pin gate is the
// authoritative check).
func (r *Room) attachHost(s *session.Session) bool {
	nodeID := s.IdentityID()
	r.mu.Lock()
	if r.disbanded {
		r.mu.Unlock()
		s.Close()
		return false
	}
	if r.host != nil && r.host != s {
		if r.hostIdentity != nodeID {
			r.mu.Unlock()
			s.SendGwError(wire.CodeHostConflict, "room already has an active host")
			return false
		}
		old := r.host
		r.host = nil
		defer old.Close()
	}
	if r.retainTimer != nil {
		r.retainTimer.Stop()
		r.retainTimer = nil
	}
	// The host is not a routed member of its own room.
	if m, ok := r.members[nodeID]; ok && m.sess == s {
		m.stopTimer()
		delete(r.members, nodeID)
	}
	r.host = s
	r.hostIdentity = nodeID
	r.mu.Unlock()
	s.SendEnvelope(wire.NewEnvelope(wire.TypeGwAttached, map[string]string{"role": "host"}))
	r.log.Info("host attached", "node", nodeID)
	return true
}

// routeFromMember forwards a member's federation frame to the host (§9.2:
// member frames are always routed to the host; "to" is ignored).
func (r *Room) routeFromMember(s *session.Session, hdr *wire.FederationHeader, env *wire.Envelope) {
	r.mu.Lock()
	host := r.host
	r.mu.Unlock()
	if host == nil {
		s.SendGwError(wire.CodeHostUnreachable, "host is not online")
		return
	}
	data := marshalForward(env)
	if data == nil {
		s.SendGwError(wire.CodeMalformed, "unencodable frame")
		return
	}
	plane := wire.ClassifyPlane(hdr.Kind)
	if host.SendData(plane, data) {
		r.metrics.FramesForwardedTotal[plane].Add(1)
	}
}

// routeFromHost forwards a host frame: to == nodeId unicasts, to == nil
// broadcasts to admitted members. join-grant / join-reject envelopes drive the
// admission gate.
func (r *Room) routeFromHost(s *session.Session, hdr *wire.FederationHeader, env *wire.Envelope) {
	plane := wire.ClassifyPlane(hdr.Kind)
	data := marshalForward(env)
	if data == nil {
		s.SendGwError(wire.CodeMalformed, "unencodable frame")
		return
	}

	if env.To != nil && *env.To != "" {
		target := *env.To
		r.mu.Lock()
		m, ok := r.members[target]
		if ok {
			switch hdr.Kind {
			case "join-grant":
				if !m.admitted {
					m.admitted = true
					m.stopTimer()
					r.log.Info("member admitted", "node", target)
				}
			case "join-reject":
				m.stopTimer()
				delete(r.members, target)
			}
		}
		r.mu.Unlock()
		if !ok {
			return
		}
		if m.sess.SendData(plane, data) {
			r.metrics.FramesForwardedTotal[plane].Add(1)
		}
		if hdr.Kind == "join-reject" {
			m.sess.CloseGraceful()
		}
		return
	}

	r.mu.Lock()
	targets := make([]*session.Session, 0, len(r.members))
	for _, m := range r.members {
		if m.admitted {
			targets = append(targets, m.sess)
		}
	}
	r.mu.Unlock()
	for _, t := range targets {
		if t.SendData(plane, data) {
			r.metrics.FramesForwardedTotal[plane].Add(1)
		}
	}
}

// evict force-closes a member session on the host's request.
func (r *Room) evict(nodeID string) {
	r.mu.Lock()
	m, ok := r.members[nodeID]
	if ok {
		m.stopTimer()
		delete(r.members, nodeID)
	}
	r.mu.Unlock()
	if ok {
		r.metrics.EvictionsTotal.Add(1)
		r.log.Info("member evicted", "node", nodeID)
		m.sess.CloseGraceful()
	}
}

// onSessionClose cleans up after a disconnect. A lost host triggers
// gw:host-lost to members and starts the retention window; the room disbands
// when the window elapses without a (re-)attach.
func (r *Room) onSessionClose(s *session.Session) {
	nodeID := s.IdentityID()
	r.mu.Lock()
	if r.host == s {
		r.host = nil
		targets := make([]*session.Session, 0, len(r.members))
		for _, m := range r.members {
			targets = append(targets, m.sess)
		}
		r.retainTimer = time.AfterFunc(r.cfg.HostRetention, r.disband)
		r.mu.Unlock()
		r.log.Info("host lost, retaining room", "node", nodeID, "retention", r.cfg.HostRetention)
		lost := wire.NewEnvelope(wire.TypeGwHostLost, map[string]any{})
		for _, t := range targets {
			t.SendEnvelope(lost)
		}
		return
	}
	if m, ok := r.members[nodeID]; ok && m.sess == s {
		m.stopTimer()
		delete(r.members, nodeID)
	}
	empty := r.host == nil && len(r.members) == 0 && r.retainTimer == nil
	r.mu.Unlock()
	if empty {
		r.markDisbanded()
		r.onEmpty(r.officeID)
	}
}

// disband closes every remaining session and releases the room (host never
// returned within the retention window).
func (r *Room) disband() {
	r.mu.Lock()
	if r.disbanded {
		r.mu.Unlock()
		return
	}
	r.disbanded = true
	r.retainTimer = nil
	sessions := make([]*session.Session, 0, len(r.members))
	for _, m := range r.members {
		m.stopTimer()
		sessions = append(sessions, m.sess)
	}
	r.members = make(map[string]*member)
	r.mu.Unlock()
	r.log.Info("room disbanded after host retention timeout")
	for _, s := range sessions {
		s.CloseGraceful()
	}
	r.onEmpty(r.officeID)
}

func (r *Room) markDisbanded() {
	r.mu.Lock()
	r.disbanded = true
	if r.retainTimer != nil {
		r.retainTimer.Stop()
		r.retainTimer = nil
	}
	r.mu.Unlock()
}

// closeAll tears down every session in the room (gateway shutdown).
func (r *Room) closeAll() {
	r.mu.Lock()
	sessions := make([]*session.Session, 0, len(r.members)+1)
	if r.host != nil {
		sessions = append(sessions, r.host)
	}
	for _, m := range r.members {
		m.stopTimer()
		sessions = append(sessions, m.sess)
	}
	r.markDisbandedLocked()
	r.mu.Unlock()
	for _, s := range sessions {
		s.Close()
	}
}

func (r *Room) markDisbandedLocked() {
	r.disbanded = true
	if r.retainTimer != nil {
		r.retainTimer.Stop()
		r.retainTimer = nil
	}
}

// isHost reports whether s is this room's current host connection.
func (r *Room) isHost(s *session.Session) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.host == s
}

// marshalForward re-encodes an inbound federation envelope for delivery,
// stripping the gateway-only "to" field.
func marshalForward(env *wire.Envelope) []byte {
	out := wire.Envelope{Type: wire.TypeFederation, Payload: env.Payload}
	data, err := json.Marshal(&out)
	if err != nil {
		return nil
	}
	return data
}
