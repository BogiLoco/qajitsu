# Terminal demo of QAJitsu for the README (VHS: https://github.com/charmbracelet/vhs).
# Record from the repository root, after `pnpm build` and `node examples/demo-shop/scripts/setup-demo-repo.mjs`,
# with Ollama running (`ollama pull gemma4:e2b`):
#   vhs docs/demo/qajitsu.tape
# Long steps (model calls, the build) are recorded hidden, so the GIF stays short.

Output docs/assets/qajitsu-demo.gif
Output docs/assets/qajitsu-demo.mp4

Set Shell "zsh"
Set FontSize 16
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set WindowBar Colorful

Hide
Type "cd examples/demo-shop && export DEMO_USER_PASSWORD=demo-password && alias qj='node ../../packages/cli/dist/bin.js' && clear"
Enter
Sleep 1s
Show

Type "# A Jira ticket in, a verified test result out."
Sleep 1500ms
Enter

Type "qj doctor"
Sleep 400ms
Enter
Sleep 3s

Type "qj fetch DEMO-1      # ticket + the code change at its exact commit"
Sleep 400ms
Enter
Sleep 5s

Type "qj plan DEMO-1       # agents write the plan; I review it"
Sleep 400ms
Enter
Hide
Sleep 180s
Show
Sleep 4s
Type "a"
Sleep 600ms
Enter
Sleep 3s

Type "qj run DEMO-1 --build   # app built from that commit, tests run, statuses computed"
Sleep 400ms
Enter
Hide
Sleep 90s
Show
Sleep 6s

Type "qj evidence DEMO-1 --no-open"
Sleep 400ms
Enter
Sleep 6s

Type "# with a seeded bug switched on, the same case must end FAILED:"
Sleep 1s
Enter
Type "qj fetch DEMO-1 && qj plan DEMO-1 && qj run DEMO-1 --build --set api.BUG_CART_TOTAL_ROUNDING=1"
Sleep 400ms
Enter
Hide
Sleep 240s
Show
Sleep 8s
