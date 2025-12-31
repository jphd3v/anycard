#!/usr/bin/env python3
import os
import sys
import subprocess
import argparse
from pathlib import Path

def run_command(cmd_list, file_path, verbose=False):
    try:
        result = subprocess.run(cmd_list, capture_output=True, text=True, timeout=10)
        if verbose:
            if result.stdout:
                print(result.stdout.strip())
            if result.stderr:
                print(result.stderr.strip(), file=sys.stderr)
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        print(f"  ⚠  {file_path}: Timeout")
        return False
    except Exception:
        return False

parser = argparse.ArgumentParser(description="Validate SVGs recursively.")
parser.add_argument("directory", help="Directory to search for SVGs")
parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose output")
parser.add_argument("--svgcheck", action="store_true", help="Enable svgcheck validation (disabled by default)")
args = parser.parse_args()

directory = Path(args.directory).resolve()
verbose = args.verbose
use_svgcheck = args.svgcheck

if not directory.is_dir():
    print(f"Error: '{directory}' is not a directory")
    sys.exit(1)

print(f"Validating SVGs recursively in: {directory}")
failed = False

# Find all SVG files recursively
svg_files = list(directory.rglob("*.svg"))

if not svg_files:
    print("No SVG files found.")
    sys.exit(0)

for svg_file in svg_files:
    print(f"=== Checking {svg_file} ===")
    
    # xmllint validation
    xmllint_pass = run_command(["xmllint", "--noout", str(svg_file)], svg_file, verbose=verbose)
    print(f"  {'✓' if xmllint_pass else '✗'} xmllint: {'PASS' if xmllint_pass else 'FAIL'}")
    if not xmllint_pass:
        failed = True
    
    if use_svgcheck:
        # svgcheck validation
        svgcheck_cmd = ["svgcheck"]
        if not verbose:
            svgcheck_cmd.append("--quiet")
        svgcheck_cmd.append(str(svg_file))
        
        svgcheck_pass = run_command(svgcheck_cmd, svg_file, verbose=verbose)
        print(f"  {'✓' if svgcheck_pass else '✗'} svgcheck: {'PASS' if svgcheck_pass else 'FAIL'}")
        if not svgcheck_pass:
            failed = True
    
    print()

if not failed:
    print("All SVGs passed validation!")
    sys.exit(0)
else:
    print("Some SVGs failed - check above for details.")
    sys.exit(1)
