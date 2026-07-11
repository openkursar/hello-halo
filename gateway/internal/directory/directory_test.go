package directory

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"testing"
	"time"

	"github.com/openkursar/hello-halo/gateway/internal/identity"
	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

func testKey(t *testing.T, seed byte) (ed25519.PrivateKey, ed25519.PublicKey, string) {
	t.Helper()
	s := make([]byte, ed25519.SeedSize)
	for i := range s {
		s[i] = seed + byte(i)
	}
	priv := ed25519.NewKeyFromSeed(s)
	pub := priv.Public().(ed25519.PublicKey)
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return priv, pub, identity.DeriveID(der)
}

func signedAnnounce(priv ed25519.PrivateKey, officeID, nodeID string, ts int64, endpoints []string) wire.AnnouncePayload {
	sig := ed25519.Sign(priv, SignaturePayload(officeID, nodeID, ts, endpoints))
	return wire.AnnouncePayload{
		Endpoints: endpoints,
		TS:        ts,
		Sig:       base64.StdEncoding.EncodeToString(sig),
	}
}

func TestAnnounceAndLookup(t *testing.T) {
	now := time.Now()
	d := New(Options{Now: func() time.Time { return now }})
	priv, pub, nodeID := testKey(t, 1)
	endpoints := []string{"https://10.0.0.5:8443", "https://fallback:8443"}
	p := signedAnnounce(priv, "office-1", nodeID, now.UnixMilli(), endpoints)

	if err := d.Announce("office-1", nodeID, pub, p); err != nil {
		t.Fatalf("announce: %v", err)
	}
	entries := d.Lookup("office-1")
	if len(entries) != 1 || entries[0].NodeID != nodeID || len(entries[0].Endpoints) != 2 {
		t.Fatalf("unexpected lookup result: %+v", entries)
	}
	if len(d.Lookup("other-office")) != 0 {
		t.Fatal("directory leaked entries across offices")
	}
}

func TestAnnounceRejectsBadSignature(t *testing.T) {
	now := time.Now()
	d := New(Options{Now: func() time.Time { return now }})
	priv, _, nodeID := testKey(t, 1)
	_, otherPub, _ := testKey(t, 9)
	p := signedAnnounce(priv, "office-1", nodeID, now.UnixMilli(), []string{"https://a"})

	err := d.Announce("office-1", nodeID, otherPub, p)
	if err == nil || err.Code != wire.CodeBadSignature {
		t.Fatalf("got %v, want BAD_SIGNATURE", err)
	}
	// Tampered endpoints break the signature too.
	p2 := signedAnnounce(priv, "office-1", nodeID, now.UnixMilli(), []string{"https://a"})
	p2.Endpoints = []string{"https://evil"}
	ownPub := priv.Public().(ed25519.PublicKey)
	if err := d.Announce("office-1", nodeID, ownPub, p2); err == nil || err.Code != wire.CodeBadSignature {
		t.Fatalf("got %v, want BAD_SIGNATURE for tampered endpoints", err)
	}
}

func TestAnnounceRejectsClockSkew(t *testing.T) {
	now := time.Now()
	d := New(Options{Now: func() time.Time { return now }})
	priv, pub, nodeID := testKey(t, 1)
	for _, ts := range []int64{
		now.Add(-6 * time.Minute).UnixMilli(),
		now.Add(6 * time.Minute).UnixMilli(),
	} {
		p := signedAnnounce(priv, "office-1", nodeID, ts, []string{"https://a"})
		if err := d.Announce("office-1", nodeID, pub, p); err == nil || err.Code != wire.CodeClockSkew {
			t.Fatalf("ts=%d: got %v, want CLOCK_SKEW", ts, err)
		}
	}
}

func TestEntryTTLExpiryAndRefresh(t *testing.T) {
	now := time.Now()
	current := now
	d := New(Options{TTL: 90 * time.Second, Now: func() time.Time { return current }})
	priv, pub, nodeID := testKey(t, 1)

	p := signedAnnounce(priv, "office-1", nodeID, current.UnixMilli(), []string{"https://a"})
	if err := d.Announce("office-1", nodeID, pub, p); err != nil {
		t.Fatalf("announce: %v", err)
	}

	current = now.Add(60 * time.Second)
	if len(d.Lookup("office-1")) != 1 {
		t.Fatal("entry expired before TTL")
	}

	// Refresh resets the TTL window.
	p2 := signedAnnounce(priv, "office-1", nodeID, current.UnixMilli(), []string{"https://a"})
	if err := d.Announce("office-1", nodeID, pub, p2); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	current = now.Add(120 * time.Second)
	if len(d.Lookup("office-1")) != 1 {
		t.Fatal("refreshed entry expired early")
	}

	current = now.Add(300 * time.Second)
	if len(d.Lookup("office-1")) != 0 {
		t.Fatal("entry survived past TTL")
	}
}

func TestRemove(t *testing.T) {
	now := time.Now()
	d := New(Options{Now: func() time.Time { return now }})
	priv, pub, nodeID := testKey(t, 1)
	p := signedAnnounce(priv, "office-1", nodeID, now.UnixMilli(), []string{"https://a"})
	if err := d.Announce("office-1", nodeID, pub, p); err != nil {
		t.Fatalf("announce: %v", err)
	}
	d.Remove("office-1", nodeID)
	if len(d.Lookup("office-1")) != 0 {
		t.Fatal("entry survived removal")
	}
}
