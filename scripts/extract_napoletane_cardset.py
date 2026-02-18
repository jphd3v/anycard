import os
import xml.etree.ElementTree as ET
import defusedxml.ElementTree as DET
import copy
import re
from pathlib import Path

# --- Configuration ---
SCRIPT_DIR = Path(__file__).parent
INPUT_FILE = SCRIPT_DIR / "napoletane.svg"
OUTPUT_DIR = SCRIPT_DIR / "napoletane"


# Mappings
SUITS = {
    "C": "club",
    "D": "diamond",
    "H": "heart",
    "S": "spade",
}

RANKS = {
    "A": "1",
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
    "1B": "back",
    "1J": "joker1-9",
}

# Namespaces
NS = {
    "svg": "http://www.w3.org/2000/svg",
    "xlink": "http://www.w3.org/1999/xlink",
    "inkscape": "http://www.inkscape.org/namespaces/inkscape",
    "sodipodi": "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
}

for prefix, uri in NS.items():
    ET.register_namespace(prefix if prefix != "svg" else "", uri)

def strip_ns_attributes(element):
    """Recursively remove non-svg/xlink attributes."""
    # We only keep standard SVG and XLINK attributes for cleaner files
    allowed_uris = {NS["svg"], NS["xlink"]}
    
    # Attributes
    for attr in list(element.attrib.keys()):
        if attr.startswith("{"):
            uri = attr[1:].split("}")[0]
            if uri not in allowed_uris:
                del element.attrib[attr]
    
    # Children
    for child in element:
        strip_ns_attributes(child)

def parse_transform(transform_str):
    """Parses matrix(a,b,c,d,e,f) or scale(x,y) or translate(x,y) into a matrix."""
    matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
    if not transform_str:
        return matrix
    
    # Handle multiple transforms (e.g. translate() scale())
    # For simplicity, we assume they are simple or single.
    
    # Matrix
    match = re.search(r"matrix\(([^)]+)\)", transform_str)
    if match:
        vals = [float(x) for x in re.split(r"[,\s]+", match.group(1).strip())]
        if len(vals) == 6:
            return vals

    # Scale
    match = re.search(r"scale\(([^)]+)\)", transform_str)
    if match:
        vals = [float(x) for x in re.split(r"[,\s]+", match.group(1).strip())]
        if len(vals) == 1:
            matrix[0] = matrix[3] = vals[0]
        elif len(vals) == 2:
            matrix[0] = vals[0]
            matrix[3] = vals[1]
        return matrix

    # Translate
    match = re.search(r"translate\(([^)]+)\)", transform_str)
    if match:
        vals = [float(x) for x in re.split(r"[,\s]+", match.group(1).strip())]
        if len(vals) >= 1:
            matrix[4] = vals[0]
        if len(vals) >= 2:
            matrix[5] = vals[1]
        return matrix

    return matrix

def apply_matrix(matrix, x, y):
    a, b, c, d, e, f = matrix
    return a * x + c * y + e, b * x + d * y + f

def main():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)

    # 1. Process Napoletane cards
    print(f"Parsing {INPUT_FILE}...")
    tree = DET.parse(INPUT_FILE)
    root = tree.getroot()

    all_groups = root.findall(".//{http://www.w3.org/2000/svg}g[@id]")
    groups_by_id = {g.get("id"): g for g in all_groups}

    targets = {}
    for rank_code, rank_id in RANKS.items():
        for suit_code, suit_id in SUITS.items():
            filename = f"{rank_code}{suit_code}.svg"
            target_id = f"{rank_id}_{suit_id}"
            targets[filename] = target_id

    for filename, target_id in SPECIALS.items():
        if filename != "1J": # We'll get jokers from NewItaly.svg
            targets[f"{filename}.svg"] = target_id

    print(f"Extracting {len(targets)} Napoletane cards...")

    dims = None
    for filename, target_id in targets.items():
        res = extract_and_save(groups_by_id, target_id, filename)
        if res and not dims:
            dims = res

    # 2. Process Jokers from NewItaly.svg
    NEW_ITALY_FILE = SCRIPT_DIR / "NewItaly.svg"
    if NEW_ITALY_FILE.exists():
        print(f"Parsing {NEW_ITALY_FILE} for Jokers...")
        tree_ni = DET.parse(NEW_ITALY_FILE)
        root_ni = tree_ni.getroot()
        all_groups_ni = root_ni.findall(".//{http://www.w3.org/2000/svg}g[@id]")
        groups_by_id_ni = {g.get("id"): g for g in all_groups_ni}
        
        joker_targets = {
            "1J.svg": "red_joker",
            "2J.svg": "black_joker"
        }
        
        for filename, target_id in joker_targets.items():
            extract_and_save(groups_by_id_ni, target_id, filename, 
                             target_width=dims[0] if dims else None, 
                             target_height=dims[1] if dims else None)
    else:
        print(f"  [WARNING] {NEW_ITALY_FILE} not found. Skipping Jokers.")

    print(f"\nDone! Extracted files are in '{OUTPUT_DIR}/'.")

def extract_and_save(groups_dict, target_id, filename, target_width=None, target_height=None):
    if target_id not in groups_dict:
        print(f"  [WARNING] ID '{target_id}' not found. Skipping {filename}.")
        return None

    group = groups_dict[target_id]
    rect = group.find(".//{http://www.w3.org/2000/svg}rect")
    if rect is None:
        print(f"  [ERROR] No rect found in {target_id}. Skipping.")
        return None

    # Bounding box calculation
    # 1. Rect local coordinates
    rx = float(rect.get("x", 0))
    ry = float(rect.get("y", 0))
    rw = float(rect.get("width", 0))
    rh = float(rect.get("height", 0))
    rt = parse_transform(rect.get("transform", ""))

    # 2. Rect to Group coordinates (apply rect transform)
    x1, y1 = apply_matrix(rt, rx, ry)
    x2, y2 = apply_matrix(rt, rx + rw, ry + rh)
    
    # Normalize corners
    xmin, xmax = min(x1, x2), max(x1, x2)
    ymin, ymax = min(y1, y2), max(y1, y2)
    
    # 3. Group to SVG coordinates (apply group transform)
    gt = parse_transform(group.get("transform", ""))
    
    c1x, c1y = apply_matrix(gt, xmin, ymin)
    c2x, c2y = apply_matrix(gt, xmax, ymax)
    
    f_xmin, f_xmax = min(c1x, c2x), max(c1x, c2x)
    f_ymin, f_ymax = min(c1y, c2y), max(c1y, c2y)
    f_width = f_xmax - f_xmin
    f_height = f_ymax - f_ymin

    # Create new SVG root without manual xmlns attributes
    out_width = target_width if target_width is not None else f_width
    out_height = target_height if target_height is not None else f_height

    new_root = ET.Element("svg", {
        "viewBox": f"{f_xmin:.2f} {f_ymin:.2f} {f_width:.2f} {f_height:.2f}",
        "width": f"{out_width:.2f}",
        "height": f"{out_height:.2f}",
        "preserveAspectRatio": "none" if (target_width is not None or target_height is not None) else "xMidYMid meet"
    })
    
    new_group = copy.deepcopy(group)
    # Remove inkscape/sodipodi attributes from the group to keep it clean
    strip_ns_attributes(new_group)

    # Adjust border stroke-width for target dimensions (Jokers)
    if target_width is not None or target_height is not None:
        # Find the border rect in the NEW group
        border_rect = new_group.find(".//{http://www.w3.org/2000/svg}rect")
        if border_rect is not None:
            style = border_rect.get("style", "")
            # We want to set stroke-width to something close to 1.25 (from napoletane cards)
            # However, the Joker SVG might have a different base coordinate system.
            # Looking at AC.svg, the stroke-width is 1.25415492.
            # In 1J.svg, it was 1.39999998 but it looked much heavier.
            # This is likely because 1J.svg is smaller and then scaled up by preserveAspectRatio.
            # Let's try to reduce it significantly.
            if "stroke-width:" in style:
                new_style = re.sub(r"stroke-width:[^;]+", "stroke-width:0.8", style)
                border_rect.set("style", new_style)
            else:
                border_rect.set("stroke-width", "0.8")

    new_root.append(new_group)
    
    out_path = Path(OUTPUT_DIR) / filename
    tree = ET.ElementTree(new_root)
    # Note: ET.write handles namespaces automatically based on registered prefixes.
    tree.write(out_path, encoding="utf-8", xml_declaration=True)
    print(f"  Saved {filename} ({int(out_width)}x{int(out_height)})")
    return out_width, out_height

if __name__ == "__main__":
    main()

