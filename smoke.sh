#!/usr/bin/env bash
# r2book 冒烟测试：对本地实例跑一遍完整链路。
#
# 用法：
#   bash smoke.sh                                  # 打本地 wrangler dev（默认 8787）
#
# ⚠️ 本脚本会清空目标实例的全部书目与分类。线上实例默认拒绝执行，
#    除非明确设 ALLOW_REMOTE=1（不推荐，生产书库请用重建索引兜底而不是清库）。
#
# 依赖：curl。退出码 0 表示全部通过。

set -u
# 沙箱/公司代理会劫持 127.0.0.1 请求返回 502，本地测试必须绕开
export no_proxy='127.0.0.1,localhost,::1'
export NO_PROXY="$no_proxy"
BASE="${BASE:-http://127.0.0.1:8787}"

# ⚠️ 硬闸门：本脚本第 0 节会【清空全部书和分类】。对线上实例跑必须显式
# 设 ALLOW_REMOTE=1，并且这是你确认要清空的前提下——生产书库别用这个脚本。
case "$BASE" in
  http://127.0.0.1* | http://localhost* | http://[::1]*)
    ;;
  *)
    if [ "${ALLOW_REMOTE:-0}" != "1" ]; then
      echo "❌ 拒绝执行：BASE=$BASE 不是本地实例。" >&2
      echo "   这个脚本会清空目标实例的全部书目与分类（第 0 节状态复位）。" >&2
      echo "   如果确实要跑，设 ALLOW_REMOTE=1，并自行承担清空后果。" >&2
      exit 1
    fi
    ;;
esac

ADMIN_PASS="${ADMIN_PASS:-test-admin-123}"
DAV_PASS="${DAV_PASS:-test-dav-456}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then
    printf '  \033[32m✓\033[0m %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m %s   期望=%s 实际=%s\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

# 取响应码。自动带上 cookie jar 与超时
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 25 -b "$JAR" "$@"; }
body() { curl -s --max-time 25 -b "$JAR" "$@"; }

BODY='第一章 风起
这是一段用于冒烟测试的中文正文，长度足够触发一次真实的 R2 对象写入。'

echo
echo "0 · 状态复位（本地 R2 状态跨轮次持久，先清残留保证断点确定性）"
# 复位要先登录，后面的正式鉴权测试重登一次也无妨
curl -s -o /dev/null -c "$JAR" --max-time 20 -X POST -H 'content-type: application/json' -d "{\"password\":\"$ADMIN_PASS\"}" "$BASE/api/login"
# 清空回收站（服务端 purge 单次限 40，分批）
TKEYS="$(body "$BASE/api/trash" | grep -o '"key":"_trash/[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')"
if [ -n "$TKEYS" ]; then
  BATCH=""
  N=0
  for k in $TKEYS; do
    BATCH="$BATCH\"$k\","
    N=$((N+1))
    if [ "$N" -ge 40 ]; then
      code -X POST -H 'content-type: application/json' -d "{\"keys\":[${BATCH%,}]}" "$BASE/api/purge" > /dev/null
      BATCH=""
      N=0
    fi
  done
  if [ -n "$BATCH" ]; then
    code -X POST -H 'content-type: application/json' -d "{\"keys\":[${BATCH%,}]}" "$BASE/api/purge" > /dev/null
  fi
fi
# 删光所有分类里的书，再删分类
for SLUG in $(body "$BASE/api/state" | grep -o '"slug":"[^"]*"' | cut -d'"' -f4); do
  for FILE in $(body "$BASE/api/cat/$SLUG" | grep -o '"file":"[^"]*"' | cut -d'"' -f4); do
    code -X POST -H 'content-type: application/json' -d "{\"slug\":\"$SLUG\",\"file\":\"$FILE\"}" "$BASE/api/delete" > /dev/null
  done
  code -X DELETE -H 'content-type: application/json' -d "{\"slug\":\"$SLUG\"}" "$BASE/api/cat" > /dev/null
done
check "复位后书目为 0" 0 "$(body "$BASE/api/state" | grep -o '"totalBooks":[0-9]*' | cut -d: -f2)"

echo
echo "1 · 鉴权"
check "无凭据访问 /books/ 应 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/books/")"
check "错误口令登录应 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST -H 'content-type: application/json' -d '{"password":"definitely-wrong"}' "$BASE/api/login")"
check "正确口令登录应 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -c "$JAR" -X POST -H 'content-type: application/json' -d "{\"password\":\"$ADMIN_PASS\"}" "$BASE/api/login")"
check "上传端页面可访问" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Accept: text/html' "$BASE/")"
check "非浏览器 GET /（无 Accept）应 401 挑战" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/")"

echo
echo "2 · 分类与上传"
check "新建分类（中文显示名）" 200 "$(code -X POST -H 'content-type: application/json' -d '{"slug":"xuanhuan","name":"玄幻"}' "$BASE/api/cat")"
check "上传 txt" 200 "$(printf '%s' "$BODY" | curl -s -o /dev/null -w '%{http_code}' --max-time 25 -b "$JAR" -X POST --data-binary @- "$BASE/api/upload?cat=xuanhuan&catName=%E7%8E%84%E5%B9%BB&file=smoke.txt&ow=1")"
check "上传中文文件名" 200 "$(printf '%s' "$BODY" | curl -s -o /dev/null -w '%{http_code}' --max-time 25 -b "$JAR" -X POST --data-binary @- "$BASE/api/upload?cat=xuanhuan&catName=%E7%8E%84%E5%B9%BB&file=%E4%B8%AD%E6%96%87%E6%B5%8B%E8%AF%95.txt&ow=1")"
check "state 报告 2 本" 2 "$(body "$BASE/api/state" | grep -o '"count":[0-9]*' | head -1 | cut -d: -f2)"
# 中文 slug 回归：/api/cat/:slug 此前漏解码，中文分类的书目列表恒为 404/空
check "新建中文 slug 分类" 200 "$(code -X POST -H 'content-type: application/json' -d '{"slug":"测试","name":"测试分类"}' "$BASE/api/cat")"
check "中文 slug 分类可上传" 200 "$(printf '%s' "$BODY" | curl -s -o /dev/null -w '%{http_code}' --max-time 25 -b "$JAR" -X POST --data-binary @- "$BASE/api/upload?cat=%E6%B5%8B%E8%AF%95&file=cjk-slug.txt&ow=1")"
check "中文 slug 书目列表可读（修复前恒 404）" 1 "$(body "$BASE/api/cat/%E6%B5%8B%E8%AF%95" | grep -o '"file":"cjk-slug.txt"' | wc -l | tr -d ' ')"

echo
echo "3 · WebDAV 只读子集"
check "PROPFIND 根应 207" 207 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X PROPFIND -H 'Depth: 1' -u "book:$DAV_PASS" "$BASE/")"
check "PROPFIND 分类应 207" 207 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X PROPFIND -H 'Depth: 1' -u "book:$DAV_PASS" "$BASE/books/xuanhuan")"
check "Depth: infinity 应 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X PROPFIND -H 'Depth: infinity' -u "book:$DAV_PASS" "$BASE/")"
check "GET 下载应 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/books/xuanhuan/smoke.txt")"
check "Range 请求应 206" 206 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" -H 'Range: bytes=0-9' "$BASE/books/xuanhuan/smoke.txt")"
check "中文文件名可下载" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/books/xuanhuan/%E4%B8%AD%E6%96%87%E6%B5%8B%E8%AF%95.txt")"
check "PUT 应被拒 405" 405 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X PUT -u "book:$DAV_PASS" --data-binary 'x' "$BASE/books/xuanhuan/smoke.txt")"
check "DELETE 应被拒 405" 405 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE -u "book:$DAV_PASS" "$BASE/books/xuanhuan/smoke.txt")"
check "OPTIONS 应 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X OPTIONS -u "book:$DAV_PASS" "$BASE/")"
check "下载内容与上传一致" "$BODY" "$(curl -s --max-time 20 -u "book:$DAV_PASS" "$BASE/books/xuanhuan/smoke.txt")"

echo
echo "4 · OPDS"
check "OPDS 根 feed" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/opds/")"
check "OPDS 分类 feed" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/opds/xuanhuan.xml")"
check "OPDS 搜索" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/opds/search.xml?q=smoke")"
check "OpenSearch 描述" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/opds/opensearch.xml")"
check "根 feed 含玄幻分类" 1 "$(curl -s --max-time 20 -u "book:$DAV_PASS" "$BASE/opds/" | grep -c '玄幻')"
check "分类 feed 含 2 个 entry" 2 "$(curl -s --max-time 20 -u "book:$DAV_PASS" "$BASE/opds/xuanhuan.xml" | grep -o '<entry>' | wc -l | tr -d ' ')"

echo
echo "5 · 软删除与恢复"
check "删除应 200" 200 "$(code -X POST -H 'content-type: application/json' -d '{"slug":"xuanhuan","file":"smoke.txt"}' "$BASE/api/delete")"
check "删除后下载应 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/books/xuanhuan/smoke.txt")"
TKEY="$(body "$BASE/api/trash" | grep -o '"key":"_trash/[^"]*/smoke\.txt"' | head -1 | cut -d'"' -f4)"
check "回收站里有文件" 1 "$([ -n "$TKEY" ] && echo 1 || echo 0)"
if [ -n "$TKEY" ]; then
  check "恢复应 200" 200 "$(code -X POST -H 'content-type: application/json' -d "{\"key\":\"$TKEY\",\"slug\":\"xuanhuan\"}" "$BASE/api/restore")"
  check "恢复后可下载" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/books/xuanhuan/smoke.txt")"
  check "恢复后内容一致" "$BODY" "$(curl -s --max-time 20 -u "book:$DAV_PASS" "$BASE/books/xuanhuan/smoke.txt")"
  # 恢复同名冲突回归：修复前会静默覆盖现有文件、索引与实际内容错位
  check "再次删除应 200" 200 "$(code -X POST -H 'content-type: application/json' -d '{"slug":"xuanhuan","file":"smoke.txt"}' "$BASE/api/delete")"
  TKEY2="$(body "$BASE/api/trash" | grep -o '"key":"_trash/[^"]*/smoke\.txt"' | head -1 | cut -d'"' -f4)"
  check "重传同名应 200" 200 "$(printf '%s' "$BODY" | curl -s -o /dev/null -w '%{http_code}' --max-time 25 -b "$JAR" -X POST --data-binary @- "$BASE/api/upload?cat=xuanhuan&file=smoke.txt&ow=1")"
  check "恢复撞同名应 409" 409 "$(code -X POST -H 'content-type: application/json' -d "{\"key\":\"$TKEY2\",\"slug\":\"xuanhuan\"}" "$BASE/api/restore")"
  check "清理冲突的回收站项" 200 "$(code -X POST -H 'content-type: application/json' -d "{\"keys\":[\"$TKEY2\"]}" "$BASE/api/purge")"
fi

echo
echo "6 · 重建索引"
check "rebuild 应 200" 200 "$(code -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/rebuild")"
check "重建后仍能下载" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/books/xuanhuan/smoke.txt")"
check "重建后书目数不丢" 2 "$(body "$BASE/api/state" | grep -o '"count":[0-9]*' | head -1 | cut -d: -f2)"

echo
echo "7 · /backup/ 备份通道（Readingo 进度）"
check "PUT /backup/ 应 201" 201 "$(printf 'progress-json-data' | curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X PUT -u "book:$DAV_PASS" --data-binary @- "$BASE/backup/readingo.json")"
check "GET /backup/ 内容一致" "progress-json-data" "$(curl -s --max-time 20 -u "book:$DAV_PASS" "$BASE/backup/readingo.json")"
check "PROPFIND /backup/ 应 207" 207 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X PROPFIND -H 'Depth: 1' -u "book:$DAV_PASS" "$BASE/backup/")"
check "PROPFIND /backup/ 含备份文件" 1 "$(curl -s --max-time 20 -X PROPFIND -H 'Depth: 1' -u "book:$DAV_PASS" "$BASE/backup/" | grep -c 'readingo.json')"
check "MKCOL /backup/ 子目录应 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X MKCOL -u "book:$DAV_PASS" "$BASE/backup/sub")"
check "备份超 5MB 应 413" 413 "$(head -c 5242881 /dev/zero | curl -s -o /dev/null -w '%{http_code}' --max-time 25 -X PUT -u "book:$DAV_PASS" --data-binary @- "$BASE/backup/big.json")"
check "DELETE /backup/ 应 204" 204 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE -u "book:$DAV_PASS" "$BASE/backup/readingo.json")"
check "删除后 GET 应 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/backup/readingo.json")"
check "DELETE 整个 backup 集合应 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE -u "book:$DAV_PASS" "$BASE/backup/")"
check "PUT /books/ 依旧 405" 405 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X PUT -u "book:$DAV_PASS" --data-binary 'x' "$BASE/books/xuanhuan/smoke.txt")"

echo
echo "8 · 同名覆盖与移动/改名"
NONCE="dedup$(date +%s)"
check "nonce 首传应 200" 200 "$(printf '%s' "$BODY" | curl -s -o /dev/null -w '%{http_code}' --max-time 25 -b "$JAR" -X POST --data-binary @- "$BASE/api/upload?cat=xuanhuan&file=$NONCE.txt&ow=1")"
check "重传同名无 ow 应 409" 409 "$(printf '%s' "$BODY" | curl -s -o /dev/null -w '%{http_code}' --max-time 25 -b "$JAR" -X POST --data-binary @- "$BASE/api/upload?cat=xuanhuan&file=$NONCE.txt")"
check "ow=1 覆盖重传应 200" 200 "$(printf '%s' "$BODY" | curl -s -o /dev/null -w '%{http_code}' --max-time 25 -b "$JAR" -X POST --data-binary @- "$BASE/api/upload?cat=xuanhuan&file=$NONCE.txt&ow=1")"
check "新建目标分类" 200 "$(code -X POST -H 'content-type: application/json' -d '{"slug":"dushi","name":"都市"}' "$BASE/api/cat")"
check "跨分类移动应 200" 200 "$(code -X POST -H 'content-type: application/json' -d '{"items":[{"slug":"xuanhuan","file":"smoke.txt","toSlug":"dushi"}]}' "$BASE/api/move")"
check "移动后旧路径 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/books/xuanhuan/smoke.txt")"
check "移动后新路径 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/books/dushi/smoke.txt")"
check "改名应 200" 200 "$(code -X POST -H 'content-type: application/json' -d '{"items":[{"slug":"dushi","file":"smoke.txt","toSlug":"dushi","newName":"smoke-renamed.txt"}]}' "$BASE/api/move")"
check "改名后新书名 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/books/dushi/smoke-renamed.txt")"
check "移动超 3 项应 413" 413 "$(code -X POST -H 'content-type: application/json' -d '{"items":[{},{},{},{}]}' "$BASE/api/move")"
PK="$(for i in $(seq 0 40); do printf '"_trash/purge-limit-%s",' "$i"; done)"
check "purge 超 40 项应 413" 413 "$(code -X POST -H 'content-type: application/json' -d "{\"keys\":[${PK%,}]}" "$BASE/api/purge")"
check "批量删除应 200" 200 "$(code -X POST -H 'content-type: application/json' -d '{"items":[{"slug":"dushi","file":"smoke-renamed.txt"},{"slug":"xuanhuan","file":"'"$NONCE"'.txt"}]}' "$BASE/api/batch-delete")"
check "批量删除后 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "book:$DAV_PASS" "$BASE/books/dushi/smoke-renamed.txt")"

echo
printf '结果：\033[32m%d 通过\033[0m，' "$pass"
if [ "$fail" -gt 0 ]; then printf '\033[31m%d 失败\033[0m\n' "$fail"; exit 1; fi
printf '0 失败\n\n'
