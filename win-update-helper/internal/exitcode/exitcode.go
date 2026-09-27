// Package exitcode carries a failure class from wherever it is detected up to
// main, so the Electron side can react to a specific outcome instead of
// parsing log text.
package exitcode

import "errors"

const (
	OK               = 0
	Usage            = 1
	BadHash          = 2
	StageFailed      = 3
	StagedIncomplete = 4
	AppStillRunning  = 5
	SwapReversed     = 6
	SwapNotReversed  = 7
	ConfirmTimeout   = 8
	RollbackFailed   = 9
)

type Error struct {
	Code int
	Err  error
}

func (e *Error) Error() string { return e.Err.Error() }

func (e *Error) Unwrap() error { return e.Err }

func Wrap(code int, err error) error {
	if err == nil {
		return nil
	}
	return &Error{Code: code, Err: err}
}

// Of reports the class of err, defaulting to Usage for anything unclassified.
func Of(err error) int {
	if err == nil {
		return OK
	}
	var coded *Error
	if errors.As(err, &coded) {
		return coded.Code
	}
	return Usage
}
