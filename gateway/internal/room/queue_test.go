package room

import (
	"fmt"
	"testing"
	"time"

	"github.com/openkursar/hello-halo/gateway/internal/metrics"
	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

func TestQueueStrictPriorityDrain(t *testing.T) {
	q := NewPlaneQueue(nil)
	q.Push(wire.PlaneArtifact, []byte("a1"))
	q.Push(wire.PlaneStream, []byte("s1"))
	q.Push(wire.PlaneControl, []byte("c1"))
	q.Push(wire.PlaneStream, []byte("s2"))
	q.Push(wire.PlaneControl, []byte("c2"))

	want := []string{"c1", "c2", "s1", "s2", "a1"}
	for _, w := range want {
		data, ok := q.Pop()
		if !ok || string(data) != w {
			t.Fatalf("got %q ok=%v, want %q", data, ok, w)
		}
	}
}

func TestQueueDropOldestWithinPlane(t *testing.T) {
	m := metrics.New()
	q := NewPlaneQueue(m)
	for i := 0; i < planeCapacity[wire.PlaneArtifact]+3; i++ {
		q.Push(wire.PlaneArtifact, []byte(fmt.Sprintf("a%d", i)))
	}
	if got := q.Len(wire.PlaneArtifact); got != planeCapacity[wire.PlaneArtifact] {
		t.Fatalf("artifact plane len = %d, want %d", got, planeCapacity[wire.PlaneArtifact])
	}
	if drops := m.FramesDroppedTotal[wire.PlaneArtifact].Load(); drops != 3 {
		t.Fatalf("dropped = %d, want 3", drops)
	}
	// The oldest three frames were discarded; a3 is now the head.
	data, _ := q.Pop()
	if string(data) != "a3" {
		t.Fatalf("head = %q, want a3", data)
	}
}

func TestQueueOverflowDoesNotCrowdOutOtherPlanes(t *testing.T) {
	m := metrics.New()
	q := NewPlaneQueue(m)
	q.Push(wire.PlaneControl, []byte("c1"))
	q.Push(wire.PlaneStream, []byte("s1"))
	for i := 0; i < planeCapacity[wire.PlaneArtifact]*4; i++ {
		q.Push(wire.PlaneArtifact, []byte("a"))
	}
	if q.Len(wire.PlaneControl) != 1 || q.Len(wire.PlaneStream) != 1 {
		t.Fatal("artifact overflow displaced frames from other planes")
	}
	if m.FramesDroppedTotal[wire.PlaneControl].Load() != 0 || m.FramesDroppedTotal[wire.PlaneStream].Load() != 0 {
		t.Fatal("drops were charged to the wrong plane")
	}
}

func TestQueuePopBlocksUntilPushAndClose(t *testing.T) {
	q := NewPlaneQueue(nil)
	got := make(chan []byte, 1)
	go func() {
		data, ok := q.Pop()
		if ok {
			got <- data
		}
		close(got)
	}()
	time.Sleep(20 * time.Millisecond)
	q.Push(wire.PlaneControl, []byte("x"))
	select {
	case data := <-got:
		if string(data) != "x" {
			t.Fatalf("got %q", data)
		}
	case <-time.After(time.Second):
		t.Fatal("Pop did not wake on Push")
	}

	done := make(chan struct{})
	go func() {
		if _, ok := q.Pop(); ok {
			t.Error("Pop returned data after close")
		}
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	q.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Pop did not wake on Close")
	}
	if q.Push(wire.PlaneControl, []byte("y")) {
		t.Fatal("Push accepted after Close")
	}
}

func TestFeedPlaneByteBudgetDropsOldestFeedOnly(t *testing.T) {
	m := metrics.New()
	q := NewPlaneQueue(m)
	q.Push(wire.PlaneControl, []byte("c1"))
	big := make([]byte, wire.PlaneCapacityBytes[wire.PlaneFeed]/2+1)
	q.Push(wire.PlaneFeed, big)
	q.Push(wire.PlaneFeed, big) // over the byte budget: the first feed frame goes
	if got := q.Len(wire.PlaneFeed); got != 1 {
		t.Fatalf("feed plane len = %d, want 1", got)
	}
	if got := q.Len(wire.PlaneControl); got != 1 {
		t.Fatalf("control plane len = %d, want 1", got)
	}
	if drops := m.FramesDroppedTotal[wire.PlaneFeed].Load(); drops != 1 {
		t.Fatalf("feed drops = %d, want 1", drops)
	}
	// Drains control first, then feed; byte accounting returns to zero.
	if d, _ := q.Pop(); string(d) != "c1" {
		t.Fatalf("first pop = %q, want c1", d)
	}
	q.Pop()
	q.Push(wire.PlaneFeed, big)
	q.Push(wire.PlaneFeed, []byte("small"))
	if got := q.Len(wire.PlaneFeed); got != 2 {
		t.Fatalf("feed plane len after drain = %d, want 2", got)
	}
}

func TestResolvePlaneUsesKnownHintElseKind(t *testing.T) {
	if p := wire.ResolvePlane("feed", "feed-entries"); p != wire.PlaneFeed {
		t.Fatalf("hinted feed = %v", p)
	}
	if p := wire.ResolvePlane("", "feed-entries"); p != wire.PlaneControl {
		t.Fatalf("unhinted feed-entries = %v, want control", p)
	}
	if p := wire.ResolvePlane("bogus", "stream-frames"); p != wire.PlaneStream {
		t.Fatalf("unknown hint = %v, want stream by kind", p)
	}
}
