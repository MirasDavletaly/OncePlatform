package auth

import (
	"sync"
	"time"
)

// Limiter is an in-memory sliding-window rate limiter with temporary lockout.
// When a key records max hits within window, it is locked for lockout.
// The portal runs as a single process, so in-memory state is sufficient.
type Limiter struct {
	mu      sync.Mutex
	max     int
	window  time.Duration
	lockout time.Duration
	entries map[string]*limiterEntry
	now     func() time.Time
}

type limiterEntry struct {
	hits        []time.Time
	lockedUntil time.Time
}

// NewLimiter creates a limiter.
func NewLimiter(max int, window, lockout time.Duration) *Limiter {
	return &Limiter{
		max:     max,
		window:  window,
		lockout: lockout,
		entries: map[string]*limiterEntry{},
		now:     time.Now,
	}
}

// Blocked reports whether key is currently locked and for how long.
func (l *Limiter) Blocked(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[key]
	if !ok {
		return false, 0
	}
	now := l.now()
	if now.Before(e.lockedUntil) {
		return true, e.lockedUntil.Sub(now)
	}
	return false, 0
}

// Hit records an event for key and reports whether key is now locked.
func (l *Limiter) Hit(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e, ok := l.entries[key]
	if !ok {
		e = &limiterEntry{}
		l.entries[key] = e
	}
	if now.Before(e.lockedUntil) {
		return true, e.lockedUntil.Sub(now)
	}
	cutoff := now.Add(-l.window)
	kept := e.hits[:0]
	for _, t := range e.hits {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	e.hits = append(kept, now)
	if len(e.hits) >= l.max {
		e.lockedUntil = now.Add(l.lockout)
		e.hits = e.hits[:0]
		return true, l.lockout
	}
	return false, 0
}

// Reset clears the state of key (e.g. after a successful login).
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

// Cleanup drops entries that are neither locked nor have recent hits.
func (l *Limiter) Cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	cutoff := now.Add(-l.window)
	for k, e := range l.entries {
		if now.Before(e.lockedUntil) {
			continue
		}
		recent := false
		for _, t := range e.hits {
			if t.After(cutoff) {
				recent = true
				break
			}
		}
		if !recent {
			delete(l.entries, k)
		}
	}
}
