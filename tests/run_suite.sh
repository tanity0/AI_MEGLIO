#!/usr/bin/env bash
# tests/run_suite.sh — テストハーネス（README 代わりのコメント）
#
# 使い方:
#   tests/run_suite.sh                 # tests/test*.mjs をすべて実行
#   tests/run_suite.sh test52 test30_studio   # 指定スイートのみ（拡張子なし）
#
# 動作:
#   各スイートごとに (1) 未使用ポート（3810番台から探索）で `MOCK=1 PORT=<port> node server.js` を起動
#   (2) `timeout 300 node tests/<suite>.mjs <port>` を実行 (3) 起動したサーバーの PID だけを kill する
#   （pkill/killall は使わない＝他プロセスに影響しない）。終了コードは全スイートPASSなら 0。
#
# 前提・規約:
#   - playwright はグローバルに導入済み（require('playwright') が通る）。`playwright install` は実行しない。
#   - サーバー依存は `npm install` で入れる（node_modules は .gitignore 済み・コミットしない）。
#   - テストは tests/lib.mjs の launch() を使う。ブラウザの confirm() ダイアログは自動承認される。
#   - 自動調整（§52）の既定は ON。決定的に検証したいテストは launch({ autoTune: false }) で OFF にする。
#   - 新しいスイートは tests/test<名前>.mjs として追加するだけでよい（第1引数 = ポート）。
set -u
cd "$(dirname "$0")/.."

[ -d node_modules ] || npm install --no-audit --no-fund >/dev/null 2>&1

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
next_port() {
  local p=${NEXT_PORT:-3810}
  while ! port_free "$p"; do p=$((p + 1)); done
  NEXT_PORT=$((p + 1))
  echo "$p"
}

if [ $# -gt 0 ]; then suites=("$@"); else suites=($(cd tests && ls test*.mjs | sed 's/\.mjs$//')); fi

overall=0
for s in "${suites[@]}"; do
  port=$(next_port)
  MOCK=1 PORT="$port" node server.js >"/tmp/ai_meglio_suite_${port}.log" 2>&1 &
  spid=$!
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$port/" >/dev/null 2>&1 && break
    sleep 0.2
  done
  echo "=== $s (port $port) ==="
  timeout 300 node "tests/$s.mjs" "$port"
  rc=$?
  kill "$spid" 2>/dev/null
  wait "$spid" 2>/dev/null
  if [ $rc -eq 0 ]; then echo "SUITE-PASS $s"; else echo "SUITE-FAIL $s (rc=$rc)"; overall=1; fi
done
exit $overall
