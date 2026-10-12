"""Regenerate every component PNG + port file, and merge one combined index.

    python3 buildall.py

Writes each part's own <part>.png and <part>-ports.json, then ports.json at
the repo root holding every port for every part in one document.
"""
import json, os, runpy

HERE = os.path.dirname(os.path.abspath(__file__))
PARTS = ["pdh", "pdp", "vrm", "battery", "breaker120", "canivore"]

DESC = {
    "pdh":        "REV Power Distribution Hub",
    "pdp":        "CTRE Power Distribution Panel (original)",
    "vrm":        "CTRE Voltage Regulator Module",
    "battery":    "12V 18Ah SLA robot battery",
    "breaker120": "120A main breaker (Bussmann 285120)",
    "canivore":   "CTRE CANivore USB-to-CAN FD adapter",
}

combined = {
    "schema": 1,
    "units": "design units; each part's PNG is saved 1:1 so these are pixels",
    "sides": "which edge of the part a wire leaves from: left|right|top|bottom",
    "parts": {},
}

for part in PARTS:
    script = os.path.join(HERE, part, part + ".py")
    ns = runpy.run_path(script)          # draws the PNG, writes <part>-ports.json
    ports = json.load(open(os.path.join(HERE, part, part + "-ports.json")))
    combined["parts"][part] = {
        "description": DESC[part],
        "image": f"{part}/{part}.png",
        "width": ns["W"],
        "height": ns["H"],
        "port_count": len(ports),
        "ports": ports,
    }

out = os.path.join(HERE, "ports.json")
with open(out, "w") as f:
    json.dump(combined, f, indent=2)

total = sum(p["port_count"] for p in combined["parts"].values())
print(f"\nwrote {out} - {len(PARTS)} parts, {total} ports total")
for name, p in combined["parts"].items():
    print(f"  {name:11s} {p['width']:>4}x{p['height']:<5} {p['port_count']:>3} ports")
