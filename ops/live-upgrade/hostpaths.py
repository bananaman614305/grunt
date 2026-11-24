"""Where the managed Amazing Adventure host keeps things, derived from the invoking user's home directory and uid. No user names or
absolute home paths are written here: the layout is relative to $HOME (the unit runs as the same user), the runtime directory comes
from XDG_RUNTIME_DIR, and the Node binary is discovered from the live unit by `upgrade.py` and recorded in attempt.json
(see rollout_config.load_node). Importing this module performs no action; tests point HOME at a temporary directory."""
import os
from pathlib import Path

from rollout_config import load_node

HOME = Path.home()
CONFIG = HOME / '.config/milo'                                  # primary daemon: runtime/, registry.json, maintenance.json, execution-host-adventure.json, ...
OWNER = HOME / '.local/lib/usegrunt-adventure'                  # owner supervisor, free-pool.mjs, runtime/, claude/
STATE = HOME / '.local/state/usegrunt-adventure'                # status.json, config.json, worker/, execution-host/
ADMIN_STATE = HOME / '.local/state/usegrunt-admin'
EFFICIENCY_STATE = HOME / '.local/state/usegrunt-efficiency'
EFFICIENCY_LIB = HOME / '.local/lib/usegrunt-efficiency'
SYSTEMD_USER = HOME / '.config/systemd/user'
OPENCODE_ARGV0 = str(HOME / '.local/bin/opencode')
OPENCODE_EXE = str(HOME / '.local/lib/node_modules/opencode-ai/bin/opencode.exe')
PRIMARY_MAIN = str(CONFIG / 'runtime/dist/local/main.js')
COLLECTOR_ENTRY = str(CONFIG / 'runtime/dist/admin/collector.js')
HOST_POLICY = CONFIG / 'execution-host-adventure.json'
UID = os.getuid()
RUNTIME_DIR = Path(os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{UID}')
NODE = load_node()
MEMORY_ROOT = Path(f'/sys/fs/cgroup/user.slice/user-{UID}.slice/user@{UID}.service/app.slice/grunt-amazing-adventure.service')


def systemd_env(base=None):
    """Environment for `systemctl --user` / `systemd-run --user` from a transient unit or a plain shell."""
    return {**(os.environ if base is None else base), 'XDG_RUNTIME_DIR': str(RUNTIME_DIR), 'DBUS_SESSION_BUS_ADDRESS': f'unix:path={RUNTIME_DIR}/bus'}
