// Package gwtest provides test-only helpers: deterministic node identities,
// device-key proof signing, and a small WebSocket client for driving a real
// gateway over httptest connections.
package gwtest

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/openkursar/hello-halo/gateway/internal/directory"
	"github.com/openkursar/hello-halo/gateway/internal/identity"
	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

// Node is a test identity with its device keypair.
type Node struct {
	Priv   ed25519.PrivateKey
	Pub    ed25519.PublicKey
	PubPEM string
	ID     string
}

// NewNode derives a deterministic node identity from a seed byte.
func NewNode(t *testing.T, seed byte) *Node {
	t.Helper()
	seedBytes := make([]byte, ed25519.SeedSize)
	for i := range seedBytes {
		seedBytes[i] = seed + byte(i)
	}
	priv := ed25519.NewKeyFromSeed(seedBytes)
	pub := priv.Public().(ed25519.PublicKey)
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatalf("marshal public key: %v", err)
	}
	pemStr := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	return &Node{Priv: priv, Pub: pub, PubPEM: pemStr, ID: identity.DeriveID(der)}
}

// Proof signs the challenge nonce exactly as the TS node does.
func (n *Node) Proof(t *testing.T, nonce string) map[string]any {
	t.Helper()
	nonceBytes, err := base64.StdEncoding.DecodeString(nonce)
	if err != nil {
		t.Fatalf("decode nonce: %v", err)
	}
	sig := ed25519.Sign(n.Priv, nonceBytes)
	return map[string]any{
		"method":     "device-key",
		"identityId": n.ID,
		"publicKey":  n.PubPEM,
		"challenge":  nonce,
		"signature":  base64.StdEncoding.EncodeToString(sig),
	}
}

// SignAnnounce produces the base64 signature for a gw:announce payload.
func (n *Node) SignAnnounce(officeID string, ts int64, endpoints []string) string {
	sig := ed25519.Sign(n.Priv, directory.SignaturePayload(officeID, n.ID, ts, endpoints))
	return base64.StdEncoding.EncodeToString(sig)
}

// Client is a raw WebSocket test client.
type Client struct {
	T    *testing.T
	Conn *websocket.Conn
}

// Dial connects to a httptest server's /ws endpoint.
func Dial(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &Client{T: t, Conn: conn}
}

// Send writes one JSON message.
func (c *Client) Send(v any) {
	c.T.Helper()
	if err := c.Conn.WriteJSON(v); err != nil {
		c.T.Fatalf("send: %v", err)
	}
}

// Recv reads one envelope, failing the test after the timeout.
func (c *Client) Recv(timeout time.Duration) wire.Envelope {
	c.T.Helper()
	env, err := c.TryRecv(timeout)
	if err != nil {
		c.T.Fatalf("recv: %v", err)
	}
	return env
}

// TryRecv reads one envelope or returns the read error (e.g. connection
// closed by the gateway).
func (c *Client) TryRecv(timeout time.Duration) (wire.Envelope, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(timeout))
	var env wire.Envelope
	if err := c.Conn.ReadJSON(&env); err != nil {
		return wire.Envelope{}, err
	}
	return env, nil
}

// Expect reads one envelope and asserts its type.
func (c *Client) Expect(msgType string, timeout time.Duration) wire.Envelope {
	c.T.Helper()
	env := c.Recv(timeout)
	if env.Type != msgType {
		c.T.Fatalf("expected %q, got %q (payload=%s error=%q)", msgType, env.Type, env.Payload, env.Error)
	}
	return env
}

// Auth runs the full two-leg federation handshake.
func (c *Client) Auth(node *Node, officeID string) {
	c.T.Helper()
	c.Send(map[string]any{
		"type":    "auth",
		"payload": map[string]any{"token": "opaque-token", "federation": true, "officeId": officeID},
	})
	challenge := c.Expect(wire.TypeAuthChallenge, 2*time.Second)
	var p struct {
		Nonce string `json:"nonce"`
	}
	if err := json.Unmarshal(challenge.Payload, &p); err != nil || p.Nonce == "" {
		c.T.Fatalf("bad challenge payload: %s", challenge.Payload)
	}
	c.Send(map[string]any{
		"type": "auth",
		"payload": map[string]any{
			"token": "opaque-token", "federation": true, "officeId": officeID,
			"proof": node.Proof(c.T, p.Nonce),
		},
	})
	c.Expect(wire.TypeAuthSuccess, 2*time.Second)
}

// HostAttach declares this session the office host and waits for gw:attached.
func (c *Client) HostAttach(officeID string) {
	c.T.Helper()
	c.Send(map[string]any{"type": "gw:host-attach", "payload": map[string]any{"officeId": officeID}})
	c.Expect(wire.TypeGwAttached, 2*time.Second)
}

// SendFederation sends a federation frame; to == "" omits the field,
// to == "*" broadcasts (to: null).
func (c *Client) SendFederation(to string, payload map[string]any) {
	c.T.Helper()
	msg := map[string]any{"type": "federation", "payload": payload}
	switch to {
	case "":
	case "*":
		msg["to"] = nil
	default:
		msg["to"] = to
	}
	c.Send(msg)
}

// ExpectClosed asserts the gateway closes the connection within the timeout.
func (c *Client) ExpectClosed(timeout time.Duration) {
	c.T.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_ = c.Conn.SetReadDeadline(time.Now().Add(time.Until(deadline)))
		if _, _, err := c.Conn.ReadMessage(); err != nil {
			return
		}
	}
	c.T.Fatal("expected connection to be closed by gateway")
}
