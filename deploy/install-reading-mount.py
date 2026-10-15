#!/usr/bin/env python3
"""Create the sibling reading mount from the server's private existing mount.

Run as root on the deployment host; never prints the share or credentials.
The existing media source must end in /NCESE01. Credentials are reused intact.
"""
import configparser
import os
from pathlib import Path
import subprocess
import sys


def main():
    if os.geteuid() != 0:
        raise RuntimeError("root required")
    config = configparser.ConfigParser(interpolation=None)
    config.read("/etc/systemd/system/srv-firstleap-media.mount")
    source = config["Mount"]["What"].rstrip("/")
    options = config["Mount"]["Options"]
    if not source.endswith("/NCESE01") or "ro" not in options.split(","):
        raise RuntimeError("unexpected private configuration")
    if "credentials=/etc/firstleap/smb.credentials" not in options.split(","):
        raise RuntimeError("unexpected credentials reference")
    source += "-video"
    Path("/srv/firstleap/readings").mkdir(parents=True, exist_ok=True)
    unit = (
        "[Unit]\nDescription=FirstLeap read-only reading source\n"
        "Wants=network-online.target\nAfter=network-online.target\n\n"
        "[Mount]\nWhat=" + source + "\nWhere=/srv/firstleap/readings\n"
        "Type=cifs\nOptions=" + options + "\nTimeoutSec=30\n\n"
        "[Install]\nWantedBy=remote-fs.target\n"
    )
    Path("/etc/systemd/system/srv-firstleap-readings.mount").write_text(unit)
    subprocess.run(["systemctl", "daemon-reload"], check=True, capture_output=True)
    subprocess.run(["systemctl", "enable", "--now", "srv-firstleap-readings.mount"], check=True, capture_output=True)
    print("Dedicated read-only reading mount is ready.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Reading mount installation failed; inspect private host logs.", file=sys.stderr)
        sys.exit(1)
