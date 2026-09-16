class ModelSwitcher < Formula
  desc "Run claude and codex on whichever subscription account has room, and rotate a walled pane in place"
  homepage "https://github.com/aadarwal/model-switcher"
  url "__URL__"
  sha256 "__SHA256__"
  version "__VERSION__"
  license "MIT"

  depends_on "node"
  depends_on "tmux"

  def install
    # `bin/` whole, not just resolve-entry.mjs: `bin/ms` is the real launcher
    # — it resolves an entry, registers a TypeScript loader when the entry is
    # a source tree, and CALLS `main`. `dist/ms.js` only EXPORTS `main`, so a
    # shim that ran the bundle directly printed nothing and exited 0 for every
    # verb. `bin/ms` imports `./resolve-entry.mjs` as a sibling, and
    # resolve-entry looks for `../dist/ms.js`, so the two must stay in this
    # layout: libexec/bin/{ms,resolve-entry.mjs} beside libexec/dist/ms.js.
    libexec.install "dist"
    libexec.install "bin"
    # `ms --version` reads it, from `<bundle>/../package.json`.
    libexec.install "package.json"

    # MS_BIN is `opt_bin`, never `bin`. During `def install` Homebrew's `bin`
    # is the VERSIONED keg path (HOMEBREW_CELLAR/model-switcher/<version>/bin),
    # which the next `brew upgrade` deletes — and msBinary() bakes this exact
    # string into the Claude hook commands, the Codex hook commands AND their
    # trust hashes, the statusline wrapper and the shell alias block. The
    # stable `opt` link (/opt/homebrew/opt/model-switcher/bin/ms) always
    # points at the current keg, so everything the wizard wrote survives an
    # upgrade; `ms doctor`'s "ms on PATH is msBinary()" check compares real
    # paths, and both resolve into the same keg.
    #
    # Homebrew's own node, not whatever `node` PATH happens to give: with
    # nvm/mise/asdf in front, `ms` and every hook Claude Code spawns would run
    # on that node, and below 22.15 there is no `process.execve` and no
    # `node:sqlite` at all.
    (bin/"ms").write <<~SHIM
      #!/bin/bash
      exec env MS_ENTRY=dist MS_BIN="#{opt_bin}/ms" "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/ms" "$@"
    SHIM
    (bin/"ms").chmod 0755
  end

  test do
    # Two checks, because the first one on its own cannot tell a working shim
    # from a silent no-op that exits 0: `--version` proves `main` ran and
    # printed, and `--help` proves a second path through it. Neither opens the
    # store, the network, or a credential. `brew install` does not run `test
    # do`, so this is what `brew test model-switcher` (and a CI tap check)
    # catches before a release goes out.
    assert_match version.to_s, shell_output("#{bin}/ms --version")
    assert_match "usage: ms", shell_output("#{bin}/ms --help 2>&1")
  end
end
