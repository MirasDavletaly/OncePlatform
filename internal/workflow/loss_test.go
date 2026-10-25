package workflow

import "testing"

func TestLossReason(t *testing.T) {
	for _, reason := range LossReasons {
		if err := ValidateLossReason(ResultLost, reason); err != nil {
			t.Fatal(err)
		}
	}
	for _, reason := range []string{"", "unknown", "other"} {
		if ValidateLossReason(ResultLost, reason) == nil {
			t.Errorf("lost accepted %q", reason)
		}
	}
	for _, result := range []CloseResult{ResultWon, ResultNoBid, ResultCancelled, ""} {
		if ValidateLossReason(result, "price") == nil {
			t.Errorf("%s accepted reason", result)
		}
		if err := ValidateLossReason(result, ""); err != nil {
			t.Fatal(err)
		}
	}
}
