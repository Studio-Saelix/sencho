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

allow_unprivileged_sshd_bind() {
  if [[ -x /usr/sbin/sshd ]]; then
    sudo setcap 'cap_net_bind_service=+ep' /usr/sbin/sshd 2>/dev/null || true
  fi
}

assert_port_free() {
  if command -v ss >/dev/null 2>&1; then
    if ss -ltn "sport = :${PORT}" 2>/dev/null | awk 'NR > 1 && /LISTEN/ { found=1 } END { exit !found }'; then
      echo "loopback port ${PORT} still has listeners:" >&2
      ss -ltnp "sport = :${PORT}" >&2 || true
      exit 1
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if sudo lsof -tiTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "loopback port ${PORT} still has listeners:" >&2
      sudo lsof -iTCP:"${PORT}" -sTCP:LISTEN >&2 || true
      exit 1
    fi
  fi
  echo "loopback port ${PORT} has no listeners"
}

stop_systemd_ssh
stop_sysv_ssh
kill_port_listeners
sleep 0.5
kill_port_listeners
allow_unprivileged_sshd_bind
assert_port_free
