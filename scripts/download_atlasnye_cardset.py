import os
import urllib.request
import urllib.parse
import re
import time

# --- Configuration ---
CATEGORY_URL = "https://commons.wikimedia.org/wiki/Category:SVG_Atlasnye_playing_cards"
OUTPUT_DIR = "atlasnye"

# --- Mapping Rules ---
# We map keywords found in filenames to the single-letter codes
SUITS_REGEX = {
    'H': r'(heart|chervi|worm)',    # English, Russian (Chervi), slang
    'D': r'(diamond|bubn)',         # English, Russian (Bubny)
    'C': r'(club|tref)',            # English, Russian (Trefy)
    'S': r'(spade|pik)'             # English, Russian (Piki)
}

RANKS_REGEX = {
    'A': r'(ace|tuz|1\b)',          # 1 is sometimes Ace in filenames
    'K': r'(king|korol)',
    'Q': r'(queen|dama)',
    'J': r'(jack|knave|valet)',
    'T': r'(10)',
    '9': r'(9)',
    '8': r'(8)',
    '7': r'(7)',
    '6': r'(6)',
    '5': r'(5)',
    '4': r'(4)',
    '3': r'(3)',
    '2': r'(2)'
}

# Counters to handle the "2 backs" request
back_counter = 0
joker_counter = 0

def safe_urlopen(url_or_req):
    url = url_or_req.get_full_url() if isinstance(url_or_req, urllib.request.Request) else url_or_req
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        raise ValueError(f"Insecure URL scheme: {parsed.scheme}")
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    return urllib.request.urlopen(url_or_req)

def get_html(url):
    req = urllib.request.Request(
        url, 
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    )
    with safe_urlopen(req) as response:
        return response.read().decode('utf-8')

def download_file(file_page_part, output_name):
    """
    Takes a partial URL (e.g., /wiki/File:Name.svg), finds the upload link, and downloads.
    """
    full_page_url = f"https://commons.wikimedia.org{file_page_part}"
    print(f"Processing {output_name}...", end=" ")
    
    try:
        html = get_html(full_page_url)
        # Find the real upload URL
        match = re.search(r'href="(https://upload\.wikimedia\.org/wikipedia/commons/[^"]+\.svg)"', html)
        
        if match:
            raw_url = match.group(1)
            output_path = os.path.join(OUTPUT_DIR, output_name)
            
            # Download
            req = urllib.request.Request(raw_url, headers={'User-Agent': 'Mozilla/5.0'})
            with safe_urlopen(req) as response:
                with open(output_path, 'wb') as f:
                    f.write(response.read())
            print("OK")
            return True
        else:
            print("Skipped (No SVG source link found)")
            return False
    except Exception as e:
        print(f"Error: {e}")
        return False

def parse_filename(filename):
    """
    Analyzes the filename to determine the target name (e.g., KH.svg).
    Returns (TargetFilename, Priority). Priority helps filter 'generic' vs 'specific' files.
    """
    global back_counter, joker_counter
    
    name = filename.lower()
    name = urllib.parse.unquote(name) # Convert %20 to space

    # 1. Check for Backs
    # "rubashka" is Russian for "shirt/back" often used in these filenames
    if "back" in name or "rubashka" in name or "dorso" in name:
        if back_counter < 2:
            back_counter += 1
            return f"{back_counter}B.svg"
        return None # Ignore extra backs

    # 2. Check for Jokers
    if "joker" in name or "jolly" in name:
        joker_counter += 1
        # Map: 1J = Red, 2J = Black is standard, but we'll just number them sequentially
        return f"{joker_counter}J.svg"

    # 3. Detect Suit
    found_suit = None
    for code, pattern in SUITS_REGEX.items():
        if re.search(pattern, name):
            found_suit = code
            break
    
    # 4. Detect Rank
    found_rank = None
    for code, pattern in RANKS_REGEX.items():
        # strict boundary check \b is implied by the regex list above mostly, 
        # but we need to ensure "10" matches 10 but not "100".
        # We search for the number surrounded by non-digits
        if code in ['T', '9', '8', '7', '6', '5', '4', '3', '2']:
            # Search for the specific number (e.g., '10') not part of another number
            # Using simple check: is the number in the string?
            if re.search(pattern, name):
                found_rank = code
                break
        else:
            # Words (King, Queen)
            if re.search(pattern, name):
                found_rank = code
                break

    if found_suit and found_rank:
        return f"{found_rank}{found_suit}.svg"

    return None

def main():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)

    print(f"Scanning category: {CATEGORY_URL}")
    html = get_html(CATEGORY_URL)

    # Find all file links
    # Pattern: href="/wiki/File:Something.svg"
    file_links = re.findall(r'href="(/wiki/File:[^"]+\.svg)"', html)
    
    # Deduplicate
    file_links = sorted(list(set(file_links)))
    
    print(f"Found {len(file_links)} potential SVG files.")

    processed_files = set()

    for link in file_links:
        # Extract just the filename part for parsing
        # link looks like "/wiki/File:Atlas_deck_King_of_Hearts.svg"
        filename = link.split("File:")[-1]
        
        target_name = parse_filename(filename)
        
        if target_name:
            if target_name in processed_files:
                continue # Skip duplicate detections (e.g. if category lists multiple versions)
            
            success = download_file(link, target_name)
            if success:
                processed_files.add(target_name)
                # Polite delay
                time.sleep(0.3)
        else:
            # Uncomment to debug why a file was skipped
            # print(f"Ignored: {filename}")
            pass

    print("\n------------------------------------------------")
    print(f"Download Complete. Files saved to '{OUTPUT_DIR}'")
    print(f"Cards collected: {len(processed_files)}")
    print("------------------------------------------------")

if __name__ == "__main__":
    main()