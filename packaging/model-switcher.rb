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
    libexec.install "dist"
    libexec.install "bin/resolve-entry.mjs"
    libexec.install "package.json"

    (bin/"ms").write <<~SHIM
      #!/bin/bash
      exec env MS_ENTRY=dist node "#{libexec}/dist/ms.js" "$@"
    SHIM
    (bin/"ms").chmod 0755
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ms --version")
  end
end
