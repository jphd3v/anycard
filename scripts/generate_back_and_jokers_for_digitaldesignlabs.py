import os
import urllib.request
import xml.etree.ElementTree as ET
import copy
import re

# --- Configuration ---
OUTPUT_DIR = "digitaldesignlabs"

# DigitalDesignLabs Dimensions (must match exact card dimensions)
TARGET_WIDTH = 225
TARGET_HEIGHT = 314
BORDER_RADIUS = 11.25
STROKE_WIDTH = 2
JOKER_VERTICAL_PADDING = 16.0  # px, applied to downloaded (XL) jokers only

# Namespaces
NS_SVG = "http://www.w3.org/2000/svg"
NS_XLINK = "http://www.w3.org/1999/xlink"

# Register namespaces to prevent "ns0:" prefixes and handle xmlns automatically
ET.register_namespace("", NS_SVG)
ET.register_namespace("xlink", NS_XLINK)

def svg_tag(local_name):
    return f"{{{NS_SVG}}}{local_name}"

def svg_el(local_name, attrib=None):
    return ET.Element(svg_tag(local_name), attrib or {})

# --- Source Definitions ---
URLS = {
    # XL Assets (High Quality)
    "xl": {
        "1B.svg": "https://upload.wikimedia.org/wikipedia/commons/d/d4/Card_back_01.svg",
        "1J.svg": "https://upload.wikimedia.org/wikipedia/commons/8/82/Joker_red_02.svg",
        "2J.svg": "https://upload.wikimedia.org/wikipedia/commons/d/d0/Joker_black_02.svg"
    },
    # SM Assets (Back only, Jokers are generated)
    "sm": {
        "1B.svg": "https://upload.wikimedia.org/wikipedia/commons/d/d4/Card_back_01.svg",
    }
}

# Apply XL assets to root folder as well
# (disabled) we only emit files under sm/ and xl/

def safe_urlopen(url_or_req):
    url = url_or_req.get_full_url() if isinstance(url_or_req, urllib.request.Request) else url_or_req
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        raise ValueError(f"Insecure URL scheme: {parsed.scheme}")
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    return urllib.request.urlopen(url_or_req)

def download_svg_content(url):
    """Downloads content with a proper User-Agent."""
    try:
        print(f"Downloading {url}...")
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with safe_urlopen(req) as response:
            return response.read().decode('utf-8')
    except Exception as e:
        print(f"Error downloading {url}: {e}")
        return None

def get_viewbox(root):
    """
    Extracts (min_x, min_y, width, height) from viewBox or width/height.
    Many Wikimedia SVGs are not 0,0 anchored, so we must respect min_x/min_y.
    """
    vb = root.get("viewBox")
    if vb:
        parts = re.split(r"[,\s]+", vb.strip())
        if len(parts) == 4:
            return float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])

    w_str = root.get("width", "")
    h_str = root.get("height", "")

    def parse_unit(val):
        if not val:
            return 0.0
        clean = re.sub(r"[^\d.]", "", val)
        try:
            return float(clean)
        except Exception:
            return 0.0

    w = parse_unit(w_str)
    h = parse_unit(h_str)
    if w > 0 and h > 0:
        return 0.0, 0.0, w, h

    return 0.0, 0.0, 200.0, 300.0  # Fallback

def create_container_svg():
    """
    Creates the standard DDL card container.
    IMPORTANT: Do NOT manually add xmlns attributes here; register_namespace handles it.
    """
    return svg_el('svg', {
        'width': str(TARGET_WIDTH),
        'height': str(TARGET_HEIGHT),
        'viewBox': f"0 0 {TARGET_WIDTH} {TARGET_HEIGHT}"
    })

def inner_rect():
    """Returns the card interior rect (inside the stroke)."""
    inset = STROKE_WIDTH / 2
    return inset, inset, TARGET_WIDTH - STROKE_WIDTH, TARGET_HEIGHT - STROKE_WIDTH

def ensure_defs(root):
    """Ensures a <defs> exists and returns it."""
    for child in root:
        if child.tag.endswith("defs"):
            return child
    defs = svg_el("defs")
    root.insert(0, defs)
    return defs

def add_background(root, fill="#fefefe"):
    """Adds the standard rounded background fill (prevents corner bleed)."""
    x, y, w, h = inner_rect()
    bg = svg_el("rect", {
        "x": str(x),
        "y": str(y),
        "width": str(w),
        "height": str(h),
        "rx": str(BORDER_RADIUS),
        "ry": str(BORDER_RADIUS),
        "fill": fill,
    })
    root.insert(0, bg)

def add_clip_path(root, clip_id="card-clip"):
    """Adds a rounded-rect clipPath for the card interior and returns clip_id."""
    defs = ensure_defs(root)
    # Avoid duplicates if called multiple times
    for cp in defs:
        if cp.tag.endswith("clipPath") and cp.get("id") == clip_id:
            return clip_id

    x, y, w, h = inner_rect()
    cp = ET.SubElement(defs, svg_tag("clipPath"), {"id": clip_id})
    ET.SubElement(cp, svg_tag("rect"), {
        "x": str(x),
        "y": str(y),
        "width": str(w),
        "height": str(h),
        "rx": str(BORDER_RADIUS),
        "ry": str(BORDER_RADIUS),
    })
    return clip_id

def add_border(root):
    """Adds the standard border rect (must match exact DDL dimensions)."""
    rect = svg_el('rect', {
        'x': "1.0",
        'y': "1.0",
        'width': "223.0",
        'height': "312.0",
        'rx': "11.25",
        'ry': "11.25",
        'fill': 'none',
        'stroke': 'black',
        'stroke-width': "2"
    })
    root.append(rect)

def is_back_filename(filename):
    # DDL conventions: 1B.svg is the card back.
    return filename.upper().endswith("B.SVG")

def is_joker_filename(filename):
    # DDL conventions: 1J.svg and 2J.svg are jokers.
    return filename.upper().endswith("J.SVG")

def process_downloaded_svg(content, filename, target_dir, mode="contain"):
    """Wraps downloaded SVG content to fit the DDL card interior and clips corners."""
    try:
        # Strip XML declaration
        if content.strip().startswith('<?xml'):
            content = content.split('?>', 1)[1]
            
        src_root = ET.fromstring(content)
    except ET.ParseError as e:
        print(f"XML Error in {filename}: {e}")
        return

    src_min_x, src_min_y, src_w, src_h = get_viewbox(src_root)

    # Scale to the DDL interior rect (inside the border stroke).
    dst_x, dst_y, dst_w, dst_h = inner_rect()
    if is_joker_filename(filename):
        # Add some breathing room top/bottom (like the DDL feel), while we still
        # crop away the source SVG's own border via mode/overscale.
        dst_y += JOKER_VERTICAL_PADDING
        dst_h -= JOKER_VERTICAL_PADDING * 2
    scale_w = dst_w / src_w
    scale_h = dst_h / src_h

    if mode == "cover":
        scale = max(scale_w, scale_h)
    else:
        scale = min(scale_w, scale_h)

    scale_x = scale
    scale_y = scale

    # The Wikimedia back/joker SVGs include their own card framing/border.
    # We overscale slightly and rely on rounded clipping to crop it away.
    if is_back_filename(filename):
        # The remaining artifact is mostly on the left/right; overscale a bit more
        # in X than Y so we crop that away without shrinking the top/bottom margin.
        scale_x *= 1.035
        scale_y *= 1.02
    elif is_joker_filename(filename):
        scale_x *= 1.01
        scale_y *= 1.01

    # Center content inside the interior rect and compensate for non-zero viewBox origin.
    tx = dst_x + (dst_w - (src_w * scale_x)) / 2 - (src_min_x * scale_x)
    ty = dst_y + (dst_h - (src_h * scale_y)) / 2 - (src_min_y * scale_y)
    if scale_x == scale_y:
        transform = f"translate({tx} {ty}) scale({scale_x})"
    else:
        transform = f"translate({tx} {ty}) scale({scale_x} {scale_y})"
     
    new_root = create_container_svg()

    add_background(new_root)
    clip_id = add_clip_path(new_root)

    clipped = svg_el("g", {"clip-path": f"url(#{clip_id})"})
    wrapper = svg_el("g", {"transform": transform})

    # Move children. 
    # NOTE: We do not strip namespaces from children; ET handles that via register_namespace.
    for child in list(src_root):
        wrapper.append(child)
    
    clipped.append(wrapper)
    new_root.append(clipped)
    add_border(new_root)

    if not os.path.exists(target_dir):
        os.makedirs(target_dir)
    
    out_path = os.path.join(target_dir, filename)
    ET.ElementTree(new_root).write(out_path, encoding='utf-8', xml_declaration=False)
    print(f" -> Saved {out_path}")

def generate_simple_joker(color, filename, target_dir):
    """Generates a text-based Joker with correct centering and font."""
    root = create_container_svg()
    
    add_background(root)
    clip_id = add_clip_path(root)
    clipped = svg_el("g", {"clip-path": f"url(#{clip_id})"})
    
    fill = "#d40000" if color == "red" else "#000000"
    
    letters = ["J", "O", "K", "E", "R"]
    
    # Typography settings
    # Match the bold, oversized feel of the DDL SM cards.
    font_size = 56
    letter_spacing = 56
    x_scale = 1.18
    y_offset = 6.0

    # Vertical centering: each letter is anchored at its visual middle.
    _, inner_y, _, inner_h = inner_rect()
    center_y = inner_y + (inner_h / 2)
    start_y = center_y - ((len(letters) - 1) * letter_spacing / 2) + y_offset

    # Widen the typography a bit around the card centerline.
    cx = TARGET_WIDTH / 2
    stretched = svg_el("g", {
        "transform": f"translate({cx} 0) scale({x_scale} 1) translate({-cx} 0)"
    })
    
    for i, char in enumerate(letters):
        text = svg_el('text', {
            'x': str(TARGET_WIDTH / 2),
            'y': str(start_y + (i * letter_spacing)),
            'font-family': 'Times New Roman, serif', # Better looking font
            # Use stroke-based emboldening for consistent "heavier" rendering across
            # environments (font-weight is not reliably honored for system fonts).
            'font-weight': 'bold',
            'font-size': str(font_size),
            'fill': fill,
            'stroke': fill,
            'stroke-width': "1.2",
            'paint-order': "stroke fill",
            'text-anchor': 'middle',
            'dominant-baseline': 'middle'
        })
        text.text = char
        stretched.append(text)

    clipped.append(stretched)
    root.append(clipped)

    add_border(root)
    
    if not os.path.exists(target_dir):
        os.makedirs(target_dir)
        
    out_path = os.path.join(target_dir, filename)
    ET.ElementTree(root).write(out_path, encoding='utf-8', xml_declaration=False)
    print(f" -> Generated {out_path}")

def main():
    print("Processing DigitalDesignLabs Extras...")

    # 1. Process Downloads (XL, Root, SM Backs)
    for folder_key, file_map in URLS.items():
        target_dir = os.path.join(OUTPUT_DIR, folder_key)
        
        for filename, url in file_map.items():
            content = download_svg_content(url)
            if content:
                # These Wikimedia sources are already "a whole card"; fit them into the
                # DDL card interior (no extra padding), and rely on rounded clipping.
                #
                # For jokers, crop away the Wikimedia card border.
                # For backs, keep the intended white margin framing.
                mode = "cover" if is_joker_filename(filename) else "contain"
                process_downloaded_svg(content, filename, target_dir, mode)

    # 2. Generate SM Jokers
    sm_dir = os.path.join(OUTPUT_DIR, "sm")
    generate_simple_joker("red", "1J.svg", sm_dir)
    generate_simple_joker("black", "2J.svg", sm_dir)

    print("Done.")

if __name__ == "__main__":
    main()
