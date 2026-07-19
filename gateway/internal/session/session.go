// Package session owns one WebSocket connection: framing, the two-leg
// device-key authentication state machine (§3.2/§9.1), keepalive, and
// per-session rate limiting. Routing decisions are delegated to a Handler.
package session

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/openkursar/hello-halo/gateway/internal/identity"
	"github.com/openkursar/hello-halo/gateway/internal/metrics"
	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

// Outbound is the per-session prioritized send queue. Push never blocks;
// Pop blocks until data is available or the queue is closed.
type Outbound interface {
	Push(plane wire.Plane, data []byte) bool
	Pop() ([]byte, bool)
	Close()
}

// Handler receives session lifecycle and post-auth frames.
type Handler interface {
	OnAuthenticated(s *Session)
	OnFrame(s *Session, env *wire.Envelope)
	OnClose(s *Session)
}

// Options carries the tunables a session needs; zero values are replaced by
// production defaults in New.
type Options struct {
	MaxFrameBytes int64
	FrameRate     float64
	FrameBurst    int
	ChallengeTTL  time.Duration
	PingInterval  time.Duration
	CloseGrace    time.Duration
	Logger        *slog.Logger
	Metrics       *metrics.Metrics
	Now           func() time.Time
}

func (o *Options) fillDefaults() {
	if o.MaxFrameBytes == 0 {
		o.MaxFrameBytes = 1 << 20
	}
	if o.FrameRate == 0 {
		o.FrameRate = 500
	}
	if o.FrameBurst == 0 {
		o.FrameBurst = int(o.FrameRate)
	}
	if o.ChallengeTTL == 0 {
		o.ChallengeTTL = 60 * time.Second
	}
	if o.PingInterval == 0 {
		o.PingInterval = 30 * time.Second
	}
	if o.CloseGrace == 0 {
		o.CloseGrace = 100 * time.Millisecond
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.Metrics == nil {
		o.Metrics = metrics.New()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
}

// Session is one authenticated (or authenticating) WebSocket connection.
type Session struct {
	conn    *websocket.Conn
	out     Outbound
	handler Handler
	opts    Options
	limiter *TokenBucket

	mu            sync.Mutex
	authed        bool
	identityID    string
	publicKey     ed25519.PublicKey
	officeID      string
	pendingNonce  string
	nonceIssuedAt time.Time

	closeOnce    sync.Once
	closed       chan struct{}
	gracePending atomic.Bool
	remote       string
}

func New(conn *websocket.Conn, out Outbound, handler Handler, opts Options) *Session {
	opts.fillDefaults()
	return &Session{
		conn:    conn,
		out:     out,
		handler: handler,
		opts:    opts,
		limiter: NewTokenBucket(opts.FrameRate, opts.FrameBurst),
		closed:  make(chan struct{}),
		remote:  conn.RemoteAddr().String(),
	}
}

// Authenticated reports whether the auth handshake completed.
func (s *Session) Authenticated() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.authed
}

// IdentityID is the proven device-key identity (empty before auth).
func (s *Session) IdentityID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.identityID
}

// PublicKey is the proven Ed25519 public key (nil before auth).
func (s *Session) PublicKey() ed25519.PublicKey {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.publicKey
}

// OfficeID is the office this connection serves (one office per connection).
func (s *Session) OfficeID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.officeID
}

func (s *Session) RemoteAddr() string { return s.remote }

// Run drives the session until the connection dies. It blocks.
func (s *Session) Run() {
	go s.writeLoop()
	go s.pingLoop()
	s.readLoop()
}

// SendEnvelope enqueues a control-plane message.
func (s *Session) SendEnvelope(env *wire.Envelope) {
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	s.SendData(wire.PlaneControl, data)
}

// SendData enqueues pre-marshalled bytes on the given plane.
// Returns false when the frame was dropped (queue overflow or closed session).
func (s *Session) SendData(plane wire.Plane, data []byte) bool {
	return s.out.Push(plane, data)
}

// SendGwError enqueues a gw:error without closing the session.
func (s *Session) SendGwError(code, detail string) {
	s.SendEnvelope(wire.NewGwError(code, detail))
}

// CloseWithGwError sends gw:error and closes after a short drain grace.
func (s *Session) CloseWithGwError(code, detail string) {
	s.SendGwError(code, detail)
	s.closeAfterGrace()
}

// CloseWithAuthFailed sends auth:failed (non-transient: clients stop retrying)
// and closes after a short drain grace.
func (s *Session) CloseWithAuthFailed(errMsg string) {
	s.opts.Metrics.AuthFailuresTotal.Add(1)
	s.SendEnvelope(&wire.Envelope{Type: wire.TypeAuthFailed, Error: errMsg})
	s.closeAfterGrace()
}

// Close tears the session down immediately.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		close(s.closed)
		s.out.Close()
		_ = s.conn.Close()
	})
}

// CloseGraceful lets queued frames drain briefly before closing.
func (s *Session) CloseGraceful() { s.closeAfterGrace() }

func (s *Session) closeAfterGrace() {
	s.gracePending.Store(true)
	time.AfterFunc(s.opts.CloseGrace, s.Close)
}

func (s *Session) readLoop() {
	defer func() {
		// A grace close is in flight when we sent a terminal error frame; let
		// the writer flush it instead of tearing the connection down now.
		if s.gracePending.Load() {
			<-s.closed
		} else {
			s.Close()
		}
		s.handler.OnClose(s)
	}()

	s.conn.SetReadLimit(s.opts.MaxFrameBytes)
	s.resetReadDeadline()
	s.conn.SetPongHandler(func(string) error {
		s.resetReadDeadline()
		return nil
	})

	for {
		_, data, err := s.conn.ReadMessage()
		if err != nil {
			if websocket.ErrReadLimit == err || isReadLimitClose(err) {
				s.opts.Metrics.FramesRejectedTotal.Add(1)
				s.CloseWithGwError(wire.CodeFrameTooLarge, "frame exceeds 1 MiB")
			}
			return
		}
		s.resetReadDeadline()

		var env wire.Envelope
		if err := json.Unmarshal(data, &env); err != nil || env.Type == "" {
			s.opts.Metrics.FramesRejectedTotal.Add(1)
			if s.Authenticated() {
				s.SendGwError(wire.CodeMalformed, "invalid JSON envelope")
				continue
			}
			s.CloseWithAuthFailed("Invalid message")
			return
		}

		if !s.Authenticated() {
			if env.Type != wire.TypeAuth {
				s.CloseWithAuthFailed("Not authenticated")
				return
			}
			if !s.handleAuth(&env) {
				return
			}
			continue
		}

		if !s.limiter.Allow(s.opts.Now()) {
			s.opts.Metrics.RateLimitedTotal.Add(1)
			s.CloseWithGwError(wire.CodeRateLimited, "session frame rate exceeded")
			return
		}
		if env.Type == wire.TypeAuth {
			continue
		}
		s.handler.OnFrame(s, &env)
	}
}

// handleAuth runs one leg of the handshake. Returns false when the session
// must stop reading (auth failed and the connection is closing).
func (s *Session) handleAuth(env *wire.Envelope) bool {
	var p wire.AuthPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		s.CloseWithAuthFailed("Invalid auth payload")
		return false
	}
	if !p.Federation || p.OfficeID == "" {
		// The gateway cannot verify office tokens (they are opaque here), so
		// bearer-only viewer sessions are not admittable.
		s.CloseWithAuthFailed("Gateway requires a federation session with officeId")
		return false
	}
	// Reject only a DECLARED-and-incompatible version; absent (0, v1) is admitted.
	if p.WirePv != 0 && (p.WirePv < wire.WirePvMin || p.WirePv > wire.WirePvCurrent) {
		// The auth:failed error field deliberately carries the machine-readable
		// code (not prose): clients match on it to distinguish "incompatible,
		// stop retrying" from transient auth failures.
		s.CloseWithAuthFailed(wire.CodeVersionIncompatible)
		return false
	}

	if len(p.Proof) == 0 || string(p.Proof) == "null" {
		nonce := make([]byte, 32)
		if _, err := rand.Read(nonce); err != nil {
			s.CloseWithAuthFailed("Internal error")
			return false
		}
		encoded := base64.StdEncoding.EncodeToString(nonce)
		s.mu.Lock()
		s.pendingNonce = encoded
		s.nonceIssuedAt = s.opts.Now()
		s.mu.Unlock()
		s.SendEnvelope(wire.NewEnvelope(wire.TypeAuthChallenge, map[string]string{"nonce": encoded}))
		return true
	}

	// One-shot: the challenge is consumed no matter what, so a failed attempt
	// can never retry against the same nonce.
	s.mu.Lock()
	nonce := s.pendingNonce
	issuedAt := s.nonceIssuedAt
	s.pendingNonce = ""
	s.mu.Unlock()

	if nonce == "" || s.opts.Now().Sub(issuedAt) > s.opts.ChallengeTTL {
		s.CloseWithAuthFailed("Invalid identity proof")
		return false
	}
	var proof wire.Proof
	if err := json.Unmarshal(p.Proof, &proof); err != nil {
		s.CloseWithAuthFailed("Invalid identity proof")
		return false
	}
	pub, err := identity.VerifyProof(
		proof.Method, proof.IdentityID, proof.PublicKey,
		proof.Challenge, proof.Signature, nonce,
	)
	if err != nil {
		s.opts.Logger.Warn("auth proof rejected", "remote", s.remote, "err", err)
		s.CloseWithAuthFailed("Invalid identity proof")
		return false
	}

	s.mu.Lock()
	s.authed = true
	s.identityID = proof.IdentityID
	s.publicKey = pub
	s.officeID = p.OfficeID
	s.mu.Unlock()

	// Echo the negotiated wire version so the client knows which vocabulary
	// (term lock, hostless election relay) this gateway actually supports.
	s.SendEnvelope(wire.NewEnvelope(wire.TypeAuthSuccess, map[string]int{"wirePv": wire.WirePvCurrent}))
	s.opts.Logger.Info("session authenticated",
		"identity", proof.IdentityID, "office", p.OfficeID, "remote", s.remote)
	s.handler.OnAuthenticated(s)
	return true
}

func (s *Session) writeLoop() {
	for {
		data, ok := s.out.Pop()
		if !ok {
			return
		}
		_ = s.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := s.conn.WriteMessage(websocket.TextMessage, data); err != nil {
			s.Close()
			return
		}
	}
}

// pingLoop sends protocol pings every PingInterval; the read deadline covers
// two missed pongs, after which the read loop reclaims the connection (§2).
func (s *Session) pingLoop() {
	ticker := time.NewTicker(s.opts.PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.closed:
			return
		case <-ticker.C:
			deadline := time.Now().Add(5 * time.Second)
			if err := s.conn.WriteControl(websocket.PingMessage, nil, deadline); err != nil {
				s.Close()
				return
			}
		}
	}
}

func (s *Session) resetReadDeadline() {
	// Two ping intervals plus slack: missing two consecutive pongs (and
	// sending nothing else) times the read out.
	_ = s.conn.SetReadDeadline(time.Now().Add(2*s.opts.PingInterval + 15*time.Second))
}

func isReadLimitClose(err error) bool {
	return websocket.IsCloseError(err, websocket.CloseMessageTooBig)
}
