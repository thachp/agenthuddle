#!/usr/bin/env python3
"""Runs the scanner image under an instance's limits, with no network, and measures what ADR 0006 lists.

Docker's limits stand in for Cloudflare's. They show memory and behavior fairly, but not Cloudflare's CPU, disk or start time.
"""
import hashlib
import http.client
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
FIXTURES = os.path.join(ROOT, "fixtures")
IMAGE = "podster-spike-clamav"
PORT = 18080
PLATFORM = os.environ.get("SPIKE_PLATFORM", "linux/arm64")
LIMITS = {"standard-1": ("4g", "0.5"), "basic": ("1g", "0.25"), "custom-2g": ("2g", "0.5")}
EXPECTED = {
    "clean-small.txt": "clean", "clean-empty.txt": "clean", "clean-100mb.bin": "clean",
    "eicar.txt": "blocked", "eicar-in-zip.zip": "blocked", "eicar-in-nested-zip.zip": "blocked",
    "bomb-flat-2gb.zip": "blocked", "bomb-deep-15.zip": "blocked", "bomb-many-20000.zip": "blocked", "bomb-wide-655gb.zip": "blocked",
    "eicar-past-limit.zip": "blocked", "clean-archive.zip": "clean",
    "encrypted.zip": "blocked", "truncated.zip": "blocked", "not-really.zip": "blocked",
}


def docker(*args, check=True, capture=True):
    return subprocess.run(["docker", *args], check=check, capture_output=capture, text=True)


def request(method, path, body=None, timeout=900):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    headers = {"content-length": str(os.path.getsize(body))} if body else {}
    if body:
        with open(body, "rb") as handle:
            conn.request(method, path, body=handle, headers=headers)
            response = conn.getresponse()
    else:
        conn.request(method, path)
        response = conn.getresponse()
    data = json.loads(response.read() or b"{}")
    conn.close()
    return response.status, data


def run(name, memory, cpus):
    docker("rm", "-f", name, check=False)
    # UPDATE_SIGNATURES is off, so nothing in the image reaches out. Only the Worker's allowlist, on a deployment, enforces that.
    docker("run", "-d", "--name", name, "--platform", PLATFORM, "--memory", memory, "--memory-swap", memory, "--cpus", cpus, "--network", "bridge", "-p", f"127.0.0.1:{PORT}:8080", IMAGE)


def wait_ready(name, limit=900):
    begun = time.monotonic()
    while time.monotonic() - begun < limit:
        state = docker("inspect", "-f", "{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}", name).stdout.split()
        if state[0] != "true":
            return {"ready": False, "oom_killed": state[1], "exit": state[2], "after_ms": round((time.monotonic() - begun) * 1000)}
        try:
            status, health = request("GET", "/health", timeout=5)
            if status == 200 and health.get("ready"):
                return {**health, "after_ms": round((time.monotonic() - begun) * 1000)}
            if status == 200 and health.get("clamd_exit") is not None:
                return {**health, "after_ms": round((time.monotonic() - begun) * 1000)}
        except OSError:
            pass
        time.sleep(0.25)
    return {"ready": False, "timed_out": True}


def main():
    subprocess.run(["docker", "build", "-q", "--platform", PLATFORM, "-t", IMAGE, os.path.join(ROOT, "scanner", "container")], check=True, stdout=subprocess.DEVNULL)
    size = docker("image", "inspect", "-f", "{{.Size}}", IMAGE).stdout.strip()
    report = {"platform": PLATFORM, "image_bytes": int(size), "fits": {}, "cold_starts_ms": [], "scans": {}}
    for label, (memory, cpus) in LIMITS.items():
        name = f"spike-clamav-{label}"
        run(name, memory, cpus)
        health = wait_ready(name, limit=420)
        report["fits"][label] = {"memory": memory, "cpus": cpus, "ready": health.get("ready"), "clamd_exit": health.get("clamd_exit"), "oom_killed": health.get("oom_killed"), "cold_start_ms": health.get("cold_start_ms"), "memory_at_ready": health.get("memory"), "version": health.get("version")}
        # Fitting at rest isn't fitting in use: the largest file allowed, then the state of the container.
        if health.get("ready"):
            try:
                status, data = request("POST", "/scan", body=os.path.join(FIXTURES, "clean-100mb.bin"))
                report["fits"][label]["largest_file"] = {"http": status, "verdict": data.get("verdict"), "scan_ms": data.get("scan_ms"), "peak_memory": (data.get("memory") or {}).get("cgroup_peak")}
            except OSError as problem:
                report["fits"][label]["largest_file"] = {"error": type(problem).__name__}
            report["fits"][label]["after"] = docker("inspect", "-f", "{{.State.Running}} OOM={{.State.OOMKilled}} exit={{.State.ExitCode}}", name).stdout.strip()
        print(label, json.dumps(report["fits"][label]), flush=True)
        docker("rm", "-f", name, check=False)

    name = "spike-clamav-standard-1"
    for attempt in range(3):
        run(name, *LIMITS["standard-1"])
        health = wait_ready(name)
        report["cold_starts_ms"].append(health.get("cold_start_ms"))
        print("cold start", attempt, health.get("cold_start_ms"), flush=True)
        if attempt < 2:
            docker("rm", "-f", name, check=False)

    wrong = 0
    for fixture, expected in EXPECTED.items():
        target = os.path.join(FIXTURES, fixture)
        try:
            status, data = request("POST", "/scan", body=target)
        except OSError as problem:
            # No answer is no verdict. The queue would retry it, so it's recorded, and the scanner is started again for the next file.
            status, data = None, {"verdict": None, "reason": type(problem).__name__}
        alive = docker("inspect", "-f", "{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}", name).stdout.strip()
        row = {"bytes": os.path.getsize(target), "http": status, "verdict": data.get("verdict"), "reason": data.get("reason"), "detail": data.get("detail"), "clamd_said": data.get("clamd_said"), "scan_ms": data.get("scan_ms"), "walk_ms": data.get("archive_walk_ms"), "peak_memory": (data.get("memory") or {}).get("cgroup_peak"), "container": alive, "expected": expected}
        report["scans"][fixture] = row
        if data.get("verdict") != expected:
            wrong += 1
        print(fixture, json.dumps(row), flush=True)
        if not alive.startswith("true") or data.get("verdict") is None:
            run(name, *LIMITS["standard-1"])
            wait_ready(name)
    status, health = request("GET", "/health")
    report["memory_after_all"] = health.get("memory")
    report["clamd_exit_after_all"] = health.get("clamd_exit")
    docker("rm", "-f", name, check=False)
    os.makedirs(os.path.join(ROOT, "results"), exist_ok=True)
    out = os.path.join(ROOT, "results", f"container-{PLATFORM.replace('/', '-')}.json")
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(f"wrote {out}; {wrong} verdicts differ from expected")


main()
