# Release workflow replaces these placeholders using the actual DMG checksums.
cask "ardur" do
  version "@VERSION@"

  on_arm do
    sha256 "@ARM64_SHA256@"

    url "https://github.com/ArdurAI/ardur-bot/releases/download/v#{version}/ardur-#{version}-mac-arm64.dmg"
  end
  on_intel do
    sha256 "@X64_SHA256@"

    url "https://github.com/ArdurAI/ardur-bot/releases/download/v#{version}/ardur-#{version}-mac-x64.dmg"
  end

  name "Ardur"
  desc "Persistent bots on computers and models you choose"
  homepage "https://github.com/ArdurAI/ardur-bot"

  depends_on :macos

  app "Ardur.app"
  # Execute the bundle path, not Homebrew's binary symlink: Electron locates helpers beside it.
  preflight do
    require "shellwords"
    executable = "#{appdir}/Ardur.app/Contents/MacOS/Ardur".shellescape
    launcher = staged_path.join("ardur")
    File.write(launcher, "#!/bin/bash\nexec #{executable} \"$@\"\n")
    File.chmod(0755, launcher)
  end
  binary "ardur"

@MACOS_CAVEATS@
end
