package identity

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"regexp"
	"testing"
)

func fixedKey(t *testing.T) (ed25519.PrivateKey, ed25519.PublicKey, []byte, string) {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	pemStr := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	return priv, pub, der, pemStr
}

// Golden vector cross-checked against the TS implementation
// (deriveIdentityId in src/main/http/identity/device-key.ts) with the same
// seed bytes 0..31. Both sides must produce this exact id.
func TestDeriveIDGoldenVector(t *testing.T) {
	_, _, der, _ := fixedKey(t)
	const want = "id_oFCDfYUHBYLM9zlLCYiEfMMSy4glm4lI"
	if got := DeriveID(der); got != want {
		t.Fatalf("DeriveID = %q, want %q", got, want)
	}
}

func TestDeriveIDFormatAndStability(t *testing.T) {
	pattern := regexp.MustCompile(`^id_[A-Za-z0-9_-]{32}$`)
	for seed := byte(0); seed < 8; seed++ {
		s := make([]byte, ed25519.SeedSize)
		for i := range s {
			s[i] = seed + byte(i)
		}
		pub := ed25519.NewKeyFromSeed(s).Public().(ed25519.PublicKey)
		der, err := x509.MarshalPKIXPublicKey(pub)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		id := DeriveID(der)
		if !pattern.MatchString(id) {
			t.Fatalf("id %q does not match expected format", id)
		}
		if DeriveID(der) != id {
			t.Fatal("derivation is not stable")
		}
	}
}

func TestVerifyProof(t *testing.T) {
	priv, _, der, pemStr := fixedKey(t)
	id := DeriveID(der)
	nonce := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	nonceBytes, _ := base64.StdEncoding.DecodeString(nonce)
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, nonceBytes))

	t.Run("valid", func(t *testing.T) {
		pub, err := VerifyProof("device-key", id, pemStr, nonce, sig, nonce)
		if err != nil || pub == nil {
			t.Fatalf("expected success, got %v", err)
		}
	})
	t.Run("wrong method", func(t *testing.T) {
		if _, err := VerifyProof("sso", id, pemStr, nonce, sig, nonce); err != ErrWrongMethod {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("challenge not this connection's nonce", func(t *testing.T) {
		other := base64.StdEncoding.EncodeToString([]byte("ffffffffffffffffffffffffffffffff"))
		if _, err := VerifyProof("device-key", id, pemStr, other, sig, nonce); err != ErrBadChallenge {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("claimed id not derived from key", func(t *testing.T) {
		if _, err := VerifyProof("device-key", "id_impostor000000000000000000000000", pemStr, nonce, sig, nonce); err != ErrIDMismatch {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("signature by another key", func(t *testing.T) {
		otherSeed := make([]byte, ed25519.SeedSize)
		otherSeed[0] = 0xAA
		otherPriv := ed25519.NewKeyFromSeed(otherSeed)
		badSig := base64.StdEncoding.EncodeToString(ed25519.Sign(otherPriv, nonceBytes))
		if _, err := VerifyProof("device-key", id, pemStr, nonce, badSig, nonce); err != ErrBadSignature {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("garbage pem", func(t *testing.T) {
		if _, err := VerifyProof("device-key", id, "not a pem", nonce, sig, nonce); err != ErrBadPEM {
			t.Fatalf("got %v", err)
		}
	})
}
