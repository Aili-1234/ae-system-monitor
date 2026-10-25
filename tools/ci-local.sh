# 在本地模拟 GitHub Actions（Node 20 + bash）：逐组跑、逐项统计
# 用法：bash tools/ci-local.sh
set -u
cd "$(dirname "$0")/.."
echo "node $(node -v)  cwd $(pwd)"

total=0
failed=0
bad=""

for f in tests/*.test.js; do
  out=$(node "$f" 2>&1)
  line=$(printf '%s\n' "$out" | grep -E '[0-9]+ 通过' | tail -1)
  n=$(printf '%s\n' "$line" | grep -oE '[0-9]+ 通过' | grep -oE '[0-9]+')
  m=$(printf '%s\n' "$line" | grep -oE '[0-9]+ 失败' | grep -oE '[0-9]+')
  n=${n:-0}
  m=${m:-0}
  printf '%-28s 通过 %-3s 失败 %s\n' "$f" "$n" "$m"
  total=$((total + n))
  failed=$((failed + m))
  if [ "$m" -gt 0 ] || [ "$n" -eq 0 ]; then
    bad="$bad $f"
    printf '%s\n' "$out" | tail -25
  fi
done

echo "------------------------------------------"
echo "TOTAL  通过 $total  失败 $failed"
[ -z "$bad" ] || { echo "有问题的组:$bad"; exit 1; }
