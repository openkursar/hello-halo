package room

import (
	"sync"

	"github.com/openkursar/hello-halo/gateway/internal/metrics"
	"github.com/openkursar/hello-halo/gateway/internal/wire"
)

// Per-plane outbound queue capacities, generated from the shared plane list.
var planeCapacity = wire.PlaneCapacityFrames

// PlaneQueue is the per-downstream-session outbound queue: one queue per plane,
// drained in strict plane order, dropping the oldest frame within a plane when
// it exceeds its frame count or byte budget. Overflow in one plane can never
// crowd out another.
type PlaneQueue struct {
	mu      sync.Mutex
	cond    *sync.Cond
	queues  [wire.PlaneCount][][]byte
	bytes   [wire.PlaneCount]int
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
	budget := wire.PlaneCapacityBytes[plane]
	for len(buf) > 0 && (len(buf) >= planeCapacity[plane] || (budget > 0 && q.bytes[plane]+len(data) > budget)) {
		q.bytes[plane] -= len(buf[0])
		copy(buf, buf[1:])
		buf = buf[:len(buf)-1]
		q.metrics.FramesDroppedTotal[plane].Add(1)
	}
	q.bytes[plane] += len(data)
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
				q.bytes[p] -= len(data)
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
		q.bytes[p] = 0
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
