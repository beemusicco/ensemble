#!/usr/bin/env bash
# Shared runtime paths for collab infrastructure.

collab_runtime_dir() {
  local team_id="${1:?team id required}"
  printf '/tmp/ensemble/%s\n' "$team_id"
}

collab_messages_file() {
  local team_id="${1:?team id required}"
  printf '%s/messages.jsonl\n' "$(collab_runtime_dir "$team_id")"
}

collab_summary_file() {
  local team_id="${1:?team id required}"
  printf '%s/summary.txt\n' "$(collab_runtime_dir "$team_id")"
}

collab_bridge_pid() {
  local team_id="${1:?team id required}"
  printf '%s/bridge.pid\n' "$(collab_runtime_dir "$team_id")"
}

collab_bridge_log() {
  local team_id="${1:?team id required}"
  printf '%s/bridge.log\n' "$(collab_runtime_dir "$team_id")"
}

collab_poller_pid() {
  local team_id="${1:?team id required}"
  printf '%s/poller.pid\n' "$(collab_runtime_dir "$team_id")"
}

collab_feed_file() {
  local team_id="${1:?team id required}"
  printf '%s/feed.txt\n' "$(collab_runtime_dir "$team_id")"
}

collab_prompt_file() {
  local team_id="${1:?team id required}"
  local agent_name="${2:?agent name required}"
  printf '%s/prompts/%s.txt\n' "$(collab_runtime_dir "$team_id")" "$agent_name"
}

collab_delivery_file() {
  local team_id="${1:?team id required}"
  local session_name="${2:?session name required}"
  printf '%s/delivery/%s.txt\n' "$(collab_runtime_dir "$team_id")" "$session_name"
}

collab_bridge_posted_file() {
  local team_id="${1:?team id required}"
  printf '%s/bridge-posted\n' "$(collab_runtime_dir "$team_id")"
}

collab_bridge_result_file() {
  local team_id="${1:?team id required}"
  printf '%s/bridge-result\n' "$(collab_runtime_dir "$team_id")"
}

collab_team_id_file() {
  local team_id="${1:?team id required}"
  printf '%s/team-id\n' "$(collab_runtime_dir "$team_id")"
}

collab_finished_marker() {
  local team_id="${1:?team id required}"
  printf '%s/.finished\n' "$(collab_runtime_dir "$team_id")"
}
