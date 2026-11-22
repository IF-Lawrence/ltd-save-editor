#!/bin/zsh
set -eu
cd -- "${0:A:h}"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v python3 >/dev/null; then
  print -u2 'Python 3 is required to start the local editor.'
  exit 1
fi

exec python3 local_server.py "$@"
