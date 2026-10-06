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

# 该进程的工作目录是否属于本项目（避免 pgrep 误伤别的 node server.js）
is_ours() {
  local pid="$1" cwd
  cwd="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1 || true)"
  [ -n "${cwd}" ] || return 1
  case "${cwd}" in
    "${ROOT}" | "${ROOT}"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# 本项目所有在运行的服务器 pid（pid 文件 + pgrep，均经 is_ours 过滤）
our_pids() {
  local pid out=""
  if [ -f "${PID_FILE}" ]; then
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null && is_ours "${pid}"; then
      out="${pid}"
    fi
  fi
  for pid in $(pgrep -f "node server.js" 2>/dev/null || true); do
    is_ours "${pid}" || continue
    case " ${out} " in
      *" ${pid} "*) ;;
      *) out="${out:+${out} }${pid}" ;;
    esac
  done
  echo "${out}"
}

running_pid() {
  our_pids | awk 'NR==1 {print; exit}'
}

# 指定端口的监听进程 pid（无则空）
port_pid() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true
}

# 该 pid 正在监听的端口（无则空）
port_of_pid() {
  local pid="$1"
  [ -n "${pid}" ] || return 0
  lsof -nP -a -p "${pid}" -iTCP -sTCP:LISTEN 2>/dev/null \
    | awk 'NR>1 {n=split($9, a, ":"); print a[n]; exit}' || true
}

stop_server() {
  local pids pid alive i
  pids="$(our_pids)"
  if [ -z "${pids}" ]; then
    echo "服务器未在运行。"
    rm -f "${PID_FILE}"
    return 0
  fi
  for pid in ${pids}; do
    kill "${pid}" 2>/dev/null || true
  done
  alive="${pids}"
  for i in $(seq 1 20); do
    alive=""
    for pid in ${pids}; do
      kill -0 "${pid}" 2>/dev/null && alive="${alive} ${pid}"
    done
    [ -n "${alive}" ] || break
    sleep 0.2
  done
  for pid in ${alive}; do
    kill -9 "${pid}" 2>/dev/null || true
  done
  rm -f "${PID_FILE}"
  echo "已关闭服务器（pid $(echo "${pids}" | tr ' ' ',')）。"
}

start_server() {
  local port="$1" pid cur_port i
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

  if [ -n "$(port_pid "${port}")" ]; then
    echo "端口 ${port} 已被其他进程占用，无法启动：" >&2
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >&2 || true
    return 1
  fi

  (
    cd "${APP_DIR}" &&
      exec nohup env PORT="${port}" node server.js >>"${LOG_FILE}" 2>&1
  ) &
  # 等待监听就绪（最多 3 秒）
  for i in $(seq 1 15); do
    [ -n "$(port_pid "${port}")" ] && break
    kill -0 "$!" 2>/dev/null || break
    sleep 0.2
  done

  pid="$(port_pid "${port}")"
  if [ -n "${pid}" ]; then
    echo "${pid}" >"${PID_FILE}"
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
