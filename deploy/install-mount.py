#!/usr/bin/env python3
"""Install a dedicated read-only CIFS mount from server-local JSON on stdin.

Input keys: source (//server/share), subdirectory, username, password, domain.
No configuration or secrets are accepted through arguments or printed.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

def main():
    if os.geteuid() != 0:
        raise RuntimeError("Run as root on the deployment host")
    config = json.load(sys.stdin)
    for key in ("source", "subdirectory", "username", "password", "domain"):
        value = config.get(key, "")
        if not isinstance(value, str) or any(c in value for c in ("\n", "\r", "\x00")):
            raise RuntimeError("Invalid mount configuration")
    source = config["source"]
    subdir = config.get("subdirectory", "")
    if not source.startswith("//") or any(c in source + subdir for c in (",", "%", "\\")) or ".." in subdir.split("/"):
        raise RuntimeError("Unsupported share path")
    private = Path("/etc/firstleap")
    private.mkdir(mode=0o700, exist_ok=True)
    os.chmod(private, 0o700)
    credentials = private / "smb.credentials"
    with os.fdopen(os.open(credentials, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as file:
        for key in ("username", "password", "domain"):
            if config.get(key):
                file.write(f"{key}={config[key]}\n")
    os.chmod(credentials, 0o600)
    Path("/srv/firstleap/media").mkdir(parents=True, exist_ok=True)
    options = "ro,vers=3.0,credentials=/etc/firstleap/smb.credentials,uid=10001,gid=10001,forceuid,forcegid,file_mode=0444,dir_mode=0555,nosuid,nodev,noexec,_netdev"
    if subdir:
        source = source.rstrip("/") + "/" + subdir.strip("/")
    # systemd unit specifiers and whitespace must never change field semantics.
    source = source.replace(" ", "\\x20")
    options = options.replace(" ", "\\x20")
    unit = "[Unit]\nDescription=FirstLeap read-only course source\nWants=network-online.target\nAfter=network-online.target\n\n[Mount]\nWhat=" + source + "\nWhere=/srv/firstleap/media\nType=cifs\nOptions=" + options + "\nTimeoutSec=30\n\n[Install]\nWantedBy=remote-fs.target\n"
    Path("/etc/systemd/system/srv-firstleap-media.mount").write_text(unit)
    subprocess.run(["systemctl", "daemon-reload"], check=True, stdout=subprocess.DEVNULL)
    result = subprocess.run(["systemctl", "enable", "--now", "srv-firstleap-media.mount"], capture_output=True)
    if result.returncode:
        raise RuntimeError("Mount setup failed; inspect private host logs")
    print("Dedicated read-only course mount is ready.")

if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Mount installation failed; configuration details withheld.", file=sys.stderr)
        sys.exit(1)
