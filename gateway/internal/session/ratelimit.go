package session

import (
	"sync"
	"time"
)

// TokenBucket is a standard token-bucket rate limiter.
type TokenBucket struct {
	mu     sync.Mutex
	tokens float64
	rate   float64
	burst  float64
	last   time.Time
}

func NewTokenBucket(rate float64, burst int) *TokenBucket {
	return &TokenBucket{tokens: float64(burst), rate: rate, burst: float64(burst)}
}

// Allow consumes one token if available at the given instant.
func (b *TokenBucket) Allow(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.last.IsZero() {
		b.tokens += now.Sub(b.last).Seconds() * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// IPLimiter applies a per-IP connection token bucket (§9.1 hardening).
type IPLimiter struct {
	mu      sync.Mutex
	buckets map[string]*ipBucket
	rate    float64
	burst   int
}

type ipBucket struct {
	bucket   *TokenBucket
	lastSeen time.Time
}

func NewIPLimiter(rate float64, burst int) *IPLimiter {
	return &IPLimiter{buckets: make(map[string]*ipBucket), rate: rate, burst: burst}
}

// Allow checks the bucket for ip, creating it on first sight. Idle buckets are
// swept opportunistically to bound memory.
func (l *IPLimiter) Allow(ip string, now time.Time) bool {
	l.mu.Lock()
	b, ok := l.buckets[ip]
	if !ok {
		b = &ipBucket{bucket: NewTokenBucket(l.rate, l.burst)}
		l.buckets[ip] = b
	}
	b.lastSeen = now
	if len(l.buckets) > 1024 {
		for k, v := range l.buckets {
			if now.Sub(v.lastSeen) > 10*time.Minute {
				delete(l.buckets, k)
			}
		}
	}
	l.mu.Unlock()
	return b.bucket.Allow(now)
}
