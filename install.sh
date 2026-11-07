#!/usr/bin/env sh
# 一键把 magpie-plugin-pack/plugins 下所有插件加进 magpie（文件夹就地加载）。
# 用法: ./install.sh  |  MAGPIE=/path/to/magpie ./install.sh
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ -n "$MAGPIE" ]; then
  EXE="$MAGPIE"
elif command -v magpie >/dev/null 2>&1; then
  EXE="$(command -v magpie)"
else
  echo "找不到 magpie。请把 magpie 放进 PATH，或：MAGPIE=/path/to/magpie ./install.sh" >&2
  exit 1
fi
echo "magpie: $EXE"

FOUND=0
FAILED=0
for dir in "$ROOT"/plugins/*; do
  [ -d "$dir" ] || continue
  [ -f "$dir/package.json" ] || continue
  FOUND=1
  echo ""
  echo "==> 添加 $(basename "$dir")"
  "$EXE" plugin add "$dir" || { echo "!! 失败: $(basename "$dir")" >&2; FAILED=1; }
done

if [ "$FOUND" -eq 0 ]; then
  echo "plugins/ 下没有可安装的插件目录（每个插件需含 package.json）" >&2
  exit 1
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "全部完成。已安装的插件会重复添加失败，属正常（已在列表中）。"
  echo "下一步：magpie plugin login <provider> 登录；GUI 里到 插件 -> 已安装 打开并登录。"
else
  echo "部分插件添加失败，可手动执行：magpie plugin add <该插件目录>" >&2
  exit 1
fi
