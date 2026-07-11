// Package identity implements the device-key identity scheme (§3.3): Ed25519
// public keys, the stable identity-id derivation, and proof verification.
// The derivation must stay byte-for-byte identical to the TS node
// implementation (deriveIdentityId in src/main/http/identity/device-key.ts).
package identity

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
)

var (
	ErrNotEd25519    = errors.New("identity: public key is not Ed25519")
	ErrBadPEM        = errors.New("identity: invalid public key PEM")
	ErrIDMismatch    = errors.New("identity: public key does not derive claimed id")
	ErrBadSignature  = errors.New("identity: signature verification failed")
	ErrBadChallenge  = errors.New("identity: challenge is not valid base64")
	ErrWrongMethod   = errors.New("identity: unsupported proof method")
	ErrEmptyIdentity = errors.New("identity: missing identity id")
)

// DeriveID computes the stable identity id from an SPKI DER public key:
// "id_" + base64url(sha256(SPKI_DER))[:32], base64url without padding.
func DeriveID(spkiDER []byte) string {
	sum := sha256.Sum256(spkiDER)
	return "id_" + base64.RawURLEncoding.EncodeToString(sum[:])[:32]
}

// ParsePublicKeyPEM parses an SPKI PEM and returns the Ed25519 public key
// together with the SPKI DER bytes used for id derivation.
func ParsePublicKeyPEM(pemStr string) (ed25519.PublicKey, []byte, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil || block.Type != "PUBLIC KEY" {
		return nil, nil, ErrBadPEM
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, nil, ErrBadPEM
	}
	pub, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, nil, ErrNotEd25519
	}
	return pub, block.Bytes, nil
}

// VerifyProof checks a device-key proof against the challenge nonce this
// connection issued (§3.3): the public key must derive the claimed id, the
// proof must echo this connection's challenge, and the signature must verify
// over the base64-decoded nonce bytes. Returns the proven public key.
func VerifyProof(method, identityID, publicKeyPEM, challenge, signature, issuedNonce string) (ed25519.PublicKey, error) {
	if method != "device-key" {
		return nil, ErrWrongMethod
	}
	if identityID == "" {
		return nil, ErrEmptyIdentity
	}
	if challenge != issuedNonce {
		return nil, ErrBadChallenge
	}
	pub, der, err := ParsePublicKeyPEM(publicKeyPEM)
	if err != nil {
		return nil, err
	}
	if DeriveID(der) != identityID {
		return nil, ErrIDMismatch
	}
	nonceBytes, err := base64.StdEncoding.DecodeString(issuedNonce)
	if err != nil {
		return nil, ErrBadChallenge
	}
	sig, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return nil, ErrBadSignature
	}
	if !ed25519.Verify(pub, nonceBytes, sig) {
		return nil, ErrBadSignature
	}
	return pub, nil
}
