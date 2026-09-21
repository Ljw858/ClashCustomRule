#!/usr/bin/env bash
# [INPUT]: GitHub Actions Secrets、公共 subconverter 服务与 GitHub Gist API
# [OUTPUT]: 对外更新指定私有 Gist 的完整 Clash Meta 配置
# [POS]: scripts 的容错发布编排器，通过公共 subconverter 跳过失效订阅并保护最后可用的 Gist
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
set -euo pipefail
set +x

: "${SUBSCRIPTION_URLS:?缺少 SUBSCRIPTION_URLS}"
: "${GIST_ID:?缺少 GIST_ID}"
: "${GIST_TOKEN:?缺少 GIST_TOKEN}"
: "${SUBCONVERTER_URL:=}"
: "${SUBSCRIPTION_USER_AGENT:=clash-verge/v2.0}"
: "${GIST_FILENAME:=clash-meta.yaml}"
: "${GITHUB_REPOSITORY:=chinnsenn/ClashCustomRule}"
: "${GITHUB_SHA:=master}"
: "${SUBCONVERTER_RETRY_DELAY:=2}"

case "$SUBCONVERTER_RETRY_DELAY" in
  *[!0-9]*|'') printf '%s\n' 'SUBCONVERTER_RETRY_DELAY 必须是非负整数秒数' >&2; exit 1 ;;
esac

workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT

redact() {
  sed -E \
    -e 's#https?://[^[:space:]"'"'"'<>]+#<已隐藏的订阅地址>#g' \
    -e 's#(token|key|secret|password|authorization)=?[^[:space:]&]+#\1=<已隐藏>#Ig'
}

show_converter_diagnostics() {
  local response="$1"
  if [ -s "$response" ]; then
    printf '%s' '公共转换器响应（已脱敏）：' >&2
    head -c 2048 "$response" | tr '\n' ' ' | redact >&2
    printf '\n' >&2
  fi
}

request_converter() {
  local output="$1"
  shift
  curl --silent --show-error --get \
    --connect-timeout 10 \
    --max-time 180 \
    --output "$output" \
    --write-out '%{http_code}' \
    "$@" \
    "$subconverter_endpoint" || true
}

request_subscription() {
  local output="$1"
  local subscription_url="$2"
  curl --silent --show-error --location \
    --connect-timeout 10 \
    --max-time 180 \
    --user-agent "$SUBSCRIPTION_USER_AGENT" \
    --output "$output" \
    --write-out '%{http_code}' \
    "$subscription_url" || true
}

has_proxies() {
  grep -Eq '^[[:space:]]*proxies:[[:space:]]*$' "$1"
}

has_full_config() {
  python3 - "$1" <<'PY'
import sys
import re
from pathlib import Path
import yaml

raw = Path(sys.argv[1]).read_bytes()
try:
    text = raw.decode("utf-8")
except UnicodeDecodeError as error:
    if error.end == len(raw) and error.reason == "unexpected end of data":
        text = raw[:error.start].decode("utf-8")
    else:
        text = raw.decode("utf-8", errors="ignore")
try:
    data = yaml.safe_load(text)
except yaml.YAMLError:
    data = None
if not isinstance(data, dict):
    required = ("proxies", "proxy-groups", "rules")
    raise SystemExit(0 if all(re.search(rf'(?m)^{re.escape(key)}:\s*$', text) for key in required) else 1)
required = ("proxies", "proxy-groups", "rules")
raise SystemExit(0 if all(data.get(key) for key in required) else 1)
PY
}

printf '%s\n' "$SUBSCRIPTION_URLS" | while IFS= read -r url; do
  [ -z "$url" ] || case "$url" in \#*) ;; *) printf '::add-mask::%s\n' "$url" ;; esac
done
printf '::add-mask::%s\n' "$GIST_TOKEN"
[ -n "$SUBCONVERTER_URL" ] && printf '::add-mask::%s\n' "$SUBCONVERTER_URL"

mapfile -t subscriptions < <(printf '%s\n' "$SUBSCRIPTION_URLS" | grep -Ev '^\s*(#|$)' || true)
[ "${#subscriptions[@]}" -gt 0 ] || { printf '%s\n' '没有有效订阅地址' >&2; exit 1; }

output="$workspace/clash-meta.yaml"
used_direct_fetch=0
successful_subscriptions=0
failed_conversions=0
if [ "${#subscriptions[@]}" -eq 1 ]; then
  direct_output="$workspace/direct-native.yaml"
  status="$(request_subscription "$direct_output" "${subscriptions[0]}")"
  if [ "$status" = 200 ] && has_full_config "$direct_output"; then
    cp "$direct_output" "$output"
    used_direct_fetch=1
    successful_subscriptions=1
    printf '%s\n' "订阅直接返回完整 Clash 配置，跳过公共转换器（UA: ${SUBSCRIPTION_USER_AGENT}）"
  fi
fi

if [ "$used_direct_fetch" -ne 1 ]; then
  case "$SUBCONVERTER_URL" in
    http://*|https://*) ;;
    *)
      printf '%s\n' 'SUBCONVERTER_URL 缺失或无效；当订阅不能直接返回完整 Clash 配置时必须提供兼容的 subconverter 地址' >&2
      exit 1
      ;;
  esac
  subconverter_endpoint="${SUBCONVERTER_URL%/}/sub"
  config_url="https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GITHUB_SHA}/config/subconverter.ini"

  status="$(curl --silent --show-error --location --connect-timeout 10 --max-time 30 --output "$workspace/version.txt" --write-out '%{http_code}' "${SUBCONVERTER_URL%/}/version" || true)"
  [ "$status" = 200 ] && grep -qi 'subconverter' "$workspace/version.txt" || {
    printf '%s\n' "公共转换器不是兼容的 subconverter API（HTTP ${status:-000}）" >&2
    show_converter_diagnostics "$workspace/version.txt"
    exit 1
  }

  valid_subscriptions=()
  for index in "${!subscriptions[@]}"; do
    conversion_output="$workspace/conversion-$index.yaml"
    converted=0
    status=000
    for attempt in 1 2 3; do
      status="$(request_converter "$conversion_output" \
        --data-urlencode 'target=clash' \
        --data-urlencode "url=${subscriptions[$index]}")"
      if [ "$status" = 200 ] && has_proxies "$conversion_output"; then
        converted=1
        break
      fi
      if [ "$attempt" -lt 3 ]; then
        printf '%s\n' "订阅 $((index + 1)) 转换未通过，${SUBCONVERTER_RETRY_DELAY} 秒后进行第 $((attempt + 1))/3 次重试" >&2
        sleep "$SUBCONVERTER_RETRY_DELAY"
      fi
    done
    if [ "$converted" -ne 1 ]; then
      failed_conversions=$((failed_conversions + 1))
      printf '%s\n' "订阅 $((index + 1)) 转换失败（HTTP ${status:-000}）" >&2
      show_converter_diagnostics "$conversion_output"
    else
      successful_subscriptions=$((successful_subscriptions + 1))
      valid_subscriptions+=("${subscriptions[$index]}")
    fi
  done
  printf '%s\n' "订阅预检：${successful_subscriptions}/${#subscriptions[@]} 个来源可转换"
  [ "$successful_subscriptions" -gt 0 ] || {
    printf '%s\n' '没有可转换的订阅，保留现有 Gist，不执行发布' >&2
    exit 1
  }
  if [ "$failed_conversions" -gt 0 ]; then
    printf '%s\n' "将跳过 ${failed_conversions} 个转换失败订阅并发布其余来源"
  fi

  joined_urls="$(IFS='|'; printf '%s' "${valid_subscriptions[*]}")"
  printf '%s\n' '开始聚合可用订阅来源'
  status="$(request_converter "$output" \
    --data-urlencode 'target=clash' \
    --data-urlencode "url=$joined_urls" \
    --data-urlencode "config=$config_url")"
  [ "$status" = 200 ] || {
    printf '%s\n' "聚合转换失败（HTTP ${status:-000}）" >&2
    show_converter_diagnostics "$output"
    exit 1
  }
fi

printf '%s\n' '开始校验最终配置'
python3 - "$workspace/clash-meta.yaml" <<'PY'
import sys
from pathlib import Path
try:
    import yaml
except ImportError as error:
    raise SystemExit(f"缺少 PyYAML: {error}")
output_path = Path(sys.argv[1])
raw_content = output_path.read_bytes()
try:
    content = raw_content.decode("utf-8")
except UnicodeDecodeError as error:
    if error.end == len(raw_content) and error.reason == "unexpected end of data":
        content = raw_content[:error.start].decode("utf-8")
        print(f"转换器响应末尾含 {len(raw_content) - error.start} 个不完整 UTF-8 字节，已剔除后继续校验")
    else:
        raise SystemExit(f"转换器输出不是有效 UTF-8：{error}")
    output_path.write_text(content, encoding="utf-8")
if len(content) < 512 or content.lstrip().lower().startswith(("<html", "<!doctype")):
    raise SystemExit("转换器返回的配置无效")
try:
    data = yaml.safe_load(content)
except yaml.YAMLError as error:
    raise SystemExit(f"转换器输出不是有效 YAML：{error}")
if not isinstance(data, dict):
    raise SystemExit("转换器输出不是 YAML 映射")
for key in ("proxies", "proxy-groups", "rules"):
    if not data.get(key):
        raise SystemExit(f"转换器输出缺少 {key}")
print(f"已验证配置：{len(data['proxies'])} 个节点，{len(data['proxy-groups'])} 个策略组，{len(data['rules'])} 条规则")
PY

current="$workspace/current.json"
printf '%s\n' '开始读取当前 Gist 内容'
status="$(curl --silent --show-error --output "$current" --write-out '%{http_code}' \
  -H "Authorization: Bearer $GIST_TOKEN" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/gists/$GIST_ID")"
[ "$status" = 200 ] || { printf '%s\n' "读取 Gist 失败（HTTP $status）" >&2; exit 1; }

result=0
python3 - "$current" "$workspace/clash-meta.yaml" "$GIST_FILENAME" "$workspace/request.json" <<'PY' || result=$?
import json, sys
from pathlib import Path
current, config, request = map(Path, (sys.argv[1], sys.argv[2], sys.argv[4]))
name = sys.argv[3]
old = json.loads(current.read_text()).get("files", {}).get(name, {}).get("content", "")
new = config.read_text(encoding="utf-8")
if old == new:
    raise SystemExit(10)
request.write_text(json.dumps({"files": {name: {"content": new}}}, ensure_ascii=False), encoding="utf-8")
PY
if [ "$result" = 10 ]; then
  printf '%s\n' '节点与配置保持一致，跳过 Gist 更新'
  exit 0
fi
[ "$result" = 0 ] || exit "$result"

printf '%s\n' '开始更新 Gist'
status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  -X PATCH -H "Authorization: Bearer $GIST_TOKEN" -H 'Accept: application/vnd.github+json' \
  -H 'Content-Type: application/json' --data-binary "@$workspace/request.json" \
  "https://api.github.com/gists/$GIST_ID")"
[ "$status" = 200 ] || { printf '%s\n' "更新 Gist 失败（HTTP $status）" >&2; exit 1; }
printf '%s\n' "已更新 Gist 文件：${GIST_FILENAME}（${successful_subscriptions}/${#subscriptions[@]} 个订阅来源可用，已跳过 ${failed_conversions} 个）"
