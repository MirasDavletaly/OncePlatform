package workflow

import (
	"slices"

	"onceplatform/internal/apperr"
)

var LossReasons = []string{"price", "competitor", "no_response", "requirements"}

func ValidateLossReason(result CloseResult, reason string) error {
	if result == ResultLost {
		if !slices.Contains(LossReasons, reason) {
			return apperr.New(422, "loss_reason_required", "Closing as lost requires loss_reason: price, competitor, no_response or requirements. Ask for the reason if it is unknown.")
		}
	} else if reason != "" {
		return apperr.Validation("A loss reason can only be set when closing as lost")
	}
	return nil
}
