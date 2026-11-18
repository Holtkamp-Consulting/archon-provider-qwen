#!/bin/sh
# Wrapper so the provider can exec the fake like the real `qwen` binary.
exec "${FAKE_QWEN_BUN:-bun}" "$(dirname "$0")/fake-qwen.ts" "$@"
