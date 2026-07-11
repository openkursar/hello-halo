package room

import (
	"sync"

	"github.com/openkursar/hello-halo/gateway/internal/metrics"
	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

// Per-plane outbound queue capacities (§5.3).
var planeCapacity = [wire.PlaneCount]int{
	wire.PlaneControl:  1024,
	wire.PlaneStream:   256,
	wire.PlaneArtifact: 32,
}

// PlaneQueue is the per-downstream-session outbound queue: three planes
// drained in strict control -> stream -> artifact priority, dropping the
// oldest frame within a plane on overflow. Overflow in one plane can never
// crowd out another.
type PlaneQueue struct {
	mu      sync.Mutex
	cond    *sync.Cond
	queues  [wire.PlaneCount][][]byte
	closed  bool
	metrics *metrics.Metrics
}

func NewPlaneQueue(m *metrics.Metrics) *PlaneQueue {
	if m == nil {
		m = metrics.New()
	}
	q := &PlaneQueue{metrics: m}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// Push enqueues data on the given plane. On overflow the oldest frame of the
// SAME plane is dropped. Returns false when data itself was not accepted
// (closed queue); a drop of an older frame still returns true.
func (q *PlaneQueue) Push(plane wire.Plane, data []byte) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return false
	}
	buf := q.queues[plane]
	if len(buf) >= planeCapacity[plane] {
		copy(buf, buf[1:])
		buf = buf[:len(buf)-1]
		q.metrics.FramesDroppedTotal[plane].Add(1)
	}
	q.queues[plane] = append(buf, data)
	q.cond.Signal()
	return true
}

// Pop blocks until a frame is available (highest-priority plane first) or the
// queue is closed. Returns ok=false only after close with all planes drained
// or discarded.
func (q *PlaneQueue) Pop() ([]byte, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for {
		for p := wire.PlaneControl; p < wire.PlaneCount; p++ {
			if buf := q.queues[p]; len(buf) > 0 {
				data := buf[0]
				q.queues[p] = buf[1:]
				return data, true
			}
		}
		if q.closed {
			return nil, false
		}
		q.cond.Wait()
	}
}

// Close wakes any blocked Pop and rejects further pushes. Frames still queued
// are discarded (the connection is going away).
func (q *PlaneQueue) Close() {
	q.mu.Lock()
	q.closed = true
	for p := range q.queues {
		q.queues[p] = nil
	}
	q.mu.Unlock()
	q.cond.Broadcast()
}

// Len reports queued frames per plane (test/diagnostic helper).
func (q *PlaneQueue) Len(plane wire.Plane) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.queues[plane])
}
