#!/usr/bin/env bash
# 只读区健壮性验证：验证「未消费请求体导致 isolate 崩溃」修复 + /backup/ 子路径 PROPFIND
# 用法: bash probe-readonly.sh [base]
BASE="${1:-http://127.0.0.1:8787}"
DAV_USER="${DAV_USER:-book}"
DAV_PASS="${DAV_PASS:-test-dav-456}"
export no_proxy='127.0.0.1,localhost' NO_PROXY='127.0.0.1,localhost'
C="curl -s --max-time 15 -u $DAV_USER:$DAV_PASS"
pass=0; fail=0
check() { # name expect actual
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "ok   $1 ($3)";
  else fail=$((fail+1)); echo "FAIL $1 expect=$2 got=$3"; fi
}

# 1) 基线：PROPFIND 根应 207
check "PROPFIND 根 207" 207 "$($C -o /dev/null -w '%{http_code}' -X PROPFIND -H 'Depth: 1' "$BASE/")"

# 2) PUT 带 body 到只读区 → 405（此前会崩 isolate）；64KB+ 大 body 用临时文件传
head -c 65536 /dev/zero | tr '\0' 'a' > probe-bigbody.tmp
check "PUT(带body) 405" 405 "$($C -o /dev/null -w '%{http_code}' -X PUT --data-binary @probe-bigbody.tmp "$BASE/books/anycat/x.txt" 2>/dev/null)"
rm -f probe-bigbody.tmp

# 3) 关键存活验证：崩溃修复后，上述写请求之后 worker 必须仍然响应
check "写请求后仍存活 207" 207 "$($C -o /dev/null -w '%{http_code}' -X PROPFIND -H 'Depth: 1' "$BASE/")"

# 4) MKCOL / DELETE 405
check "MKCOL 405" 405 "$($C -o /dev/null -w '%{http_code}' -X MKCOL "$BASE/books/anycat/")"
check "DELETE 405" 405 "$($C -o /dev/null -w '%{http_code}' -X DELETE "$BASE/books/anycat/x.txt")"

# 5) /backup/ 子目录 PROPFIND：先放两个文件（根+子目录），再列子目录应只返回子目录内容
$C -o /dev/null -X PUT --data-binary 'rootfile' "$BASE/backup/probe-root.txt" >/dev/null
$C -o /dev/null -X PUT --data-binary 'subfile' "$BASE/backup/anx/probe-sub.txt" >/dev/null
SUB=$( $C -X PROPFIND -H 'Depth: 1' "$BASE/backup/anx" | tr -d '\n' | sed 's/></>\n</g' | grep -c 'probe-sub.txt' )
check "子目录列表含 probe-sub.txt" 2 "$SUB"
ROOTIN=$( $C -X PROPFIND -H 'Depth: 1' "$BASE/backup/anx" | tr -d '\n' | sed 's/></>\n</g' | grep -c 'probe-root.txt' )
check "子目录列表不含根文件" 0 "$ROOTIN"

# 6) 清理探针
$C -o /dev/null -X DELETE "$BASE/backup/probe-root.txt" >/dev/null
$C -o /dev/null -X DELETE "$BASE/backup/anx/probe-sub.txt" >/dev/null

# 7) 终态存活
check "终态存活 207" 207 "$($C -o /dev/null -w '%{http_code}' -X PROPFIND -H 'Depth: 1' "$BASE/")"

echo "----"
echo "pass=$pass fail=$fail"
[ "$fail" = "0" ]
