#!/usr/bin/env bash
# 只测 /backup/ 可写区，验证它能否当 Anx Reader 的同步后端
export no_proxy='127.0.0.1,localhost,::1'
BASE="${BASE:-http://127.0.0.1:8787}"
U="${U:-book:test-dav-456}"

hit() {
  local label="$1"; shift
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" 2>/dev/null)
  printf '  %-36s %s\n' "$label" "$code"
}

echo "A) 建目录 + 传文件（Anx 的 testFullCapabilities 流程）"
hit "MKCOL /backup/anx/"              -X MKCOL -u "$U" "$BASE/backup/anx/"
hit "PUT  /backup/anx/test.txt"       -X PUT -u "$U" --data-binary "hello" "$BASE/backup/anx/test.txt"
hit "GET  /backup/anx/test.txt"       -u "$U" "$BASE/backup/anx/test.txt"

echo "B) 目录语义：PROPFIND 是否按请求路径过滤"
hit "PROPFIND /backup/ (根)"          -X PROPFIND -u "$U" -H "Depth: 1" "$BASE/backup/"
echo "  --- /backup/ 根返回的 href ---"
curl -s --max-time 20 -X PROPFIND -u "$U" -H "Depth: 1" "$BASE/backup/" | grep -oE '<D:href>[^<]*</D:href>'
hit "PROPFIND /backup/anx/ (子目录)"  -X PROPFIND -u "$U" -H "Depth: 1" "$BASE/backup/anx/"
echo "  --- /backup/anx/ 返回的 href（若与上面相同=未按路径过滤）---"
curl -s --max-time 20 -X PROPFIND -u "$U" -H "Depth: 1" "$BASE/backup/anx/" | grep -oE '<D:href>[^<]*</D:href>'
hit "PROPFIND /backup/nothing/ (不存在)" -X PROPFIND -u "$U" -H "Depth: 1" "$BASE/backup/nothing/"

echo "C) 清理"
hit "DELETE /backup/anx/test.txt"     -X DELETE -u "$U" "$BASE/backup/anx/test.txt"
