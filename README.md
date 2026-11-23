# Poll Tail

Open a file in a live view that follows appended content, **without relying on VS Code's file watcher**.

VS Code normally learns about file changes from inotify. When the watch limit is exhausted, or the file
lives on a filesystem that does not deliver change events, open files silently stop updating. Poll Tail
serves the file through its own `polltail:` filesystem provider and checks it on a timer (`stat`), so it
keeps working in those situations.

## Usage

* Right-click a file in the Explorer (or an editor tab) and choose **Poll Tail: Open File (Follow)**, or run the
  same command from the Command Palette.
* The file opens as a normal editor tab. Syntax highlighting is the standard VS Code highlighting, chosen from
  the file name (so `.log` files get the `log` language, and `files.associations` still applies).

| Setting | Default | |
|---|---|---|
| **Follow** | on | Scrolls to the end when new content arrives. Scrolling up pauses it (like `less +F`); scrolling back to the end resumes it. |
| **Read-only** | on | Toggle per file with **Poll Tail: Toggle Read-only** (editor title button or status bar). |

Both are shown in the status bar and can be toggled by clicking them. Defaults come from settings:

* `polltail.defaultFollow` (default `true`)
* `polltail.defaultReadOnly` (default `true`)
* `polltail.pollIntervalMs` (default `1000`, minimum `100`)
* `polltail.maxBytes` (default 20 MiB; `0` = no limit)

## Large files

If a file is bigger than `polltail.maxBytes`, only its last `maxBytes` bytes are shown (starting at a line
boundary) and the file is **forced read-only**, so saving can never overwrite the real file with a partial view.

## Read-write caveats

In read-write mode, saving writes the whole editor buffer back to the file. If another process appended lines
since you last saw the file, VS Code should show its usual "file is newer" conflict prompt on save, but do not
edit a file that something else is actively writing unless you understand the risk.

## How it works / limits

* A single timer stats each open Poll Tail file and compares mtime, size and inode (so rotation is detected).
  A missing file (mid-rotation) is tolerated and picked up when it reappears.
* Changes are signalled to VS Code through the filesystem provider's change event, so the editor reloads
  through its normal path. A document with unsaved edits is not overwritten (standard VS Code behaviour).
* The extension runs where the file is (`extensionKind: workspace`), so it works over Remote-SSH.
* Polling means updates lag by up to the poll interval.
