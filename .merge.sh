#!/bin/bash
set -e
cd F:/maple/magpie-plugin-pack

git add -A
git commit -q -m "checkpoint: 16 standalone plugins before merging into one package"
git log --oneline -1

NEW=plugins/magpie-web-auth-pack
rm -rf "$NEW"
mkdir -p "$NEW/lib" "$NEW/test" "$NEW/assets"

for d in plugins/magpie-*-auth; do
  name=$(basename "$d" | sed 's/^magpie-//; s/-auth$//')
  mkdir -p "$NEW/lib/$name"
  cp "$d/index.mjs" "$NEW/lib/$name/index.mjs"
  cp "$d/lib/"*.mjs "$NEW/lib/$name/"
  sed -i 's|from "./lib/|from "./|g' "$NEW/lib/$name/index.mjs"
  for t in "$d"/test/*.mjs; do
    base="$NEW/test/$name__$(basename "$t")"
    cp "$t" "$base"
    sed -i "s|from \"../lib/|from \"../lib/$name/|g; s|from \"../index.|from \"../lib/$name/index.|g" "$base"
  done
  cp "$d/README.md" "$NEW/lib/$name/README.md"
done

cp plugins/magpie-deepseek-web-auth/assets/sha3_wasm_bg.wasm "$NEW/assets/"
sed -i 's|"../assets/|"../../assets/|g' "$NEW/lib/deepseek-web/pow.mjs"
cp plugins/magpie-lobsterai-auth/LICENSE "$NEW/LICENSE"
cp plugins/magpie-lobsterai-auth/icon.svg "$NEW/icon.svg"

echo "=== merged lib dirs ==="
ls "$NEW/lib"
echo "=== total files: $(find "$NEW" -type f | wc -l)"
echo "=== unrewritten ./lib/ imports in lib: ==="
grep -rln 'from "\./lib/' "$NEW/lib" || echo OK
echo "=== unrewritten ../lib/ imports in test: ==="
grep -rln 'from "\.\./lib/"' "$NEW/test" 2>/dev/null || echo "OK (all rewritten)"
echo "=== deepseek asset path: ==="
grep -n 'assets/' "$NEW/lib/deepseek-web/pow.mjs" | head -3
