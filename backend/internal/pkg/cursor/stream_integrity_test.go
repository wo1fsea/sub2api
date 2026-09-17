package cursor

import (
	"bytes"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConsumeAssistantStreamRejectsTruncatedFrame(t *testing.T) {
	frame := encodeAgentTurnEndedFrame(t)
	for _, length := range []int{1, 4, 5, len(frame) - 1} {
		_, streamErr := ConsumeAssistantStream(bytes.NewReader(frame[:length]), nil)
		require.NotEmpty(t, streamErr, "a frame truncated at byte %d must not look successful", length)
	}
}

func TestConsumeAssistantStreamPropagatesConsumerFailure(t *testing.T) {
	frame := encodeAgentExecToolCallFrame(t, 1, "call-1", "tool", `{}`)
	_, streamErr := ConsumeAssistantStream(bytes.NewReader(frame), func(StreamEvent) error {
		return errors.New("downstream write failed")
	})
	require.NotEmpty(t, streamErr)
}
