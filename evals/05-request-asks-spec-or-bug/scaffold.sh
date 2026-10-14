#!/usr/bin/env bash
# Builds the workspace this case starts from (see ../_fixtures/workspace.py).
set -euo pipefail
python3 "$(dirname "$0")/../_fixtures/workspace.py" --cr cents --stage none
