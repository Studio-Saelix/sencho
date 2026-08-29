#!/usr/bin/env bash
# Release loopback port 22 so SSH fixture integration tests can bind a test sshd.
# GitHub-hosted runners often have ssh.socket socket-activation that restarts sshd
# after a plain systemctl stop; mask + kill listeners before verifying the port.
set -euo pipefail

PORT="${1:-22}"

stop_systemd_ssh() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  for unit in ssh.socket ssh.service ssh; do
    sudo systemctl stop "$unit" 2>/dev/null || true
    sudo systemctl disable "$unit" 2>/dev/null || true
    sudo systemctl mask "$unit" 2>/dev/null || true
  done
}

stop_sysv_ssh() {
  if command -v service >/dev/null 2>&1; then
    sudo service ssh stop 2>/dev/null || true
  fi
}

kill_port_listeners() {
  if command -v fuser >/dev/null 2>&1; then
    sudo fuser -k "${PORT}/tcp" 2>/dev/null || true
  fi
  if command -v lsof >/dev/null 2>&1; then
    mapfile -t pids < <(sudo lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)
    if ((${#pids[@]} > 0)); then
      sudo kill -TERM "${pids[@]}" 2>/dev/null || true
      sleep 0.5
      sudo kill -KILL "${pids[@]}" 2>/dev/null || true
    fi
  fi
}

assert_port_free() {
  python3 - <<PY
import socket
import sys

port = int("${PORT}")
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(("127.0.0.1", port))
finally:
    sock.close()
print(f"loopback port {port} is free")
PY
}

stop_systemd_ssh
stop_sysv_ssh
kill_port_listeners
sleep 0.5
kill_port_listeners
assert_port_free
