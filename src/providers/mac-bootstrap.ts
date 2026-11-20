/** Install in the user's home: no admin password, shell history or API key. bb's
 * own enrollment/bootstrap follows over the same private stdin-capable executor. */
export const MAC_BOOTSTRAP = `set -eu
arch=$(case "$(uname -m)" in (arm64) echo arm64 ;; (x86_64) echo x64 ;; (*) exit 1 ;; esac)
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.local/bin"
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit((Number(process.versions.node.split(".")[0]) > 22 || (Number(process.versions.node.split(".")[0]) === 22 && Number(process.versions.node.split(".")[1]) >= 19)) ? 0 : 1)'; then
  tmp=$(mktemp -d)
  curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$tmp/sums"
  file=$(awk -v arch="$arch" '$2 ~ ("darwin-" arch ".tar.gz$") {print $2; exit}' "$tmp/sums")
  test -n "$file"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$file" -o "$tmp/$file"
  (cd "$tmp"; awk -v file="$file" '$2 == file' sums | shasum -a 256 -c -)
  tar -xzf "$tmp/$file" -C "$HOME/.local" --strip-components=1
  rm -rf "$tmp"
fi
if ! command -v claude >/dev/null 2>&1 || ! command -v codex >/dev/null 2>&1; then
  npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code @openai/codex
fi
if ! command -v gh >/dev/null 2>&1; then
  tmp=$(mktemp -d)
  curl -fsSL https://api.github.com/repos/cli/cli/releases/latest -o "$tmp/release.json"
  url=$(node -e 'const r=require(process.argv[1]); console.log(r.assets.find(a=>a.name.endsWith(process.arch === "arm64" ? "macOS_arm64.zip" : "macOS_amd64.zip")).browser_download_url)' "$tmp/release.json")
  curl -fsSL "$url" -o "$tmp/gh.zip"
  unzip -q "$tmp/gh.zip" -d "$tmp/gh"
  find "$tmp/gh" -type f -name gh -exec cp {} "$HOME/.local/bin/gh" \\;
  rm -rf "$tmp"
fi
case "$(cat "$HOME/.bash_profile" 2>/dev/null || true)" in (*'.local/bin'*) ;; (*) printf '\\nexport PATH="$HOME/.local/bin:$PATH"\\n' >> "$HOME/.bash_profile" ;; esac
mkdir -p "$HOME/.boat-hooks"
git config --global core.hooksPath "$HOME/.boat-hooks"
`;
