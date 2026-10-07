#!/usr/bin/env python3
"""Change the independent snapshot's role only after the primary is fenced."""
import argparse
import json
import os
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("mode", choices=["standby", "active"])
parser.add_argument("--primary-fenced", action="store_true")
args = parser.parse_args()
if os.geteuid() != 0:
    parser.error("Run through sudo on the standby host")
if args.mode == "active" and not args.primary_fenced:
    parser.error("Confirm that the Mac mini cannot run or refresh the same accounts; use --primary-fenced")

os.umask(0o077)
path = Path("/etc/sub2api/compose-private.json")
config = json.loads(path.read_text())
app = config["services"]["app"]
if app["container_name"] != "getcodex-sub2api-app":
    raise SystemExit("Unexpected application target")
active = args.mode == "active"
app["environment"].update({
    "TOKEN_REFRESH_ENABLED": str(active).lower(),
    "USAGE_CLEANUP_ENABLED": str(active).lower(),
    "CHANNEL_MONITOR_V2_DISABLE_AGGREGATOR": "0" if active else "1",
})
pending = path.with_suffix(".pending")
pending.write_text(json.dumps(config, indent=2))
pending.chmod(0o600)
pending.replace(path)
subprocess.run(["docker", "compose", "-p", "getcodex-sub2api", "--env-file", "/dev/null", "-f", str(path),
                "up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", "app"], check=True)
print(json.dumps({"mode": args.mode, "primaryFencedAcknowledged": args.primary_fenced}))
