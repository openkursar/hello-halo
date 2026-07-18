package httpapi_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/openkursar/hello-halo/gateway/internal/directory"
	"github.com/openkursar/hello-halo/gateway/internal/gwtest"
	"github.com/openkursar/hello-halo/gateway/internal/httpapi"
	"github.com/openkursar/hello-halo/gateway/internal/metrics"
	"github.com/openkursar/hello-halo/gateway/internal/room"
	"github.com/openkursar/hello-halo/gateway/internal/session"
	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

const office = "office-test"

type gatewayOpts struct {
	room      room.Config
	session   session.Options
	connRate  float64
	connBurst int
	dirOpts   directory.Options
}

func newGateway(t *testing.T, o gatewayOpts) (*httptest.Server, *metrics.Metrics) {
	t.Helper()
	if o.connRate == 0 {
		o.connRate = 1000
	}
	if o.connBurst == 0 {
		o.connBurst = 1000
	}
	m := metrics.New()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	dir := directory.New(o.dirOpts)
	hub := room.NewHub(o.room, dir, log, m)
	api := httpapi.New(httpapi.Options{
		Hub:            hub,
		Metrics:        m,
		Logger:         log,
		Version:        httpapi.VersionInfo{Name: "halo-gateway", Version: "test", Mode: "relay"},
		SessionOptions: o.session,
		ConnPerIPRate:  o.connRate,
		ConnPerIPBurst: o.connBurst,
	})
	srv := httptest.NewServer(api.Handler())
	t.Cleanup(func() {
		api.BeginShutdown()
		srv.Close()
	})
	return srv, m
}

func fedPayload(node *gwtest.Node, kind string, extra map[string]any) map[string]any {
	p := map[string]any{"kind": kind, "officeId": office, "fromNode": node.ID}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func payloadKind(t *testing.T, env wire.Envelope) string {
	t.Helper()
	var hdr struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(env.Payload, &hdr); err != nil {
		t.Fatalf("payload: %v", err)
	}
	return hdr.Kind
}

func expectGwError(t *testing.T, env wire.Envelope, code string) {
	t.Helper()
	if env.Type != wire.TypeGwError {
		t.Fatalf("expected gw:error, got %q (payload=%s)", env.Type, env.Payload)
	}
	var p wire.GwError
	if err := json.Unmarshal(env.Payload, &p); err != nil || p.Code != code {
		t.Fatalf("expected code %q, got %s", code, env.Payload)
	}
}

// --- authentication ---

func TestAuthHandshakeSucceeds(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	node := gwtest.NewNode(t, 1)
	c := gwtest.Dial(t, srv)
	c.Auth(node, office)
}

func TestAuthAcceptsEmptyToken(t *testing.T) {
	// §9.1: the token may be an empty string (a host has no invite token);
	// admission rests solely on the device-key proof.
	srv, _ := newGateway(t, gatewayOpts{})
	node := gwtest.NewNode(t, 1)
	c := gwtest.Dial(t, srv)
	c.Send(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": "", "federation": true, "officeId": office},
	})
	challenge := c.Expect(wire.TypeAuthChallenge, 2*time.Second)
	var p struct{ Nonce string }
	_ = json.Unmarshal(challenge.Payload, &p)
	c.Send(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": "", "federation": true, "officeId": office, "proof": node.Proof(t, p.Nonce)},
	})
	c.Expect(wire.TypeAuthSuccess, 2*time.Second)
}

func TestAuthRequiresFederationAndOffice(t *testing.T) {
	srv, m := newGateway(t, gatewayOpts{})
	cases := []map[string]any{
		{"token": "x", "federation": false, "officeId": office},
		{"token": "x", "federation": true},
	}
	for _, payload := range cases {
		c := gwtest.Dial(t, srv)
		c.Send(map[string]any{"type": "auth", "payload": payload})
		env := c.Recv(2 * time.Second)
		if env.Type != wire.TypeAuthFailed {
			t.Fatalf("expected auth:failed, got %q", env.Type)
		}
		c.ExpectClosed(2 * time.Second)
	}
	if m.AuthFailuresTotal.Load() != 2 {
		t.Fatalf("auth failures = %d, want 2", m.AuthFailuresTotal.Load())
	}
}

func TestAuthRejectsBadProofAndCloses(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	node := gwtest.NewNode(t, 1)
	impostor := gwtest.NewNode(t, 7)
	c := gwtest.Dial(t, srv)
	c.Send(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": "x", "federation": true, "officeId": office},
	})
	challenge := c.Expect(wire.TypeAuthChallenge, 2*time.Second)
	var p struct{ Nonce string }
	_ = json.Unmarshal(challenge.Payload, &p)

	// The impostor signs the nonce with its own key but claims node's id.
	proof := impostor.Proof(t, p.Nonce)
	proof["identityId"] = node.ID
	c.Send(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": "x", "federation": true, "officeId": office, "proof": proof},
	})
	env := c.Recv(2 * time.Second)
	if env.Type != wire.TypeAuthFailed {
		t.Fatalf("expected auth:failed, got %q", env.Type)
	}
	c.ExpectClosed(2 * time.Second)
}

func TestAuthProofWithoutChallengeFails(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	node := gwtest.NewNode(t, 1)
	c := gwtest.Dial(t, srv)
	// A proof over a self-invented nonce, with no challenge issued.
	proof := node.Proof(t, "c2VsZi1pbnZlbnRlZC1ub25jZS1ieXRlcyEh")
	c.Send(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": "x", "federation": true, "officeId": office, "proof": proof},
	})
	env := c.Recv(2 * time.Second)
	if env.Type != wire.TypeAuthFailed {
		t.Fatalf("expected auth:failed, got %q", env.Type)
	}
	c.ExpectClosed(2 * time.Second)
}

func TestAuthChallengeTTLExpires(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{
		session: session.Options{ChallengeTTL: 50 * time.Millisecond},
	})
	node := gwtest.NewNode(t, 1)
	c := gwtest.Dial(t, srv)
	c.Send(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": "x", "federation": true, "officeId": office},
	})
	challenge := c.Expect(wire.TypeAuthChallenge, 2*time.Second)
	var p struct{ Nonce string }
	_ = json.Unmarshal(challenge.Payload, &p)

	time.Sleep(150 * time.Millisecond)
	c.Send(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": "x", "federation": true, "officeId": office, "proof": node.Proof(t, p.Nonce)},
	})
	env := c.Recv(2 * time.Second)
	if env.Type != wire.TypeAuthFailed {
		t.Fatalf("expected auth:failed after TTL, got %q", env.Type)
	}
	c.ExpectClosed(2 * time.Second)
}

func TestNonAuthFrameBeforeAuthCloses(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	c := gwtest.Dial(t, srv)
	c.Send(map[string]any{"type": "federation", "payload": map[string]any{"kind": "heartbeat"}})
	env := c.Recv(2 * time.Second)
	if env.Type != wire.TypeAuthFailed {
		t.Fatalf("expected auth:failed, got %q", env.Type)
	}
	c.ExpectClosed(2 * time.Second)
}

// --- room routing ---

func TestMemberFramesRouteToHost(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	hostNode, memberNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)
	member.SendFederation("", fedPayload(memberNode, "join-request", map[string]any{"credentialToken": "tok"}))

	env := host.Expect(wire.TypeFederation, 2*time.Second)
	if payloadKind(t, env) != "join-request" {
		t.Fatalf("host received wrong kind")
	}
	if env.To != nil {
		t.Fatal("gateway must strip the to field on forwarded frames")
	}
	// The gateway stamps the proven sender identity so no-fromNode frames keep
	// their origin across the relay (§9.2).
	if env.From != memberNode.ID {
		t.Fatalf("forwarded frame from = %q, want proven member id %q", env.From, memberNode.ID)
	}
}

func TestForwardedFromStampSurvivesWithoutPayloadFromNode(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	hostNode, memberNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)
	// turn-complete carries NO fromNode in its payload; the envelope stamp is
	// the only origin signal the host can use.
	member.SendFederation("", fedPayload(memberNode, "turn-complete", map[string]any{
		"correlationId": "c1",
		"outcome":       map[string]any{"kind": "result", "content": "done"},
	}))

	env := host.Expect(wire.TypeFederation, 2*time.Second)
	if payloadKind(t, env) != "turn-complete" {
		t.Fatalf("host received wrong kind")
	}
	if env.From != memberNode.ID {
		t.Fatalf("no-fromNode frame lost its origin: from = %q, want %q", env.From, memberNode.ID)
	}
}

func TestHostUnreachable(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	memberNode := gwtest.NewNode(t, 2)
	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)
	member.SendFederation("", fedPayload(memberNode, "join-request", nil))
	expectGwError(t, member.Recv(2*time.Second), wire.CodeHostUnreachable)
}

func TestJoinGrantAdmitsAndBroadcastSkipsPending(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	hostNode := gwtest.NewNode(t, 1)
	m1Node, m2Node := gwtest.NewNode(t, 2), gwtest.NewNode(t, 3)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	m1 := gwtest.Dial(t, srv)
	m1.Auth(m1Node, office)
	m2 := gwtest.Dial(t, srv)
	m2.Auth(m2Node, office)

	// Host grants m1 only; m2 stays pending.
	host.SendFederation(m1Node.ID, fedPayload(hostNode, "join-grant", map[string]any{"assignedNodeId": m1Node.ID}))
	env := m1.Expect(wire.TypeFederation, 2*time.Second)
	if payloadKind(t, env) != "join-grant" {
		t.Fatal("member did not receive its join-grant")
	}

	host.SendFederation("*", fedPayload(hostNode, "presence-update", map[string]any{"status": "online", "members": []string{"a"}}))
	env = m1.Expect(wire.TypeFederation, 2*time.Second)
	if payloadKind(t, env) != "presence-update" {
		t.Fatal("admitted member did not receive broadcast")
	}
	if _, err := m2.TryRecv(200 * time.Millisecond); err == nil {
		t.Fatal("pending member received a broadcast")
	}
}

func TestJoinRejectDisconnectsMember(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	hostNode, memberNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)

	host.SendFederation(memberNode.ID, fedPayload(hostNode, "join-reject", map[string]any{"reason": "CREDENTIAL_INVALID"}))
	env := member.Expect(wire.TypeFederation, 2*time.Second)
	if payloadKind(t, env) != "join-reject" {
		t.Fatal("member did not receive join-reject before disconnect")
	}
	member.ExpectClosed(2 * time.Second)
}

func TestAdmissionTimeout(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{
		room: room.Config{AdmissionTimeout: 200 * time.Millisecond},
	})
	memberNode := gwtest.NewNode(t, 2)
	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)
	expectGwError(t, member.Recv(2*time.Second), wire.CodeAdmissionTimeout)
	member.ExpectClosed(2 * time.Second)
}

func TestSpoofedFromNodeIsDropped(t *testing.T) {
	srv, m := newGateway(t, gatewayOpts{})
	hostNode, memberNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)
	member.SendFederation("", map[string]any{
		"kind": "join-request", "officeId": office, "fromNode": "id_spoofed_identity_000000000000",
	})
	if _, err := host.TryRecv(200 * time.Millisecond); err == nil {
		t.Fatal("spoofed frame was forwarded to host")
	}
	if m.FramesRejectedTotal.Load() == 0 {
		t.Fatal("spoofed frame was not counted")
	}
}

func TestFrameWithoutFromNodeSkipsAssertion(t *testing.T) {
	// §9.1: frames that carry no fromNode (stream-frames, turn-complete,
	// roster, ...) skip the edge assertion and are forwarded normally.
	srv, m := newGateway(t, gatewayOpts{})
	hostNode, memberNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)

	// Directed host → member join-grant without fromNode admits and delivers.
	host.SendFederation(memberNode.ID, map[string]any{
		"kind": "join-grant", "officeId": office, "assignedNodeId": memberNode.ID,
	})
	env := member.Expect(wire.TypeFederation, 2*time.Second)
	if payloadKind(t, env) != "join-grant" {
		t.Fatal("fromNode-less join-grant was not forwarded to the member")
	}

	// Member → host frame without fromNode is forwarded.
	member.SendFederation("", map[string]any{
		"kind": "turn-complete", "officeId": office, "correlationId": "c-1",
	})
	env = host.Expect(wire.TypeFederation, 2*time.Second)
	if payloadKind(t, env) != "turn-complete" {
		t.Fatal("fromNode-less frame was not forwarded")
	}
	if m.FramesRejectedTotal.Load() != 0 {
		t.Fatal("fromNode-less frame was counted as rejected")
	}

	// A frame that DOES carry fromNode is still edge-asserted.
	member.SendFederation("", map[string]any{
		"kind": "heartbeat", "officeId": office, "fromNode": "id_spoofed_identity_000000000000",
	})
	if _, err := host.TryRecv(200 * time.Millisecond); err == nil {
		t.Fatal("spoofed frame was forwarded")
	}
	if m.FramesRejectedTotal.Load() != 1 {
		t.Fatal("spoofed frame was not counted")
	}
}

func TestOfficeMismatchRejected(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	memberNode := gwtest.NewNode(t, 2)
	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)
	member.SendFederation("", map[string]any{
		"kind": "join-request", "officeId": "another-office", "fromNode": memberNode.ID,
	})
	expectGwError(t, member.Recv(2*time.Second), wire.CodeMalformed)
}

func TestEvict(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	hostNode, memberNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)
	host.SendFederation(memberNode.ID, fedPayload(hostNode, "join-grant", nil))
	member.Expect(wire.TypeFederation, 2*time.Second)

	host.Send(map[string]any{"type": "gw:evict", "payload": map[string]any{"nodeId": memberNode.ID}})
	member.ExpectClosed(2 * time.Second)
}

func TestEvictFromNonHostRejected(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	memberNode := gwtest.NewNode(t, 2)
	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)
	member.Send(map[string]any{"type": "gw:evict", "payload": map[string]any{"nodeId": "id_x"}})
	expectGwError(t, member.Recv(2*time.Second), wire.CodeNotAttached)
}

func TestHostConflictAndSameIdentityTakeover(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	hostNode, otherNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	host1 := gwtest.Dial(t, srv)
	host1.Auth(hostNode, office)
	host1.HostAttach(office)

	// A different identity cannot displace a live host.
	other := gwtest.Dial(t, srv)
	other.Auth(otherNode, office)
	other.Send(map[string]any{"type": "gw:host-attach", "payload": map[string]any{"officeId": office}})
	expectGwError(t, other.Recv(2*time.Second), wire.CodeHostConflict)

	// The same identity replaces its own stale connection.
	host2 := gwtest.Dial(t, srv)
	host2.Auth(hostNode, office)
	host2.HostAttach(office)
	host1.ExpectClosed(2 * time.Second)
}

func TestHostLostRetentionAndDisband(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{
		room: room.Config{HostRetention: 300 * time.Millisecond},
	})
	hostNode, memberNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)
	host.SendFederation(memberNode.ID, fedPayload(hostNode, "join-grant", nil))
	member.Expect(wire.TypeFederation, 2*time.Second)

	_ = host.Conn.Close()
	member.Expect(wire.TypeGwHostLost, 2*time.Second)
	// No re-attach within the retention window: the room disbands and the
	// member connection is closed.
	member.ExpectClosed(2 * time.Second)
}

func TestHostReattachWithinRetention(t *testing.T) {
	srv, m := newGateway(t, gatewayOpts{
		room: room.Config{HostRetention: 5 * time.Second},
	})
	hostNode, memberNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)
	host.SendFederation(memberNode.ID, fedPayload(hostNode, "join-grant", nil))
	member.Expect(wire.TypeFederation, 2*time.Second)

	_ = host.Conn.Close()
	member.Expect(wire.TypeGwHostLost, 2*time.Second)

	// The office is pinned: a different identity cannot take over within the
	// retention window even though the old host is disconnected.
	squatterNode := gwtest.NewNode(t, 9)
	squatter := gwtest.Dial(t, srv)
	squatter.Auth(squatterNode, office)
	squatter.Send(map[string]any{"type": "gw:host-attach", "payload": map[string]any{"officeId": office}})
	expectGwError(t, squatter.Recv(2*time.Second), wire.CodeHostConflict)

	// The same identity re-attaches and traffic resumes.
	reHost := gwtest.Dial(t, srv)
	reHost.Auth(hostNode, office)
	reHost.HostAttach(office)

	member.SendFederation("", fedPayload(memberNode, "heartbeat", map[string]any{"ts": 1}))
	env := reHost.Expect(wire.TypeFederation, 2*time.Second)
	if payloadKind(t, env) != "heartbeat" {
		t.Fatal("re-attached host did not receive member traffic")
	}
	if m.HostTakeoversTotal.Load() != 0 {
		t.Fatal("same-identity re-attach must not count as a takeover")
	}
}

func TestHostTakeoverAfterRetention(t *testing.T) {
	srv, m := newGateway(t, gatewayOpts{
		room: room.Config{HostRetention: 200 * time.Millisecond},
	})
	hostNode, newHostNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 9)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)
	_ = host.Conn.Close()

	// Past the retention window a different identity may take over the office
	// (authority handover); the takeover is counted.
	time.Sleep(500 * time.Millisecond)
	newHost := gwtest.Dial(t, srv)
	newHost.Auth(newHostNode, office)
	newHost.HostAttach(office)

	if got := m.HostTakeoversTotal.Load(); got != 1 {
		t.Fatalf("host takeovers = %d, want 1", got)
	}
}

// --- planes ---

func TestPlaneClassificationForwarding(t *testing.T) {
	srv, m := newGateway(t, gatewayOpts{})
	hostNode, memberNode := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	member := gwtest.Dial(t, srv)
	member.Auth(memberNode, office)

	member.SendFederation("", fedPayload(memberNode, "stream-frames", map[string]any{"frames": []any{}}))
	member.SendFederation("", fedPayload(memberNode, "artifact-fetch", nil))
	member.SendFederation("", fedPayload(memberNode, "heartbeat", nil))
	for i := 0; i < 3; i++ {
		host.Expect(wire.TypeFederation, 2*time.Second)
	}
	if m.FramesForwardedTotal[wire.PlaneStream].Load() != 1 ||
		m.FramesForwardedTotal[wire.PlaneArtifact].Load() != 1 ||
		m.FramesForwardedTotal[wire.PlaneControl].Load() != 1 {
		t.Fatalf("plane counters wrong: control=%d stream=%d artifact=%d",
			m.FramesForwardedTotal[wire.PlaneControl].Load(),
			m.FramesForwardedTotal[wire.PlaneStream].Load(),
			m.FramesForwardedTotal[wire.PlaneArtifact].Load())
	}
}

// --- limits ---

func TestFrameTooLargeCloses(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{
		session: session.Options{MaxFrameBytes: 1024},
	})
	node := gwtest.NewNode(t, 1)
	c := gwtest.Dial(t, srv)
	c.Auth(node, office)
	big := strings.Repeat("x", 4096)
	c.SendFederation("", fedPayload(node, "heartbeat", map[string]any{"blob": big}))
	c.ExpectClosed(3 * time.Second)
}

func TestSessionFrameRateLimit(t *testing.T) {
	srv, m := newGateway(t, gatewayOpts{
		session: session.Options{FrameRate: 5, FrameBurst: 5},
	})
	node := gwtest.NewNode(t, 1)
	c := gwtest.Dial(t, srv)
	c.Auth(node, office)
	for i := 0; i < 10; i++ {
		c.SendFederation("", fedPayload(node, "heartbeat", nil))
	}
	deadline := time.Now().Add(3 * time.Second)
	sawRateLimited := false
	for time.Now().Before(deadline) {
		env, err := c.TryRecv(time.Until(deadline))
		if err != nil {
			break
		}
		if env.Type == wire.TypeGwError && strings.Contains(string(env.Payload), wire.CodeRateLimited) {
			sawRateLimited = true
		}
	}
	if !sawRateLimited {
		t.Fatal("expected gw:error RATE_LIMITED")
	}
	if m.RateLimitedTotal.Load() == 0 {
		t.Fatal("rate-limit counter not incremented")
	}
}

func TestConnPerIPRateLimit(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{connRate: 0.001, connBurst: 2})
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	for i := 0; i < 2; i++ {
		conn, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			t.Fatalf("connection %d rejected within burst: %v", i, err)
		}
		defer conn.Close()
	}
	_, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 beyond burst, got err=%v resp=%v", err, resp)
	}
}

// --- discovery directory ---

func TestAnnounceAndLookupOverWire(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	node := gwtest.NewNode(t, 1)
	c := gwtest.Dial(t, srv)
	c.Auth(node, office)

	ts := time.Now().UnixMilli()
	endpoints := []string{"https://10.1.2.3:8443"}
	c.Send(map[string]any{"type": "gw:announce", "payload": map[string]any{
		"endpoints": endpoints, "displayName": "Node One", "ts": ts,
		"sig": node.SignAnnounce(office, ts, endpoints),
	}})
	c.Send(map[string]any{"type": "gw:lookup", "payload": map[string]any{}})

	env := c.Expect(wire.TypeGwDirectory, 2*time.Second)
	var dir wire.DirectoryPayload
	if err := json.Unmarshal(env.Payload, &dir); err != nil {
		t.Fatalf("directory payload: %v", err)
	}
	if len(dir.Entries) != 1 || dir.Entries[0].NodeID != node.ID ||
		dir.Entries[0].DisplayName != "Node One" || dir.Entries[0].Endpoints[0] != endpoints[0] {
		t.Fatalf("unexpected directory: %+v", dir.Entries)
	}
}

func TestAnnounceBadSignatureOverWire(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	node, other := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)
	c := gwtest.Dial(t, srv)
	c.Auth(node, office)

	ts := time.Now().UnixMilli()
	endpoints := []string{"https://10.1.2.3:8443"}
	c.Send(map[string]any{"type": "gw:announce", "payload": map[string]any{
		"endpoints": endpoints, "ts": ts,
		"sig": other.SignAnnounce(office, ts, endpoints),
	}})
	expectGwError(t, c.Recv(2*time.Second), wire.CodeBadSignature)
}

func TestAnnounceClockSkewOverWire(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	node := gwtest.NewNode(t, 1)
	c := gwtest.Dial(t, srv)
	c.Auth(node, office)

	ts := time.Now().Add(-10 * time.Minute).UnixMilli()
	endpoints := []string{"https://10.1.2.3:8443"}
	c.Send(map[string]any{"type": "gw:announce", "payload": map[string]any{
		"endpoints": endpoints, "ts": ts,
		"sig": node.SignAnnounce(office, ts, endpoints),
	}})
	expectGwError(t, c.Recv(2*time.Second), wire.CodeClockSkew)
}

// --- HTTP surface ---

func TestHTTPSurface(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})

	get := func(path string) (*http.Response, string) {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, string(body)
	}

	if resp, _ := get("/healthz"); resp.StatusCode != 200 {
		t.Fatal("healthz not 200")
	}
	if resp, _ := get("/readyz"); resp.StatusCode != 200 {
		t.Fatal("readyz not 200")
	}
	resp, body := get("/version")
	if resp.StatusCode != 200 || !strings.Contains(body, "halo-gateway") {
		t.Fatalf("version endpoint wrong: %s", body)
	}
	resp, body = get("/metrics")
	if resp.StatusCode != 200 || !strings.Contains(body, "halo_gw_sessions_active") ||
		!strings.Contains(body, `halo_gw_frames_dropped_total{plane="artifact"}`) {
		t.Fatalf("metrics endpoint wrong: %s", body)
	}

	// Invite landing page: served on / and /invite, token never echoed.
	const token = "secret-invite-token-value"
	resp, body = get("/?office=office-1&invite=" + token)
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Type"), "text/html") {
		t.Fatal("invite page not served on /")
	}
	if strings.Contains(body, token) {
		t.Fatal("invite token echoed into HTML")
	}
	if !strings.Contains(body, "halo://join") {
		t.Fatal("invite page missing deep-link assembly")
	}
	if resp, _ = get("/invite?office=office-1&invite=" + token); resp.StatusCode != 200 {
		t.Fatal("invite page not served on /invite")
	}
	if resp, _ = get("/unknown-path"); resp.StatusCode != 404 {
		t.Fatal("unknown path should 404")
	}
}
