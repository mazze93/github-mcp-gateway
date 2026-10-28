"""Reject split Node majors and mutable base images before building the image."""

import pathlib
import re

import yaml

root = pathlib.Path(__file__).resolve().parent.parent
dockerfile = (root / "Dockerfile").read_text()
images = re.findall(r"^FROM\s+(\S+)", dockerfile, re.MULTILINE)
if len(images) != 2 or any(not re.search(r"@sha256:[a-f0-9]{64}$", image) for image in images):
    raise SystemExit("Both Docker base images must be pinned by sha256 digest")

build = re.fullmatch(r"node:(\d+)-bookworm-slim@sha256:[a-f0-9]{64}", images[0])
runtime = re.fullmatch(r"gcr.io/distroless/nodejs(\d+)-debian12:nonroot@sha256:[a-f0-9]{64}", images[1])
if not build or not runtime:
    raise SystemExit("Unrecognized toolchain base image; review the runtime alignment policy")
versions = {"Docker build": build[1], "Docker runtime": runtime[1]}
for name in ("ci", "deploy", "release"):
    workflow = yaml.safe_load((root / f".github/workflows/{name}.yml").read_text())
    for job_name, job in workflow["jobs"].items():
        for index, step in enumerate(job.get("steps", [])):
            if step.get("uses", "").startswith("actions/setup-node@"):
                # Keyed by step so a second setup-node in one job cannot hide the first.
                versions[f"{name}/{job_name}#{index}"] = str(step["with"]["node-version"]).split(".")[0]
    if not any(key.startswith(f"{name}/") for key in versions):
        raise SystemExit(f"{name}: no explicit setup-node version to verify")
if len(set(versions.values())) != 1:
    raise SystemExit(f"Node major versions disagree: {versions}")
print(f"Toolchain Node major aligned: {versions}; both base images digest-pinned")
