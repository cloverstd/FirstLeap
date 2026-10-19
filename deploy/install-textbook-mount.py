#!/usr/bin/env python3
"""Mount the sibling textbook source using the existing private CIFS settings.

Run as root on the deployment host after copying resources to NCESE01-textbooks.
The optional service drop-in ensures that textbooks are mounted before startup.
No share credentials are accepted through arguments or printed.
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
    source += "-textbooks"
    Path("/srv/firstleap/textbooks").mkdir(parents=True, exist_ok=True)
    unit = (
        "[Unit]\nDescription=FirstLeap read-only textbook source\n"
        "Wants=network-online.target\nAfter=network-online.target\n\n"
        "[Mount]\nWhat=" + source + "\nWhere=/srv/firstleap/textbooks\n"
        "Type=cifs\nOptions=" + options + "\nTimeoutSec=30\n\n"
        "[Install]\nWantedBy=remote-fs.target\n"
    )
    Path("/etc/systemd/system/srv-firstleap-textbooks.mount").write_text(unit)
    dropins = Path("/etc/systemd/system/firstleap.service.d")
    dropins.mkdir(parents=True, exist_ok=True)
    (dropins / "textbooks.conf").write_text(
        "[Unit]\nRequiresMountsFor=/srv/firstleap/textbooks\n\n"
        "[Service]\nExecStartPre=/usr/bin/mountpoint -q /srv/firstleap/textbooks\n"
    )
    subprocess.run(["systemctl", "daemon-reload"], check=True, capture_output=True)
    subprocess.run(
        ["systemctl", "enable", "--now", "srv-firstleap-textbooks.mount"],
        check=True, capture_output=True,
    )
    print("Dedicated read-only textbook mount is ready.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Textbook mount installation failed; inspect private host logs.", file=sys.stderr)
        sys.exit(1)
