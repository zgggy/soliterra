#!/usr/bin/env bash
# Soliterra 服务器启停脚本（同时最多只允许一个实例）
#   ./soliterra.sh 4747    在指定端口启动服务器
#   ./soliterra.sh stop    关闭服务器
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$ROOT/src"
PID_FILE="$ROOT/.server.pid"
LOG_FILE="$ROOT/server.log"

usage() {
  {
    echo "用法：$0 <端口>   在指定端口启动服务器（仅允许一个实例）"
    echo "       $0 stop    关闭服务器"
  } >&2
  exit 2
}

# 当前由本脚本/已知方式启动的服务器 pid（pid 文件优先，回退 pgrep）
running_pid() {
  local pid=""
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      echo "${pid}"
      return 0
    fi
  fi
  pid="$(pgrep -f "node server.js" | head -n1 || true)"
  echo "${pid}"
}

# 该 pid 正在监听的端口（无监听输出空）
port_of_pid() {
  local pid="$1"
  lsof -nP -a -p "${pid}" -iTCP -sTCP:LISTEN 2>/dev/null \
    | awk 'NR>1 {n=split($9, a, ":"); print a[n]; exit}' || true
}

stop_server() {
  local pid
  pid="$(running_pid)"
  if [ -z "${pid}" ]; then
    echo "服务器未在运行。"
    rm -f "${PID_FILE}"
    return 0
  fi
  kill "${pid}" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    if ! kill -0 "${pid}" 2>/dev/null; then break; fi
    sleep 0.2
  done
  if kill -0 "${pid}" 2>/dev/null; then
    kill -9 "${pid}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
  echo "已关闭服务器（pid ${pid}）。"
}

start_server() {
  local port="$1"
  local pid cur_port
  pid="$(running_pid)"
  if [ -n "${pid}" ]; then
    cur_port="$(port_of_pid "${pid}")"
    if [ "${cur_port}" = "${port}" ]; then
      echo "服务器已在运行（pid ${pid}，端口 ${port}）：http://127.0.0.1:${port}"
      return 0
    fi
    echo "已有实例在运行（pid ${pid}${cur_port:+，端口 ${cur_port}}），先关闭再切换到端口 ${port}……"
    stop_server
  fi

  if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "端口 ${port} 已被其他进程占用，无法启动。" >&2
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >&2 || true
    return 1
  fi

  (cd "${APP_DIR}" && PORT="${port}" nohup node server.js >>"${LOG_FILE}" 2>&1 & echo $! >"${PID_FILE}")
  sleep 1
  pid="$(running_pid)"
  if [ -n "${pid}" ] && [ "$(port_of_pid "${pid}")" = "${port}" ]; then
    echo "已启动（pid ${pid}，端口 ${port}）：http://127.0.0.1:${port}"
    echo "日志：${LOG_FILE}"
  else
    echo "启动可能失败，请查看日志：${LOG_FILE}" >&2
    tail -n 20 "${LOG_FILE}" >&2 || true
    rm -f "${PID_FILE}"
    return 1
  fi
}

ARG="${1:-}"
case "${ARG}" in
  "")
    usage
    ;;
  stop)
    stop_server
    ;;
  *)
    if ! [[ "${ARG}" =~ ^[0-9]+$ ]] || [ "${ARG}" -lt 1 ] || [ "${ARG}" -gt 65535 ]; then
      echo "参数必须是 1–65535 的端口号，或 stop。" >&2
      usage
    fi
    start_server "${ARG}"
    ;;
esac
