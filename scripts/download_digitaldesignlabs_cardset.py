import os
import urllib.request
import xml.etree.ElementTree as ET
import copy

# --- Configuration ---
BASE_URL = "https://raw.githubusercontent.com/digitaldesignlabs/responsive-playing-cards/main/minified/"
OUTPUT_DIR = "digitaldesignlabs"

# Size Mapping: Identifier (id or class) -> Output Folder Name
SIZES = {
    # ID-based (Standard DDL format)
    "x-large": "xl",
    "large": "lg",
    "medium": "md",
    "small": "sm",
    "x-small": "xs",
    
    # Class-based (Optimized DDL format)
    "maxi-card": "xl",
    "mini-card": "sm"
}

# Namespaces
NS = {'svg': 'http://www.w3.org/2000/svg', 'xlink': 'http://www.w3.org/1999/xlink'}
ET.register_namespace("", "http://www.w3.org/2000/svg")
ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")

# --- Mappings ---
SUIT_MAP = {'s': 'spades', 'h': 'hearts', 'd': 'diamonds', 'c': 'clubs'}
RANKS = {
    '1': 'A', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '10': 'T',
    'j': 'J', 'q': 'Q', 'k': 'K'
}

# Skipping specials as they are missing in the source
SPECIALS = {}

def get_target_filename(suit_char, rank_id):
    if suit_char in SUIT_MAP and rank_id in RANKS:
        return f"{RANKS[rank_id]}{suit_char.upper()}.svg"
    return None

def safe_urlopen(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        raise ValueError(f"Insecure URL scheme: {parsed.scheme}")
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    return urllib.request.urlopen(url)

def download_svg_text(url):
    try:
        with safe_urlopen(url) as response:
            return response.read().decode('utf-8')
    except Exception as e:
        print(f"Failed to download {url}: {e}")
        return None

def process_and_save(svg_text, target_filename):
    try:
        root = ET.fromstring(svg_text)
    except ET.ParseError as e:
        print(f"XML Error: {e}")
        return

    viewBox = root.get('viewBox')
    if not viewBox: return
    _, _, width, height = map(float, viewBox.split())
    
    radius = round(width * 0.05, 2)
    stroke_width = 2

    # Identify available variants in this file
    available_groups = {}
    
    # Find groups by ID or Class
    for child in root.iter():
        if child.tag.endswith('g'):
            # Check ID
            gid = child.get('id')
            if gid in SIZES:
                available_groups[gid] = child
                continue
            
            # Check Class
            cls = child.get('class')
            if cls in SIZES:
                available_groups[cls] = child

    # If no recognized groups found, save root to 'xl' as fallback
    if not available_groups:
        save_variant(root, "xl", target_filename, width, height, radius, stroke_width)
        return

    # Process found variants
    for identifier, group_node in available_groups.items():
        subfolder = SIZES[identifier]
        
        # Create clean root
        new_root = copy.deepcopy(root)
        new_root.clear() # Remove all children
        new_root.attrib = root.attrib # Keep attributes
        
        # Copy Defs (needed for <use>)
        for child in root:
            if child.tag.endswith('defs'):
                new_root.append(copy.deepcopy(child))
                break
        
        # 1. Clean style tags recursively from the entire new tree (including defs)
        #    This ensures media queries don't hide our extracted group.
        for parent in new_root.iter():
            for child in list(parent):
                if child.tag.endswith('style'):
                    parent.remove(child)

        # 2. Add the specific group
        variant_group = copy.deepcopy(group_node)
        
        # Force visibility by removing potential inline styles or attributes
        if 'style' in variant_group.attrib: del variant_group.attrib['style']
        if 'display' in variant_group.attrib: del variant_group.attrib['display']
        
        new_root.append(variant_group)
        
        # 3. Save
        save_variant(new_root, subfolder, target_filename, width, height, radius, stroke_width)

def save_variant(root_node, subfolder, filename, w, h, r, s_width):
    # Add Background (White fill) with same rounded corners as border
    background = ET.Element('rect', {
        'x': str(s_width / 2),
        'y': str(s_width / 2),
        'width': str(w - s_width),
        'height': str(h - s_width),
        'rx': str(r), 'ry': str(r),
        'fill': '#fefefe'
    })
    root_node.insert(0, background)  # Insert at beginning to be behind content
    
    # Add Border (on top of background)
    border = ET.Element('rect', {
        'x': str(s_width / 2),
        'y': str(s_width / 2),
        'width': str(w - s_width),
        'height': str(h - s_width),
        'rx': str(r), 'ry': str(r),
        'fill': 'none',
        'stroke': 'black',
        'stroke-width': str(s_width)
    })
    root_node.append(border)

    target_dir = os.path.join(OUTPUT_DIR, subfolder)
    if not os.path.exists(target_dir): os.makedirs(target_dir)
    
    output_path = os.path.join(target_dir, filename)
    tree = ET.ElementTree(root_node)
    tree.write(output_path, encoding='utf-8', xml_declaration=False)

def main():
    if not os.path.exists(OUTPUT_DIR): os.makedirs(OUTPUT_DIR)
    print("Processing DigitalDesignLabs...")

    ddl_ranks = [str(i) for i in range(1, 11)] + ['j', 'q', 'k']
    
    for suit_char, folder_name in SUIT_MAP.items():
        for rank_id in ddl_ranks:
            src = f"{rank_id}{suit_char}.svg"
            url = f"{BASE_URL}{folder_name}/{src}"
            tgt = get_target_filename(suit_char, rank_id)
            
            print(f"DL: {folder_name}/{src} -> {tgt}...", end="", flush=True)
            txt = download_svg_text(url)
            if txt:
                process_and_save(txt, tgt)
                print(" OK")
            else:
                print(" Fail")

    print("\nExtraction complete.")

if __name__ == "__main__":
    main()
