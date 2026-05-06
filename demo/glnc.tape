# vhs tape — generate demo.gif for glnc launch
# Run: vhs demo/glnc.tape

Output demo/demo.gif

Set FontSize 14
Set Width 1100
Set Height 700
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set PlaybackSpeed 1.0

# Make `glnc` resolve to the built binary without polluting the demo with paths
Hide
Type "alias glnc='./dist/glnc-darwin-arm64'"
Enter
Type "clear"
Enter
Show

# 1. The pitch in one command — paste an ENS, get a multi-chain portfolio
Type "glnc balance vitalik.eth --chain eth"
Sleep 400ms
Enter
Sleep 6s

# 2. Live gas across 9 chains
Type "clear"
Enter
Sleep 200ms
Type "glnc gas"
Sleep 400ms
Enter
Sleep 6s

# 3. JSON output is composable
Type "clear"
Enter
Sleep 200ms
Type "glnc gas --chain eth --json | jq '.data.chains[0].baseFeeGwei'"
Sleep 400ms
Enter
Sleep 3s

Sleep 1s
