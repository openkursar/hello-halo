package session

import (
	"testing"
	"time"
)

func TestTokenBucketBurstAndRefill(t *testing.T) {
	now := time.Now()
	b := NewTokenBucket(10, 20)

	for i := 0; i < 20; i++ {
		if !b.Allow(now) {
			t.Fatalf("burst request %d denied", i)
		}
	}
	if b.Allow(now) {
		t.Fatal("request beyond burst allowed")
	}

	// 500ms at 10/s refills 5 tokens.
	now = now.Add(500 * time.Millisecond)
	for i := 0; i < 5; i++ {
		if !b.Allow(now) {
			t.Fatalf("refilled request %d denied", i)
		}
	}
	if b.Allow(now) {
		t.Fatal("request beyond refill allowed")
	}
}

func TestTokenBucketCapsAtBurst(t *testing.T) {
	now := time.Now()
	b := NewTokenBucket(10, 20)
	if !b.Allow(now) {
		t.Fatal("first request denied")
	}
	// A long idle period must not accumulate more than burst.
	now = now.Add(time.Hour)
	granted := 0
	for b.Allow(now) {
		granted++
	}
	if granted != 20 {
		t.Fatalf("granted %d after idle, want burst cap 20", granted)
	}
}

func TestIPLimiterIsolatesIPs(t *testing.T) {
	now := time.Now()
	l := NewIPLimiter(10, 2)
	if !l.Allow("10.0.0.1", now) || !l.Allow("10.0.0.1", now) {
		t.Fatal("first IP denied within burst")
	}
	if l.Allow("10.0.0.1", now) {
		t.Fatal("first IP allowed beyond burst")
	}
	if !l.Allow("10.0.0.2", now) {
		t.Fatal("second IP throttled by first IP's bucket")
	}
}
