#!/bin/zsh
# DeepSeek Harness worker entry point — used by BOTH:
#   - Zed agent_servers "DeepSeek Harness" (ACP over stdio)
#   - Hermes delegation: dsh-worker run "<brief>" --cwd <repo> --json ...
#
# 1) GUI-launched Zed inherits launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
#    which has no node. Restore the script's own dir (npm user-prefix bins) plus
#    common node locations. If node lives elsewhere (nvm/asdf), add it here.
self_dir="${0:A:h}"
export PATH="$self_dir:/usr/local/bin:/opt/homebrew/bin:$PATH"
# 2) Optional: the dsh CLI's "deepseek-official" provider route needs
#    DEEPSEEK_API_KEY; account-OAuth grants do not cover it. Reuse the key
#    already stored in ~/.hermes/.env if present (single source of truth —
#    never print it).
if [ -z "$DEEPSEEK_API_KEY" ] && [ -f "$HOME/.hermes/.env" ]; then
  key=$(grep '^DEEPSEEK_API_KEY' "$HOME/.hermes/.env" | head -1 | cut -d= -f2- | tr -d "\"'")
  export DEEPSEEK_API_KEY=***
fi
exec "$self_dir/dsh-acp-server" "$@"
