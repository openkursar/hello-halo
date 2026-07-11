// Package directory implements the in-memory discovery directory (§9.3):
// signed node endpoint announcements with TTL expiry, scoped per office.
// State is memory-only by design — a gateway restart empties it and nodes
// rebuild it by re-announcing.
package directory

import (
	"crypto/ed25519"
	"encoding/base64"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

// Error is a rejection with a gw:error code.
type Error struct {
	Code   string
	Detail string
}

func (e *Error) Error() string { return e.Code + ": " + e.Detail }

type entry struct {
	displayName string
	endpoints   []string
	ts          int64
	expiresAt   time.Time
}

type Directory struct {
	mu      sync.Mutex
	offices map[string]map[string]entry // officeId -> identityId -> entry

	ttl     time.Duration
	maxSkew time.Duration
	now     func() time.Time
}

// Options tunables; zero values take the §9.3 defaults (TTL 90s, skew 5m).
type Options struct {
	TTL          time.Duration
	MaxClockSkew time.Duration
	Now          func() time.Time
}

func New(opts Options) *Directory {
	if opts.TTL == 0 {
		opts.TTL = 90 * time.Second
	}
	if opts.MaxClockSkew == 0 {
		opts.MaxClockSkew = 5 * time.Minute
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Directory{
		offices: make(map[string]map[string]entry),
		ttl:     opts.TTL,
		maxSkew: opts.MaxClockSkew,
		now:     opts.Now,
	}
}

// SignaturePayload builds the exact byte string a node signs for gw:announce:
// "halo-gw-announce\n<officeId>\n<identityId>\n<ts>\n<endpoints joined by \n>".
func SignaturePayload(officeID, identityID string, ts int64, endpoints []string) []byte {
	return []byte("halo-gw-announce\n" + officeID + "\n" + identityID + "\n" +
		strconv.FormatInt(ts, 10) + "\n" + strings.Join(endpoints, "\n"))
}

// Announce verifies and stores an announcement under the session's proven
// identity. ts is epoch milliseconds; skew beyond the limit is rejected.
func (d *Directory) Announce(officeID, identityID string, pub ed25519.PublicKey, p wire.AnnouncePayload) *Error {
	now := d.now()
	skew := now.Sub(time.UnixMilli(p.TS))
	if skew < 0 {
		skew = -skew
	}
	if skew > d.maxSkew {
		return &Error{Code: wire.CodeClockSkew, Detail: "announce timestamp too far from gateway clock"}
	}
	sig, err := base64.StdEncoding.DecodeString(p.Sig)
	if err != nil || !ed25519.Verify(pub, SignaturePayload(officeID, identityID, p.TS, p.Endpoints), sig) {
		return &Error{Code: wire.CodeBadSignature, Detail: "announce signature verification failed"}
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	office, ok := d.offices[officeID]
	if !ok {
		office = make(map[string]entry)
		d.offices[officeID] = office
	}
	office[identityID] = entry{
		displayName: p.DisplayName,
		endpoints:   append([]string(nil), p.Endpoints...),
		ts:          p.TS,
		expiresAt:   now.Add(d.ttl),
	}
	return nil
}

// Lookup returns the live entries for an office, sorted by node id for
// deterministic responses.
func (d *Directory) Lookup(officeID string) []wire.DirectoryEntry {
	now := d.now()
	d.mu.Lock()
	defer d.mu.Unlock()
	office := d.offices[officeID]
	entries := make([]wire.DirectoryEntry, 0, len(office))
	for nodeID, e := range office {
		if now.After(e.expiresAt) {
			delete(office, nodeID)
			continue
		}
		entries = append(entries, wire.DirectoryEntry{
			NodeID:      nodeID,
			DisplayName: e.displayName,
			Endpoints:   append([]string(nil), e.endpoints...),
			TS:          e.ts,
		})
	}
	if len(office) == 0 {
		delete(d.offices, officeID)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].NodeID < entries[j].NodeID })
	return entries
}

// Remove drops one node's entry (its session closed).
func (d *Directory) Remove(officeID, identityID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if office, ok := d.offices[officeID]; ok {
		delete(office, identityID)
		if len(office) == 0 {
			delete(d.offices, officeID)
		}
	}
}

// DropOffice discards an office's whole directory (room disbanded).
func (d *Directory) DropOffice(officeID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.offices, officeID)
}
