"""
Extract individual playing-card SVGs by isolating the desired <g id="...">.

This keeps shared <defs> and styles so symbols referenced via <use> remain intact,
avoiding the blank exports seen when using inkscape --export-id.
"""
import copy
import sys
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

# --- Configuration ---
URL = "https://raw.githubusercontent.com/htdebeer/SVG-cards/master/svg-cards.svg"
BASE_DIR = Path.cwd()
INPUT_FILE = BASE_DIR / "svg-cards.svg"
OUTPUT_DIR = BASE_DIR / "htdebeer"

# Mapping Desired Filename -> Internal SVG ID
# The repo uses specific IDs: {suit}_{rank} (e.g. club_1, heart_queen)
SUITS = {
    "D": "diamond",
    "H": "heart",
    "S": "spade",
    "C": "club",
}

RANKS = {
    "A": "1",  # Ace is '1' in the SVG
    "2": "2",
    "3": "3",
    "4": "4",
    "5": "5",
    "6": "6",
    "7": "7",
    "8": "8",
    "9": "9",
    "T": "10",
    "J": "jack",
    "Q": "queen",
    "K": "king",
}

SPECIALS = {
    "1B": "back",  # Card Back
    "1J": "joker_red",  # Red Joker
    "2J": "joker_black",  # Black Joker
}

def safe_urlopen(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        raise ValueError(f"Insecure URL scheme: {parsed.scheme}")
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    return urllib.request.urlopen(url)

def main() -> None:
    # 0. Guard against clobbering an existing output directory.
    if OUTPUT_DIR.exists():
        print(f"Output directory already exists: {OUTPUT_DIR}")
        print("Delete or move it before re-running.")
        sys.exit(1)

    # 1. Download the source file if missing
    if not INPUT_FILE.exists():
        print(f"Downloading {INPUT_FILE.name}...")
        try:
            with safe_urlopen(URL) as response:
                with open(INPUT_FILE, 'wb') as f:
                    f.write(response.read())
        except Exception as exc:  # pragma: no cover - CLI helper
            print(f"Error downloading: {exc}")
            return

    # 2. Create output directory
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 3. Register Namespaces
    # This is critical. Without this, the <use> tags break and images become blank.
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")

    print("Parsing SVG...")
    # This is a developer helper script processing a known local file.
    # nosemgrep: python.lang.security.use-defused-xml-parse.use-defused-xml-parse
    tree = ET.parse(INPUT_FILE)
    root = tree.getroot()

    # 4. Generate Target List
    targets: dict[str, str] = {}

    # Standard Cards
    for rank_out, rank_in in RANKS.items():
        for suit_out, suit_in in SUITS.items():
            filename = f"{rank_out}{suit_out}.svg"
            card_id = f"{suit_in}_{rank_in}"
            targets[filename] = card_id

    # Special Cards
    for filename, card_id in SPECIALS.items():
        targets[f"{filename}.svg"] = card_id

    print(f"Extracting {len(targets)} cards to '{OUTPUT_DIR}'...")

    # 5. Process each card
    for filename, target_id in targets.items():
        save_isolated_card(root, filename, target_id)

    print("\nDone!")


def save_isolated_card(original_root: ET.Element, filename: str, target_id: str) -> None:
    """
    Creates a new SVG containing ONLY the global defs/styles and the target card.
    """
    svg_ns = "http://www.w3.org/2000/svg"
    defs = original_root.find(f"{{{svg_ns}}}defs")
    if defs is None:
        print("  [ERROR] No <defs> section found in SVG.")
        return

    defs_copy = copy.deepcopy(defs)
    target_copy = None

    # Locate the target anywhere inside defs (cards live there in this source SVG)
    for child in defs_copy.iter():
        if child.attrib.get("id") == target_id:
            target_copy = copy.deepcopy(child)
            target_copy.attrib.pop("display", None)
            break

    # Build a new root with the same attributes (width, height, viewBox, etc.)
    new_root = ET.Element(original_root.tag, original_root.attrib)
    new_root.append(defs_copy)
    found_target = False

    if target_copy is not None:
        # Place the card outside <defs> so it renders directly.
        new_root.append(target_copy)
        found_target = True

    if found_target:
        out_path = OUTPUT_DIR / filename
        new_tree = ET.ElementTree(new_root)
        new_tree.write(out_path, encoding="utf-8", xml_declaration=True)
        print(f"  Saved {filename}")
    else:
        print(f"  [ERROR] ID '{target_id}' not found in SVG.")


if __name__ == "__main__":
    main()
