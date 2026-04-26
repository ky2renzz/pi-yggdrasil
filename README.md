# pi-yggdrasil

Minimal Pi extension for multi-repo workspaces.

## Install

```bash
# Linux/macOS
mkdir -p ~/.pi/agent/extensions/pi-yggdrasil
cp src/index.ts package.json ~/.pi/agent/extensions/pi-yggdrasil/
cd ~/.pi/agent/extensions/pi-yggdrasil && npm install

# Windows (PowerShell)
$dir = "$env:USERPROFILE\.pi\agent\extensions\pi-yggdrasil"
New-Item -ItemType Directory -Force -Path $dir
Copy-Item src/index.ts, package.json $dir
Set-Location $dir; npm install
```

## Usage

Create `pi-workspace.json` in your project root:

```json
{
  "name": "my-project",
  "repos": [
    { "name": "bot", "path": "../telegram-bot" },
    { "name": "app", "path": "../mini-app" }
  ]
}
```

Tools:
- `workspace:action=list` - list repos
- `workspace:action=switch,repo=bot` - switch active repo
- `repo:action=path,repo=bot` - get absolute path
- `repo:action=cd,repo=bot` - get cd command
- `repo:action=ls,repo=bot` - list files

Command: `/workspace` - show workspace info

## License

MIT
