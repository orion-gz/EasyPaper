"""Install inside the isolated Antigravity image/rootfs, never on the app path."""
import subprocess
import sys

# The CLI has no public authentication subcommand in 1.4.12. Authentication is
# performed through the operator's terminal inside this same personal runtime.
# Input stays on stdin until inside the isolation boundary.
command = ['agy', '--sandbox', '--disable-slash-commands', '--output-format', 'text']
if len(sys.argv) > 1 and sys.argv[1]:
    command.extend(['--model', sys.argv[1]])
command.extend(['--print', sys.stdin.read()])
raise SystemExit(subprocess.call(command))
