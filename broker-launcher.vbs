Set objShell = CreateObject("WScript.Shell")
objShell.Environment("Process").Item("CLAUDE_PEERS_BIND") = "lan"
objShell.Run """C:\nvm4w\nodejs\bun.cmd"" ""D:\repos\claude-peers-mcp\broker.ts""", 0, False
