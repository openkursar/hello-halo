package httpapi_test

// v2-gw resilience vocabulary: the term-locked host pin (an elected authority
// takes a room over immediately; a resurrected stale host is refused) and the
// hostless member-to-member relay of the election control frames. Together
// they are the gateway half of "authority is transferable, the host may die".

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/openkursar/hello-halo/gateway/internal/gwtest"
	"github.com/openkursar/hello-halo/gateway/internal/room"
	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

func hostAttachTerm(c *gwtest.Client, officeID string, term int64) {
	c.T.Helper()
	c.Send(map[string]any{
		"type":    "gw:host-attach",
		"payload": map[string]any{"officeId": officeID, "term": term},
	})
}

func TestHigherTermTakesRoomOverImmediately(t *testing.T) {
	// Retention window deliberately long: only the term lock can admit the
	// successor inside the test budget.
	srv, m := newGateway(t, gatewayOpts{room: room.Config{HostRetention: time.Hour}})
	oldHost, newHost := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	a := gwtest.Dial(t, srv)
	a.Auth(oldHost, office)
	hostAttachTerm(a, office, 1)
	a.Expect(wire.TypeGwAttached, 2*time.Second)

	_ = a.Conn.Close() // the office creator crashes

	// The elected successor claims the room with the HIGHER tenure — admitted
	// at once, no retention wait.
	b := gwtest.Dial(t, srv)
	b.Auth(newHost, office)
	hostAttachTerm(b, office, 2)
	b.Expect(wire.TypeGwAttached, 2*time.Second)

	if got := m.HostTakeoversTotal.Load(); got != 1 {
		t.Fatalf("expected 1 host takeover, got %d", got)
	}
}

func TestStaleTermCannotReclaimRoom(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{room: room.Config{HostRetention: time.Hour}})
	oldHost, newHost := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	a := gwtest.Dial(t, srv)
	a.Auth(oldHost, office)
	hostAttachTerm(a, office, 1)
	a.Expect(wire.TypeGwAttached, 2*time.Second)
	_ = a.Conn.Close()

	b := gwtest.Dial(t, srv)
	b.Auth(newHost, office)
	hostAttachTerm(b, office, 2)
	b.Expect(wire.TypeGwAttached, 2*time.Second)

	// The resurrected old authority tries to reclaim with its sealed tenure —
	// refused explicitly, even though it once owned the pin.
	revived := gwtest.Dial(t, srv)
	revived.Auth(oldHost, office)
	hostAttachTerm(revived, office, 1)
	expectGwError(t, revived.Recv(2*time.Second), wire.CodeStaleTerm)
}

func TestHostlessElectionRelayBetweenAdmittedMembers(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{room: room.Config{HostRetention: time.Hour}})
	hostNode := gwtest.NewNode(t, 1)
	m1Node, m2Node := gwtest.NewNode(t, 2), gwtest.NewNode(t, 3)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)

	m1 := gwtest.Dial(t, srv)
	m1.Auth(m1Node, office)
	m2 := gwtest.Dial(t, srv)
	m2.Auth(m2Node, office)
	host.SendFederation(m1Node.ID, fedPayload(hostNode, "join-grant", map[string]any{"assignedNodeId": m1Node.ID}))
	host.SendFederation(m2Node.ID, fedPayload(hostNode, "join-grant", map[string]any{"assignedNodeId": m2Node.ID}))
	m1.Expect(wire.TypeFederation, 2*time.Second)
	m2.Expect(wire.TypeFederation, 2*time.Second)

	_ = host.Conn.Close()
	m1.Expect(wire.TypeGwHostLost, 2*time.Second)
	m2.Expect(wire.TypeGwHostLost, 2*time.Second)

	// A member's election claim is relayed to the other admitted member with
	// the proven origin stamped — the survivors can elect through the relay.
	m1.SendFederation("", fedPayload(m1Node, "authority-claim", map[string]any{
		"term": 2, "baseSeq": 0, "rosterEpoch": 1, "rosterNodes": []string{}, "fid": "f-claim",
	}))
	env := m2.Expect(wire.TypeFederation, 2*time.Second)
	if payloadKind(t, env) != "authority-claim" {
		t.Fatalf("expected relayed authority-claim, got %q", payloadKind(t, env))
	}
	if env.From != m1Node.ID {
		t.Fatalf("relayed claim from = %q, want proven sender %q", env.From, m1Node.ID)
	}

	// Business planes stay host-routed: a non-election kind in the hostless
	// window still answers HOST_UNREACHABLE (the relay is not a mesh).
	m1.SendFederation("", fedPayload(m1Node, "wake", map[string]any{"correlationId": "c1"}))
	expectGwError(t, m1.Recv(2*time.Second), wire.CodeHostUnreachable)
}

func TestElectionRelayIsRateLimited(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{
		room: room.Config{HostRetention: time.Hour, ElectionRelayPerSec: 3},
	})
	hostNode := gwtest.NewNode(t, 1)
	m1Node, m2Node := gwtest.NewNode(t, 2), gwtest.NewNode(t, 3)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)
	m1 := gwtest.Dial(t, srv)
	m1.Auth(m1Node, office)
	m2 := gwtest.Dial(t, srv)
	m2.Auth(m2Node, office)
	host.SendFederation(m1Node.ID, fedPayload(hostNode, "join-grant", map[string]any{"assignedNodeId": m1Node.ID}))
	host.SendFederation(m2Node.ID, fedPayload(hostNode, "join-grant", map[string]any{"assignedNodeId": m2Node.ID}))
	m1.Expect(wire.TypeFederation, 2*time.Second)
	m2.Expect(wire.TypeFederation, 2*time.Second)
	_ = host.Conn.Close()
	m1.Expect(wire.TypeGwHostLost, 2*time.Second)
	m2.Expect(wire.TypeGwHostLost, 2*time.Second)

	for i := 0; i < 3; i++ {
		m1.SendFederation("", fedPayload(m1Node, "authority-claim", map[string]any{"term": 2, "fid": "f"}))
		m2.Expect(wire.TypeFederation, 2*time.Second)
	}
	// The 4th frame inside the same one-second window is shed with an explicit
	// error, starving an amplifying member without harming the earlier frames.
	m1.SendFederation("", fedPayload(m1Node, "authority-claim", map[string]any{"term": 2, "fid": "f"}))
	expectGwError(t, m1.Recv(2*time.Second), wire.CodeRateLimited)
}

func TestPendingMemberCannotUseElectionRelay(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{room: room.Config{HostRetention: time.Hour}})
	hostNode := gwtest.NewNode(t, 1)
	admittedNode, pendingNode := gwtest.NewNode(t, 2), gwtest.NewNode(t, 3)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)
	admitted := gwtest.Dial(t, srv)
	admitted.Auth(admittedNode, office)
	pending := gwtest.Dial(t, srv)
	pending.Auth(pendingNode, office)
	host.SendFederation(admittedNode.ID, fedPayload(hostNode, "join-grant", map[string]any{"assignedNodeId": admittedNode.ID}))
	admitted.Expect(wire.TypeFederation, 2*time.Second)
	_ = host.Conn.Close()
	admitted.Expect(wire.TypeGwHostLost, 2*time.Second)
	pending.Expect(wire.TypeGwHostLost, 2*time.Second)

	// A never-admitted session's election frame is dropped (admission still
	// requires a host), and admitted members receive nothing from it.
	pending.SendFederation("", fedPayload(pendingNode, "authority-claim", map[string]any{"term": 2, "fid": "f"}))
	if _, err := admitted.TryRecv(300 * time.Millisecond); err == nil {
		t.Fatal("admitted member received a pending member's election frame")
	}
}

func TestV1TakeoverResetsTermLock(t *testing.T) {
	// Mixed-version handover: after a term-less v1 node takes a room over (post
	// retention), the pin must NOT inherit the previous holder's term — a
	// legitimate authority reattaching at that same term would otherwise be
	// STALE_TERM-locked out of its own office forever.
	srv, _ := newGateway(t, gatewayOpts{room: room.Config{HostRetention: 150 * time.Millisecond}})
	termedHost, v1Host := gwtest.NewNode(t, 1), gwtest.NewNode(t, 2)

	a := gwtest.Dial(t, srv)
	a.Auth(termedHost, office)
	hostAttachTerm(a, office, 5)
	a.Expect(wire.TypeGwAttached, 2*time.Second)
	_ = a.Conn.Close()

	time.Sleep(250 * time.Millisecond) // past the retention window

	// v1 takeover (no term) succeeds and resets the lock.
	b := gwtest.Dial(t, srv)
	b.Auth(v1Host, office)
	b.HostAttach(office)
	_ = b.Conn.Close()

	// The termed authority reattaches at its own tenure: term 5 > reset 0 —
	// immediate takeover, not STALE_TERM.
	revived := gwtest.Dial(t, srv)
	revived.Auth(termedHost, office)
	hostAttachTerm(revived, office, 5)
	revived.Expect(wire.TypeGwAttached, 2*time.Second)
}

func TestElectionRelayHonorsAddressedFrames(t *testing.T) {
	// Addressed election traffic (votes, catch-up replies — potentially
	// snapshot-sized) must reach ONLY its target, never fan out roomwide.
	srv, _ := newGateway(t, gatewayOpts{room: room.Config{HostRetention: time.Hour}})
	hostNode := gwtest.NewNode(t, 1)
	m1Node, m2Node, m3Node := gwtest.NewNode(t, 2), gwtest.NewNode(t, 3), gwtest.NewNode(t, 4)

	host := gwtest.Dial(t, srv)
	host.Auth(hostNode, office)
	host.HostAttach(office)
	m1 := gwtest.Dial(t, srv)
	m1.Auth(m1Node, office)
	m2 := gwtest.Dial(t, srv)
	m2.Auth(m2Node, office)
	m3 := gwtest.Dial(t, srv)
	m3.Auth(m3Node, office)
	for _, id := range []string{m1Node.ID, m2Node.ID, m3Node.ID} {
		host.SendFederation(id, fedPayload(hostNode, "join-grant", map[string]any{"assignedNodeId": id}))
	}
	m1.Expect(wire.TypeFederation, 2*time.Second)
	m2.Expect(wire.TypeFederation, 2*time.Second)
	m3.Expect(wire.TypeFederation, 2*time.Second)
	_ = host.Conn.Close()
	m1.Expect(wire.TypeGwHostLost, 2*time.Second)
	m2.Expect(wire.TypeGwHostLost, 2*time.Second)
	m3.Expect(wire.TypeGwHostLost, 2*time.Second)

	m1.SendFederation(m2Node.ID, fedPayload(m1Node, "catchup-response", map[string]any{
		"term": 2, "reFid": "f1", "mode": "incremental", "entries": []any{}, "fid": "f2",
	}))
	env := m2.Expect(wire.TypeFederation, 2*time.Second)
	if payloadKind(t, env) != "catchup-response" {
		t.Fatalf("expected addressed catchup-response, got %q", payloadKind(t, env))
	}
	if _, err := m3.TryRecv(300 * time.Millisecond); err == nil {
		t.Fatal("addressed election frame leaked to a third member")
	}
}

func TestAuthWirePvNegotiation(t *testing.T) {
	srv, _ := newGateway(t, gatewayOpts{})
	node := gwtest.NewNode(t, 1)

	// A declared-and-incompatible version is refused explicitly at auth.
	tooNew := gwtest.Dial(t, srv)
	tooNew.Send(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": "", "federation": true, "officeId": office, "wirePv": 99},
	})
	env := tooNew.Recv(2 * time.Second)
	if env.Type != wire.TypeAuthFailed || env.Error != wire.CodeVersionIncompatible {
		t.Fatalf("expected auth:failed %s, got type=%q error=%q", wire.CodeVersionIncompatible, env.Type, env.Error)
	}

	// A compatible client learns the gateway's wire version on success.
	ok := gwtest.Dial(t, srv)
	ok.Auth(node, office)
	// Auth() already consumed auth:success; re-dial to inspect the payload.
	inspect := gwtest.Dial(t, srv)
	inspect.Send(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": "", "federation": true, "officeId": office, "wirePv": wire.WirePvCurrent},
	})
	challenge := inspect.Expect(wire.TypeAuthChallenge, 2*time.Second)
	var p struct {
		Nonce string `json:"nonce"`
	}
	if err := json.Unmarshal(challenge.Payload, &p); err != nil || p.Nonce == "" {
		t.Fatalf("challenge payload: %v", err)
	}
	inspect.Send(map[string]any{
		"type": "auth",
		"payload": map[string]any{
			"token": "", "federation": true, "officeId": office,
			"proof": node.Proof(t, p.Nonce), "wirePv": wire.WirePvCurrent,
		},
	})
	success := inspect.Expect(wire.TypeAuthSuccess, 2*time.Second)
	var sp struct {
		WirePv int `json:"wirePv"`
	}
	if err := json.Unmarshal(success.Payload, &sp); err != nil || sp.WirePv != wire.WirePvCurrent {
		t.Fatalf("auth:success should echo wirePv=%d, got payload=%s", wire.WirePvCurrent, success.Payload)
	}
}
