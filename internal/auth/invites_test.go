package auth

import (
	"bytes"
	"regexp"
	"testing"
)

func TestInviteCode(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		c, err := generateInviteCode()
		if err != nil {
			t.Fatal(err)
		}
		if !regexp.MustCompile(`^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$`).MatchString(c) {
			t.Fatalf("code %q: wrong format or look-alike characters", c)
		}
		seen[c] = true
	}
	if len(seen) < 200 {
		t.Error("codes repeat")
	}
	// typed by a person: case, spaces and the dash do not matter
	if !bytes.Equal(inviteHash("K7Q2M-9XPRT"), inviteHash(" k7q2m 9xprt ")) || bytes.Equal(inviteHash("K7Q2M-9XPRT"), inviteHash("K7Q2M-9XPRS")) {
		t.Error("code normalisation")
	}
}
